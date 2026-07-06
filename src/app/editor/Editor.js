"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { FileText, LogOut, Plus, ArrowLeft, ExternalLink, ImagePlus } from "lucide-react";

/*
  Editor mode: writes posts straight to the GitHub repo via the contents
  API using a fine-grained personal access token (contents read/write on
  this repo only). Saving commits to main; Vercel redeploys in ~1 min.
  The token never leaves this browser (localStorage).
*/

const REPO = "chesterchong/chester-site";
const BRANCH = "main";
const DIR = "src/app/writing";

const b64decode = (b64) =>
  new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\n/g, "")), (c) => c.charCodeAt(0)));
const b64encode = (text) => {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin);
};

const esc = (s) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
const unesc = (s) => s.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
const slugify = (s) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
const today = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())}-${d.getFullYear()}`;
};

function buildFile({ title, date, tags, description, body }) {
  const tagList = tags
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => `"${esc(t)}"`)
    .join(", ");
  return `import MdxLayout from "@/app/layouts/MdxLayout";

# ${title}

${body.trim()}

export const meta = {
  title: "${esc(title)}",
  date: "${date}",
  tags: [${tagList}],
  description: "${esc(description)}",
};

export default function MDXPage({ children }) {
  return <MdxLayout>{children}</MdxLayout>;
}
`;
}

function parseFile(text) {
  if (!text.includes("import MdxLayout") || !text.includes("export const meta")) return null;
  const heading = text.match(/^# (.*)$/m);
  const metaStart = text.indexOf("export const meta");
  if (!heading || metaStart < 0) return null;
  const bodyStart = text.indexOf(heading[0]) + heading[0].length;
  const body = text.slice(bodyStart, metaStart).trim();
  const metaBlock = text.slice(metaStart);
  const field = (name) => {
    const m = metaBlock.match(new RegExp(`${name}:\\s*"((?:[^"\\\\]|\\\\.)*)"`));
    return m ? unesc(m[1]) : "";
  };
  const tagsMatch = metaBlock.match(/tags:\s*\[([^\]]*)\]/);
  const tags = tagsMatch
    ? tagsMatch[1]
        .split(",")
        .map((t) => t.trim().replace(/^"|"$/g, ""))
        .filter(Boolean)
        .join(", ")
    : "";
  return { title: field("title") || heading[1], date: field("date"), tags, description: field("description"), body };
}

const inputCls =
  "w-full py-2 px-3 border border-stone-400/60 dark:border-stone-600/60 rounded-md bg-white/25 dark:bg-white/[0.06] backdrop-blur-[2px] text-stone-800 dark:text-stone-200 focus:outline-none focus:border-stone-600 dark:focus:border-stone-400 text-sm";
const btnCls =
  "py-2 px-4 rounded-md border border-stone-500/50 dark:border-stone-600/60 bg-white/25 dark:bg-white/[0.06] backdrop-blur-[2px] text-stone-700 dark:text-stone-300 hover:bg-white/40 dark:hover:bg-white/10 transition-colors text-sm inline-flex items-center gap-2";

