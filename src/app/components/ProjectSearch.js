"use client";

import { useState } from "react";
import { Search } from "lucide-react";
import ProjectList from "./ProjectList";

// TODO(Chester): add your projects here. For each project, drop a screenshot
// in src/app/assets/projects/ (webp) or a demo video in public/videos/ and
// reference it via `image` (imported) or `videoSrc` (public path).
//
// Example entry:
// {
//   title: "My Project",
//   href: "https://myproject.com",
//   description: "one-line description of what it does and why it's cool.",
//   image: MyProjectImage, // or videoSrc: "/videos/myproject.mp4"
//   imageAlt: "My Project",
//   technologies: ["TypeScript", "Next.js"],
//   github: "https://github.com/chesterchong/my-project",
//   demo: "https://myproject.com",
// },
const projects = [];

export default function ProjectSearch() {
  const [searchTerm, setSearchTerm] = useState("");

  const filtered = projects.filter(
    (project) =>
      project.title.toLowerCase().includes(searchTerm.toLowerCase()) ||
      project.description
        .toLowerCase()
        .includes(searchTerm.toLowerCase()) ||
      project.technologies.some((technology) =>
        technology.toLowerCase().includes(searchTerm.toLowerCase())
      )
  );

  return (
    <>
      <div className="relative">
        <Search className="absolute top-2.5 left-3 size-6 text-stone-400" />
        <input
          type="text"
          placeholder="search for a project, technology, etc."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          className="w-full py-2 px-4 border border-stone-400 rounded-md bg-transparent focus:outline-none focus:border-stone-700 pl-10"
        />
      </div>
      <ProjectList projects={filtered} />
    </>
  );
}