export default function Editor() {
  const [token, setToken] = useState(null);
  const [tokenInput, setTokenInput] = useState("");
  const [posts, setPosts] = useState(null);
  const [view, setView] = useState("list"); // list | edit
  const [form, setForm] = useState(null); // { slug, sha, isNew, raw?, title, date, tags, description, body }
  const [status, setStatus] = useState("");
  const bodyRef = useRef(null);
  const fileRef = useRef(null);

  useEffect(() => {
    setToken(localStorage.getItem("editor-token"));
  }, []);

  const gh = useCallback(
    async (path, opts = {}) => {
      const res = await fetch(`https://api.github.com/repos/${REPO}${path}`, {
        ...opts,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          ...(opts.headers || {}),
        },
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => ({}));
        throw new Error(`${res.status} ${detail.message || res.statusText}`);
      }
      return res.json();
    },
    [token]
  );

  const loadPosts = useCallback(async () => {
    try {
      const entries = await gh(`/contents/${DIR}?ref=${BRANCH}`);
      setPosts(entries.filter((e) => e.type === "dir").map((e) => e.name));
      setStatus("");
    } catch (e) {
      setStatus(`could not load posts: ${e.message}`);
      if (String(e.message).startsWith("401")) {
        localStorage.removeItem("editor-token");
        setToken(null);
      }
    }
  }, [gh]);

  useEffect(() => {
    if (token) loadPosts();
  }, [token, loadPosts]);

  const openPost = async (slug) => {
    setStatus("loading…");
    try {
      const file = await gh(`/contents/${DIR}/${slug}/page.mdx?ref=${BRANCH}`);
      const text = b64decode(file.content);
      const parsed = parseFile(text);
      setForm(
        parsed
          ? { slug, sha: file.sha, isNew: false, ...parsed }
          : { slug, sha: file.sha, isNew: false, raw: text }
      );
      setView("edit");
      setStatus("");
    } catch (e) {
      setStatus(`could not open ${slug}: ${e.message}`);
    }
  };

  const newPost = () => {
    setForm({ slug: "", sha: null, isNew: true, title: "", date: today(), tags: "", description: "", body: "" });
    setView("edit");
    setStatus("");
  };

  const save = async () => {
    const slug = form.isNew ? slugify(form.slug || form.title) : form.slug;
    if (!slug) {
      setStatus("needs a title or slug first");
      return;
    }
    const content = form.raw !== undefined ? form.raw : buildFile(form);
    setStatus("saving…");
    try {
      const res = await gh(`/contents/${DIR}/${slug}/page.mdx`, {
        method: "PUT",
        body: JSON.stringify({
          message: `${form.isNew ? "Add" : "Edit"} post: ${form.title || slug}`,
          content: b64encode(content),
          branch: BRANCH,
          ...(form.sha ? { sha: form.sha } : {}),
        }),
      });
      setForm((f) => ({ ...f, slug, sha: res.content.sha, isNew: false }));
      setStatus("saved — Vercel is deploying, live in ~1 min");
      loadPosts();
    } catch (e) {
      setStatus(`save failed: ${e.message}`);
    }
  };

  const uploadImage = async (file) => {
    const slug = form.isNew ? slugify(form.slug || form.title) : form.slug;
    if (!slug) {
      setStatus("give the post a title first, then upload images");
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      setStatus("image too large (8 MB max) — resize it first");
      return;
    }
    setStatus("uploading image…");
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let bin = "";
      const CHUNK = 0x8000;
      for (let i = 0; i < bytes.length; i += CHUNK) {
        bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
      }
      const clean = file.name.toLowerCase().replace(/[^a-z0-9.]+/g, "-");
      const name = `${Date.now().toString(36)}-${clean}`;
      const path = `public/images/writing/${slug}/${name}`;
      await gh(`/contents/${path}`, {
        method: "PUT",
        body: JSON.stringify({
          message: `Add image for post: ${slug}`,
          content: btoa(bin),
          branch: BRANCH,
        }),
      });
      const md = `\n![${file.name.replace(/\.[^.]*$/, "")}](/images/writing/${slug}/${name})\n`;
      // insert at the body cursor if we can, otherwise append
      const ta = bodyRef.current;
      setForm((f) => {
        const text = f.raw !== undefined ? f.raw : f.body;
        const pos = ta && document.activeElement !== null ? ta.selectionStart ?? text.length : text.length;
        const next = text.slice(0, pos) + md + text.slice(pos);
        return f.raw !== undefined ? { ...f, raw: next } : { ...f, body: next };
      });
      setStatus("image uploaded & inserted — it goes live with your next save");
    } catch (e) {
      setStatus(`image upload failed: ${e.message}`);
    }
  };

  // paste or drop an image straight into the textarea while writing
  const onPasteImage = (e) => {
    const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith("image/"));
    if (!item) return; // plain text pastes proceed as normal
    e.preventDefault();
    const file = item.getAsFile();
    if (file) uploadImage(file);
  };
  const onDropImage = (e) => {
    const file = [...(e.dataTransfer?.files || [])].find((f) => f.type.startsWith("image/"));
    if (!file) return;
    e.preventDefault();
    uploadImage(file);
  };

  /* token gate */
  if (token === null) {
    return (
      <div className="flex flex-col gap-4 text-sm text-stone-600 dark:text-stone-400">
        <h2 className="text-stone-800 dark:text-stone-200 font-semibold text-base">editor mode</h2>
        <p>
          Paste a GitHub <span className="font-medium">fine-grained personal access token</span> with
          read/write access to <code className="font-mono">Contents</code> on{" "}
          <code className="font-mono">{REPO}</code> only. It is stored in this browser and sent only to
          api.github.com.
        </p>
        <input
          type="password"
          placeholder="github_pat_…"
          value={tokenInput}
          onChange={(e) => setTokenInput(e.target.value)}
          className={inputCls}
        />
        <button
          className={btnCls}
          onClick={() => {
            if (!tokenInput.trim()) return;
            localStorage.setItem("editor-token", tokenInput.trim());
            setToken(tokenInput.trim());
            setTokenInput("");
          }}
        >
          unlock
        </button>
        {status && <p className="text-red-600 dark:text-red-400">{status}</p>}
      </div>
    );
  }

  /* post list */
  if (view === "list") {
    return (
      <div className="flex flex-col gap-4 text-sm text-stone-600 dark:text-stone-400">
        <div className="flex justify-between items-center">
          <h2 className="text-stone-800 dark:text-stone-200 font-semibold text-base">editor mode</h2>
          <button
            className="text-stone-500 hover:text-stone-700 dark:hover:text-stone-300 inline-flex items-center gap-1"
            onClick={() => {
              localStorage.removeItem("editor-token");
              setToken(null);
              setPosts(null);
            }}
          >
            <LogOut className="w-3.5 h-3.5" /> lock
          </button>
        </div>
        <button className={btnCls} onClick={newPost}>
          <Plus className="w-4 h-4" /> new post
        </button>
        {posts === null ? (
          <p>loading posts…</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {posts.map((slug) => (
              <li key={slug}>
                <button
                  className="inline-flex items-center gap-2 py-1 text-stone-700 dark:text-stone-300 hover:text-stone-900 dark:hover:text-stone-100"
                  onClick={() => openPost(slug)}
                >
                  <FileText className="w-4 h-4" /> {slug}
                </button>
              </li>
            ))}
          </ul>
        )}
        {status && <p className="text-red-600 dark:text-red-400">{status}</p>}
      </div>
    );
  }

  /* edit view */
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  return (
    <div className="flex flex-col gap-3 text-sm text-stone-600 dark:text-stone-400">
      <div className="flex justify-between items-center">
        <button className="inline-flex items-center gap-1 hover:text-stone-800 dark:hover:text-stone-200" onClick={() => setView("list")}>
          <ArrowLeft className="w-4 h-4" /> posts
        </button>
        {!form.isNew && (
          <a
            href={`/writing/${form.slug}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 hover:text-stone-800 dark:hover:text-stone-200"
          >
            view <ExternalLink className="w-3.5 h-3.5" />
          </a>
        )}
      </div>

      {form.raw !== undefined ? (
        <>
          <p className="text-xs">
            this post has a custom structure, so you are editing the raw MDX file.
          </p>
          <textarea
            ref={bodyRef}
            rows={22}
            value={form.raw}
            onChange={set("raw")}
            onPaste={onPasteImage}
            onDrop={onDropImage}
            onDragOver={(e) => e.preventDefault()}
            className={`${inputCls} font-mono text-xs`}
          />
        </>
      ) : (
        <>
          <input placeholder="title" value={form.title} onChange={set("title")} className={inputCls} />
          {form.isNew && (
            <input
              placeholder={`slug (${slugify(form.title) || "from-title"})`}
              value={form.slug}
              onChange={set("slug")}
              className={`${inputCls} font-mono`}
            />
          )}
          <div className="flex gap-3">
            <input placeholder="MM-DD-YYYY" value={form.date} onChange={set("date")} className={`${inputCls} font-mono`} />
            <input placeholder="tags, comma, separated" value={form.tags} onChange={set("tags")} className={inputCls} />
          </div>
          <input placeholder="one-line description" value={form.description} onChange={set("description")} className={inputCls} />
          <textarea
            ref={bodyRef}
            rows={18}
            placeholder={
              "markdown body…\n\n## headings, **bold**, [links](https://…), code blocks all work\npaste or drop an image anywhere to upload it right here"
            }
            value={form.body}
            onChange={set("body")}
            onPaste={onPasteImage}
            onDrop={onDropImage}
            onDragOver={(e) => e.preventDefault()}
            className={`${inputCls} font-mono text-xs leading-relaxed`}
          />
        </>
      )}

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) uploadImage(f);
          e.target.value = "";
        }}
      />
      <div className="flex items-center gap-3 flex-wrap">
        <button className={btnCls} onClick={save}>
          save & publish
        </button>
        <button className={btnCls} onClick={() => fileRef.current?.click()}>
          <ImagePlus className="w-4 h-4" /> photo
        </button>
        <span className={status.includes("failed") || status.includes("too large") ? "text-red-600 dark:text-red-400" : ""}>{status}</span>
      </div>
      <p className="text-xs text-stone-500">
        saving commits to GitHub; the site rebuilds automatically (~1 min). markdown is compiled as MDX —
        avoid stray {"{"} braces {"}"} and unclosed &lt;tags&gt;.
      </p>
    </div>
  );
}
