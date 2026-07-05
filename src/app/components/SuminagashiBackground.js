"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { useTheme } from "./ThemeProvider";

/*
  墨流し (suminagashi) background — GPU fluid simulation.
  Velocity field: Stable Fluids (advect → vorticity confinement → project).
  Ink is accumulated as absorbance and displayed subtractively in light mode
  (paper × exp(-A)) or additively in dark mode (paper + (1 - exp(-A))).
*/

const CONFIG = {
  SIM_RES: 256,
  DYE_RES: 1280,
  PRESSURE_ITER: 24,
  VEL_DISSIPATION: 0.16,
  DYE_DISSIPATION: 0.035,
  CURL: 24,
  SPLAT_RADIUS: 0.0026,
  SPLAT_FORCE: 4600,
};

// 墨 sumi, 藍 ai, 朱 shu, 松葉 matsuba — on washi paper
const PALETTES = {
  light: {
    paper: "#f0ece3",
    inks: ["#1a1a1f", "#16407a", "#c8372d", "#2e6e52"],
  },
  // gofun white replaces sumi black on dark water
  dark: {
    paper: "#0e0d0c",
    inks: ["#d6d3cd", "#5b8fd6", "#e0604f", "#58b189"],
  },
};

function createSim(mount) {
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

  let dark = document.documentElement.classList.contains("dark");
  let palette = PALETTES[dark ? "dark" : "light"];

  // ink display color -> absorbance vector, such that the displayed result
  // approaches the ink color as absorbance accumulates (in either mode)
  function inkAbsorption(hex, strength) {
    const c = new THREE.Color(hex);
    const e = 0.012;
    const ch = (v) =>
      dark
        ? -Math.log(Math.max(1 - v * 0.94, e)) * strength * 1.9
        : -Math.log(Math.max(v, e)) * strength;
    return new THREE.Vector3(ch(c.r), ch(c.g), ch(c.b));
  }

  const renderer = new THREE.WebGLRenderer({
    antialias: false,
    alpha: false,
    depth: false,
    stencil: false,
  });
  renderer.setSize(innerWidth, innerHeight);
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.autoClear = false;
  renderer.domElement.style.width = "100%";
  renderer.domElement.style.height = "100%";
  mount.appendChild(renderer.domElement);

  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const scene = new THREE.Scene();
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), null);
  scene.add(quad);

  function makeRT(w, h) {
    return new THREE.WebGLRenderTarget(w, h, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
      format: THREE.RGBAFormat,
      type: THREE.HalfFloatType,
      depthBuffer: false,
    });
  }
  function makeDoubleFBO(w, h) {
    return {
      read: makeRT(w, h),
      write: makeRT(w, h),
      texel: new THREE.Vector2(1 / w, 1 / h),
      swap() {
        const t = this.read;
        this.read = this.write;
        this.write = t;
      },
      resize(nw, nh) {
        this.read.setSize(nw, nh);
        this.write.setSize(nw, nh);
        this.texel.set(1 / nw, 1 / nh);
      },
      dispose() {
        this.read.dispose();
        this.write.dispose();
      },
    };
  }

  function simSizes() {
    const aspect = innerWidth / innerHeight;
    const sim = CONFIG.SIM_RES;
    const dyeRes = Math.min(CONFIG.DYE_RES, Math.max(innerWidth, innerHeight));
    return aspect >= 1
      ? { sw: Math.round(sim * aspect), sh: sim, dw: dyeRes, dh: Math.round(dyeRes / aspect) }
      : { sw: sim, sh: Math.round(sim / aspect), dw: Math.round(dyeRes * aspect), dh: dyeRes };
  }

  let S = simSizes();
  const velocity = makeDoubleFBO(S.sw, S.sh);
  const dye = makeDoubleFBO(S.dw, S.dh);
  const pressure = makeDoubleFBO(S.sw, S.sh);
  const curlRT = makeRT(S.sw, S.sh);
  const divergeRT = makeRT(S.sw, S.sh);

  const VERT = /* glsl */ `
    varying vec2 vUv;
    void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
  `;
  function prog(frag, uniforms) {
    return new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: frag,
      uniforms,
      depthTest: false,
      depthWrite: false,
    });
  }

  const advectMat = prog(
    /* glsl */ `
    precision highp float;
    varying vec2 vUv;
    uniform sampler2D uVelocity, uSource;
    uniform vec2 uTexel;
    uniform float uDt, uDissipation;
    void main(){
      vec2 coord = vUv - uDt * texture2D(uVelocity, vUv).xy * uTexel;
      gl_FragColor = texture2D(uSource, coord) / (1.0 + uDissipation * uDt);
    }
  `,
    {
      uVelocity: { value: null },
      uSource: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uDt: { value: 0 },
      uDissipation: { value: 0 },
    }
  );

  const splatMat = prog(
    /* glsl */ `
    precision highp float;
    varying vec2 vUv;
    uniform sampler2D uTarget;
    uniform float uAspect, uRadius;
    uniform vec2 uPoint;
    uniform vec3 uColor;
    void main(){
      vec2 p = vUv - uPoint;
      p.x *= uAspect;
      vec3 splat = exp(-dot(p, p) / uRadius) * uColor;
      gl_FragColor = vec4(texture2D(uTarget, vUv).rgb + splat, 1.0);
    }
  `,
    {
      uTarget: { value: null },
      uAspect: { value: 1 },
      uRadius: { value: 0.001 },
      uPoint: { value: new THREE.Vector2() },
      uColor: { value: new THREE.Vector3() },
    }
  );

  const curlMat = prog(
    /* glsl */ `
    precision highp float;
    varying vec2 vUv;
    uniform sampler2D uVelocity;
    uniform vec2 uTexel;
    void main(){
      float L = texture2D(uVelocity, vUv - vec2(uTexel.x, 0.0)).y;
      float R = texture2D(uVelocity, vUv + vec2(uTexel.x, 0.0)).y;
      float B = texture2D(uVelocity, vUv - vec2(0.0, uTexel.y)).x;
      float T = texture2D(uVelocity, vUv + vec2(0.0, uTexel.y)).x;
      gl_FragColor = vec4(0.5 * (R - L - T + B), 0.0, 0.0, 1.0);
    }
  `,
    { uVelocity: { value: null }, uTexel: { value: new THREE.Vector2() } }
  );

  const vorticityMat = prog(
    /* glsl */ `
    precision highp float;
    varying vec2 vUv;
    uniform sampler2D uVelocity, uCurl;
    uniform vec2 uTexel;
    uniform float uCurlStrength, uDt;
    void main(){
      float L = texture2D(uCurl, vUv - vec2(uTexel.x, 0.0)).x;
      float R = texture2D(uCurl, vUv + vec2(uTexel.x, 0.0)).x;
      float B = texture2D(uCurl, vUv - vec2(0.0, uTexel.y)).x;
      float T = texture2D(uCurl, vUv + vec2(0.0, uTexel.y)).x;
      float C = texture2D(uCurl, vUv).x;
      vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
      force /= length(force) + 0.0001;
      force *= uCurlStrength * C;
      force.y *= -1.0;
      vec2 vel = texture2D(uVelocity, vUv).xy + force * uDt;
      gl_FragColor = vec4(clamp(vel, -1000.0, 1000.0), 0.0, 1.0);
    }
  `,
    {
      uVelocity: { value: null },
      uCurl: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uCurlStrength: { value: 0 },
      uDt: { value: 0 },
    }
  );

  const divergeMat = prog(
    /* glsl */ `
    precision highp float;
    varying vec2 vUv;
    uniform sampler2D uVelocity;
    uniform vec2 uTexel;
    void main(){
      float L = texture2D(uVelocity, vUv - vec2(uTexel.x, 0.0)).x;
      float R = texture2D(uVelocity, vUv + vec2(uTexel.x, 0.0)).x;
      float B = texture2D(uVelocity, vUv - vec2(0.0, uTexel.y)).y;
      float T = texture2D(uVelocity, vUv + vec2(0.0, uTexel.y)).y;
      vec2 C = texture2D(uVelocity, vUv).xy;
      if (vUv.x - uTexel.x < 0.0) L = -C.x;
      if (vUv.x + uTexel.x > 1.0) R = -C.x;
      if (vUv.y - uTexel.y < 0.0) B = -C.y;
      if (vUv.y + uTexel.y > 1.0) T = -C.y;
      gl_FragColor = vec4(0.5 * (R - L + T - B), 0.0, 0.0, 1.0);
    }
  `,
    { uVelocity: { value: null }, uTexel: { value: new THREE.Vector2() } }
  );

  const pressureMat = prog(
    /* glsl */ `
    precision highp float;
    varying vec2 vUv;
    uniform sampler2D uPressure, uDivergence;
    uniform vec2 uTexel;
    void main(){
      float L = texture2D(uPressure, vUv - vec2(uTexel.x, 0.0)).x;
      float R = texture2D(uPressure, vUv + vec2(uTexel.x, 0.0)).x;
      float B = texture2D(uPressure, vUv - vec2(0.0, uTexel.y)).x;
      float T = texture2D(uPressure, vUv + vec2(0.0, uTexel.y)).x;
      float div = texture2D(uDivergence, vUv).x;
      gl_FragColor = vec4((L + R + B + T - div) * 0.25, 0.0, 0.0, 1.0);
    }
  `,
    {
      uPressure: { value: null },
      uDivergence: { value: null },
      uTexel: { value: new THREE.Vector2() },
    }
  );

  const gradientMat = prog(
    /* glsl */ `
    precision highp float;
    varying vec2 vUv;
    uniform sampler2D uPressure, uVelocity;
    uniform vec2 uTexel;
    void main(){
      float L = texture2D(uPressure, vUv - vec2(uTexel.x, 0.0)).x;
      float R = texture2D(uPressure, vUv + vec2(uTexel.x, 0.0)).x;
      float B = texture2D(uPressure, vUv - vec2(0.0, uTexel.y)).x;
      float T = texture2D(uPressure, vUv + vec2(0.0, uTexel.y)).x;
      vec2 vel = texture2D(uVelocity, vUv).xy - vec2(R - L, T - B);
      gl_FragColor = vec4(vel, 0.0, 1.0);
    }
  `,
    {
      uPressure: { value: null },
      uVelocity: { value: null },
      uTexel: { value: new THREE.Vector2() },
    }
  );

  const clearMat = prog(
    /* glsl */ `
    precision highp float;
    varying vec2 vUv;
    uniform sampler2D uTexture;
    uniform float uValue;
    void main(){ gl_FragColor = uValue * texture2D(uTexture, vUv); }
  `,
    { uTexture: { value: null }, uValue: { value: 0.8 } }
  );

  // display: washi fiber noise + subtractive (light) or additive (dark) mixing
  const paperColor = new THREE.Color(palette.paper);
  const displayMat = prog(
    /* glsl */ `
    precision highp float;
    varying vec2 vUv;
    uniform sampler2D uDye;
    uniform vec3 uPaper;
    uniform float uDark, uStarry, uTime, uAspect;

    float hash(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }
    float noise(vec2 p){
      vec2 i=floor(p), f=fract(p);
      f=f*f*(3.0-2.0*f);
      return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),
                 mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);
    }

    void main(){
      float fiber = noise(vUv * 420.0) * 0.028
                  + noise(vUv * 180.0) * 0.022
                  + noise(vUv * 60.0)  * 0.018;

      vec3 A = texture2D(uDye, vUv).rgb;
      vec3 T = exp(-A);

      vec3 lightCol = uPaper * T + fiber;
      vec3 darkCol  = uPaper + (1.0 - T) * 1.0 + fiber * 0.22;
      vec3 col = mix(lightCol, darkCol, uDark);

      // starry mode: a crisp celestial layer beneath the ink — twinkling
      // stars and a moon, with dye mists drifting across them
      if (uStarry > 0.5) {
        vec2 cell = floor(vUv * 70.0);
        float h = hash(cell);
        float star = 0.0;
        if (h > 0.976) {
          vec2 f = fract(vUv * 70.0) - 0.5;
          float tw = 0.5 + 0.5 * sin(uTime * (1.2 + hash(cell + 7.0) * 2.6) + hash(cell + 3.0) * 6.28);
          star = smoothstep(0.24, 0.02, length(f)) * tw;
        }
        vec2 mp = vUv - vec2(0.76, 0.78);
        mp.x *= uAspect;
        float md = length(mp);
        float disc = smoothstep(0.052, 0.044, md);
        float halo = smoothstep(0.17, 0.05, md) * 0.22;
        // the denser the ink, the dimmer the sky shows through
        float veil = exp(-(A.r + A.g + A.b) * 0.8);
        vec3 starCol = mix(vec3(0.36, 0.34, 0.55), vec3(0.92, 0.93, 1.0), uDark);
        vec3 moonCol = mix(vec3(0.72, 0.63, 0.38), vec3(0.94, 0.91, 0.78), uDark);
        col = mix(col, starCol, star * veil * mix(0.55, 0.95, uDark));
        col = mix(col, moonCol, clamp((disc * 0.9 + halo) * veil, 0.0, 1.0));
      }

      vec2 uv2 = vUv * (1.0 - vUv.yx);
      float vign = pow(uv2.x * uv2.y * 15.0, 0.18);
      col *= 0.94 + 0.06 * vign;

      gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
    }
  `,
    {
      uDye: { value: null },
      uPaper: { value: new THREE.Vector3(paperColor.r, paperColor.g, paperColor.b) },
      uDark: { value: dark ? 1 : 0 },
      uStarry: { value: 0 },
      uTime: { value: 0 },
      uAspect: { value: innerWidth / innerHeight },
    }
  );

  function blit(mat, target) {
    quad.material = mat;
    renderer.setRenderTarget(target);
    renderer.render(scene, camera);
  }

  function splatVelocity(x, y, fx, fy, radiusMul) {
    splatMat.uniforms.uTarget.value = velocity.read.texture;
    splatMat.uniforms.uAspect.value = innerWidth / innerHeight;
    splatMat.uniforms.uPoint.value.set(x, y);
    splatMat.uniforms.uRadius.value = CONFIG.SPLAT_RADIUS * (radiusMul || 1);
    splatMat.uniforms.uColor.value.set(fx, fy, 0);
    blit(splatMat, velocity.write);
    velocity.swap();
  }
  function splatDye(x, y, absorption, radiusMul) {
    splatMat.uniforms.uTarget.value = dye.read.texture;
    splatMat.uniforms.uAspect.value = innerWidth / innerHeight;
    splatMat.uniforms.uPoint.value.set(x, y);
    splatMat.uniforms.uRadius.value = CONFIG.SPLAT_RADIUS * (radiusMul || 1);
    splatMat.uniforms.uColor.value.copy(absorption);
    blit(splatMat, dye.write);
    dye.swap();
  }

  function dropInk(x, y, hex, strength) {
    splatDye(x, y, inkAbsorption(hex, strength * 0.18), 1.5);
    const angle = Math.random() * Math.PI * 2;
    const speed = 60 + Math.random() * 80;
    splatVelocity(x, y, Math.cos(angle) * speed, Math.sin(angle) * speed, 1.2);
  }
  function randomInk() {
    return palette.inks[Math.floor(Math.random() * palette.inks.length)];
  }

  /* pointer: hover stirs the water, click drops ink */
  const pointer = { x: 0, y: 0, px: 0, py: 0, moved: false };
  let inkIdx = 0;
  function toUV(e) {
    return { x: e.clientX / innerWidth, y: 1 - e.clientY / innerHeight };
  }
  function onPointerMove(e) {
    const p = toUV(e);
    pointer.px = pointer.x;
    pointer.py = pointer.y;
    pointer.x = p.x;
    pointer.y = p.y;
    pointer.moved = true;
    lastInteraction = performance.now();
  }
  function onPointerDown(e) {
    const p = toUV(e);
    dropInk(p.x, p.y, palette.inks[inkIdx++ % palette.inks.length], 0.6 + Math.random() * 0.3);
    lastInteraction = performance.now();
  }
  addEventListener("pointermove", onPointerMove);
  addEventListener("pointerdown", onPointerDown);

  function applyPointer() {
    if (!pointer.moved) return;
    pointer.moved = false;
    const dx = pointer.x - pointer.px;
    const dy = pointer.y - pointer.py;
    if (Math.abs(dx) + Math.abs(dy) < 1e-6) return;
    splatVelocity(pointer.x, pointer.y, dx * CONFIG.SPLAT_FORCE, dy * CONFIG.SPLAT_FORCE, 1.4);
  }

  /* ── effect engine ──
     each mode is a choreography: a per-frame pattern of dye + velocity
     splats layered on the same fluid core, so every effect melts and
     marbles like ink. Modes are switched via the ⌘K palette (a
     "set-bg-effect" window event) and persisted to localStorage. */
  let lastInteraction = 0;

  // per-effect fluid feel: how fast dye fades / how tight the vortices curl
  const EFFECT_PARAMS = {
    suminagashi: { dye: 0.035, curl: 24 },
    aurora: { dye: 0.9, curl: 10 },
    hanabi: { dye: 0.7, curl: 14 },
    starry: { dye: 0.5, curl: 5 },
    meteor: { dye: 0.5, curl: 14 },
    ocean: { dye: 0.75, curl: 10 },
    cloud: { dye: 0.4, curl: 4 },
    fire: { dye: 1.1, curl: 22 },
    galaxy: { dye: 1.0, curl: 8 },
    ripple: { dye: 0.8, curl: 14 },
    breathing: { dye: 0.7, curl: 6 },
    rainbowCycle: { dye: 0.06, curl: 24 },
    rainbowWave: { dye: 0.7, curl: 12 },
    rain: { dye: 0.55, curl: 18 },
  };

  let effect = "suminagashi";
  try {
    const saved = localStorage.getItem("bg-effect");
    if (saved && (saved in EFFECT_PARAMS || saved === "random")) effect = saved;
  } catch {}
  let randomCurrent = "aurora";
  let fx = {}; // per-effect scratch state, reset on every switch

  const activeEffect = () => (effect === "random" ? randomCurrent : effect);
  function setEffect(name) {
    if (!(name in EFFECT_PARAMS) && name !== "random") return;
    effect = name;
    try {
      localStorage.setItem("bg-effect", name);
    } catch {}
    fx = {};
    washing = 1.2; // rinse the previous scene away
  }
  const onSetEffect = (e) => setEffect(String(e.detail || ""));
  addEventListener("set-bg-effect", onSetEffect);

  function hsl(h, s, l) {
    const c = new THREE.Color();
    c.setHSL(((h % 1) + 1) % 1, s, l);
    return "#" + c.getHexString();
  }
  const rnd = (a, b) => a + Math.random() * (b - a);
  const slow = reducedMotion ? 2.5 : 1; // stretch spawn intervals

  /* Japanese fireworks (花火) helpers */
  const HANABI_COLORS = ["#f2c14e", "#e0503a", "#57b06b", "#5b8fd6", "#b06bd0", "#e8e4da"];

  // 型物 shapes as unit-offset point rings
  const HEART_PTS = Array.from({ length: 22 }, (_, i) => {
    const t = (i / 22) * Math.PI * 2;
    return [
      (16 * Math.sin(t) ** 3) / 16,
      (13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)) / 16,
    ];
  });
  const STAR_PTS = Array.from({ length: 10 }, (_, k) => {
    const a = (k / 10) * Math.PI * 2 + Math.PI / 2;
    const r = k % 2 ? 0.45 : 1;
    return [Math.cos(a) * r, Math.sin(a) * r];
  });

  function hanabiShell(kind) {
    return {
      kind, // warimono | hanwarimono | katamono | small
      x: rnd(0.25, 0.75),
      y: 0.02,
      ty: kind === "small" ? rnd(0.5, 0.7) : rnd(0.58, 0.8),
      vy: rnd(0.35, 0.48),
      color: HANABI_COLORS[Math.floor(Math.random() * HANABI_COLORS.length)],
    };
  }

  function hanabiBurst(sh) {
    const asp = innerWidth / innerHeight;
    splatDye(sh.x, sh.y, inkAbsorption("#f5efdc", 0.18), 1.6); // opening flash
    const b = {
      x: sh.x,
      y: sh.y,
      age: 0,
      kind: sh.kind,
      color: sh.color,
      color2: HANABI_COLORS[Math.floor(Math.random() * HANABI_COLORS.length)],
    };
    if (sh.kind === "katamono") {
      b.pts = Math.random() < 0.5 ? HEART_PTS : STAR_PTS;
    } else {
      b.n = sh.kind === "small" ? 10 : 18;
      b.half = sh.kind === "hanwarimono";
    }
    // one-shot radial impulse; the petal streaks are drawn over the next
    // half second by the burst updater in the choreography
    const n = b.n || 16;
    const F = sh.kind === "small" ? 150 : sh.kind === "katamono" ? 80 : 210;
    for (let k = 0; k < n; k++) {
      const a = b.half ? (k / (n - 1)) * Math.PI : (k / n) * Math.PI * 2;
      splatVelocity(sh.x + (Math.cos(a) * 0.02) / asp, sh.y + Math.sin(a) * 0.02, Math.cos(a) * F, Math.sin(a) * F, 0.9);
    }
    (fx.bursts = fx.bursts || []).push(b);
  }

  const CHOREO = {
    suminagashi(now, dt) {
      const idle = now - lastInteraction > 3000;
      fx.drop = (fx.drop ?? 1200) - dt * 1000;
      if (idle && fx.drop <= 0) {
        const x = rnd(0.14, 0.86);
        const y = rnd(0.16, 0.84);
        dropInk(x, y, randomInk(), rnd(1.0, 1.8));
        if (Math.random() < 0.5) {
          const x2 = Math.min(Math.max(x + rnd(-0.08, 0.08), 0.08), 0.92);
          const y2 = Math.min(Math.max(y + rnd(-0.08, 0.08), 0.08), 0.92);
          setTimeout(() => dropInk(x2, y2, randomInk(), rnd(0.6, 1.1)), rnd(220, 520));
        }
        fx.drop = rnd(1100, 2500) * slow;
      }
      fx.stir = (fx.stir ?? 2600) - dt * 1000;
      if (!reducedMotion && fx.stir <= 0) {
        const t = now * 0.00012;
        const a = t * 6.0 + rnd(0, 1.5);
        splatVelocity(
          0.5 + Math.sin(t * 1.7) * 0.3,
          0.5 + Math.cos(t * 1.1) * 0.3,
          Math.cos(a) * 130,
          Math.sin(a) * 130,
          14
        );
        fx.stir = rnd(700, 1600);
      }
    },

    aurora(now, dt) {
      // waving curtains of green → teal → violet light in the upper sky
      for (let c = 0; c < 3; c++) {
        const x = Math.random();
        const y = 0.84 - c * 0.06 + 0.06 * Math.sin(x * 7 + now * 0.0007 + c * 2.1);
        const hue = 0.36 + 0.32 * x + 0.04 * c;
        splatDye(x, y, inkAbsorption(hsl(hue, 0.85, dark ? 0.58 : 0.42), 0.011), rnd(1.2, 2.6));
      }
      fx.shim = (fx.shim ?? 0) - dt * 1000;
      if (fx.shim <= 0) {
        const x = Math.random();
        splatVelocity(x, 0.7, Math.sin(now * 0.0005 + x * 9) * 50, rnd(30, 90), 8);
        fx.shim = rnd(120, 320) * slow;
      }
    },

    meteor(now, dt) {
      fx.list = fx.list || [];
      fx.spawn = (fx.spawn ?? 600) - dt * 1000;
      if (fx.spawn <= 0) {
        const a = rnd(-2.2, -0.9); // heading, radians (downward arc)
        fx.list.push({
          x: rnd(0.15, 0.95),
          y: rnd(0.85, 1.02),
          vx: Math.cos(a),
          vy: Math.sin(a),
          sp: rnd(0.45, 0.75),
          life: rnd(0.8, 1.3),
          hue: Math.random() < 0.3 ? 0.13 : 0.62, // gold or ice blue
        });
        fx.spawn = rnd(900, 2400) * slow;
      }
      fx.list = fx.list.filter((m) => {
        m.life -= dt;
        m.x += m.vx * m.sp * dt;
        m.y += m.vy * m.sp * dt;
        if (m.life <= 0 || m.x < -0.1 || m.x > 1.1 || m.y < -0.1) return false;
        splatDye(m.x, m.y, inkAbsorption(hsl(m.hue, 0.75, dark ? 0.75 : 0.5), 0.1), 0.9);
        splatVelocity(m.x, m.y, m.vx * 220, m.vy * 220, 1.6);
        return true;
      });
    },

    ocean(now, dt) {
      // standing on the beach: deep water near the horizon (top), a swash
      // front that rolls in toward the sand (bottom), pauses, and pulls out
      const T = 8000;
      const ph = (now % T) / T;
      const tIn = 0.55; // fraction of the cycle spent coming in
      const p = ph < tIn ? ph / tIn : 1 - (ph - tIn) / (1 - tIn);
      const ease = p * p * (3 - 2 * p);
      const frontY = 0.44 - 0.3 * ease; // 0.44 (out) → 0.14 (fully in)
      const fy = ph < tIn ? -110 : 70; // water rushes down-shore, then back

      // deep sea band
      for (let i = 0; i < 2; i++) {
        splatDye(Math.random(), rnd(0.72, 0.92), inkAbsorption(hsl(rnd(0.55, 0.6), 0.65, dark ? 0.5 : 0.35), 0.007), rnd(2, 4));
      }
      // foam at the leading edge, aqua body just behind it
      for (let i = 0; i < 3; i++) {
        const x = Math.random();
        const y = frontY + 0.03 * Math.sin(x * 5 + now * 0.0004) + rnd(-0.01, 0.01);
        splatDye(x, y, inkAbsorption(dark ? "#dff3f2" : "#78b8c4", 0.02), rnd(0.8, 1.6));
        if (i === 0) splatDye(x, y + 0.07, inkAbsorption(hsl(0.53, 0.6, dark ? 0.55 : 0.42), 0.014), rnd(1.5, 3));
      }
      fx.push = (fx.push ?? 0) - dt * 1000;
      if (fx.push <= 0) {
        splatVelocity(Math.random(), frontY + 0.02, rnd(-25, 25), fy, 8);
        fx.push = rnd(150, 350) * slow;
      }
    },

    cloud(now, dt) {
      // real cloud shapes as puff clusters, re-inked each frame so they hold
      // their form while the wind wisps their edges away.
      // types: cumulus (cauliflower), cirrus (high streaks),
      // stratus/altostratus (flat sheet), cumulonimbus (dark-based tower)
      if (!fx.make) {
        fx.make = () => {
          const kind = ["cumulus", "cumulus", "cirrus", "stratus", "cumulonimbus"][Math.floor(Math.random() * 5)];
          const sc = rnd(0.75, 1.3);
          const puffs = [];
          if (kind === "cumulus") {
            puffs.push(
              { dx: -0.055 * sc, dy: 0, r: 2.6 * sc },
              { dx: 0, dy: 0, r: 3.2 * sc },
              { dx: 0.055 * sc, dy: 0, r: 2.6 * sc },
              { dx: -0.03 * sc, dy: 0.03 * sc, r: 2.2 * sc },
              { dx: 0.028 * sc, dy: 0.028 * sc, r: 2 * sc },
              { dx: 0, dy: 0.052 * sc, r: 2.4 * sc }
            );
          } else if (kind === "cirrus") {
            for (let i = 0; i < 6; i++) {
              puffs.push({ dx: (i - 2.5) * 0.045 * sc, dy: Math.sin(i * 1.1) * 0.012, r: rnd(0.7, 1.2) });
            }
          } else if (kind === "stratus") {
            for (let i = 0; i < 4; i++) puffs.push({ dx: (i - 1.5) * 0.09 * sc, dy: rnd(-0.008, 0.008), r: 5 * sc });
          } else {
            // cumulonimbus: dark flat base, towering column, anvil top
            puffs.push(
              { dx: -0.04 * sc, dy: 0, r: 2.8 * sc, base: true },
              { dx: 0.04 * sc, dy: 0, r: 2.8 * sc, base: true },
              { dx: 0, dy: 0.05 * sc, r: 2.8 * sc },
              { dx: 0.012 * sc, dy: 0.11 * sc, r: 2.4 * sc },
              { dx: 0, dy: 0.17 * sc, r: 2 * sc },
              { dx: -0.05 * sc, dy: 0.21 * sc, r: 1.8 * sc },
              { dx: 0.05 * sc, dy: 0.21 * sc, r: 1.8 * sc },
              { dx: 0, dy: 0.215 * sc, r: 2.2 * sc }
            );
          }
          return {
            kind,
            puffs,
            x: -0.15,
            y: kind === "cirrus" ? rnd(0.84, 0.94) : kind === "cumulonimbus" ? rnd(0.42, 0.5) : rnd(0.58, 0.8),
            speed: kind === "cirrus" ? 0.026 : kind === "stratus" ? 0.01 : 0.016,
            strength: kind === "cirrus" ? 0.0008 : kind === "stratus" ? 0.0006 : 0.001,
          };
        };
        fx.clouds = [fx.make()];
        fx.clouds[0].x = rnd(0.2, 0.6); // one cloud already mid-sky
      }
      fx.spawn = (fx.spawn ?? 2000) - dt * 1000;
      if (fx.spawn <= 0 && fx.clouds.length < 3) {
        fx.clouds.push(fx.make());
        fx.spawn = rnd(6000, 12000) * slow;
      }
      const body = dark ? "#ddd8ce" : "#b6bbc2";
      const baseCol = dark ? "#8f8a82" : "#8b9099";
      fx.clouds = fx.clouds.filter((cl) => {
        cl.x += cl.speed * dt;
        if (cl.x > 1.3) return false;
        for (const p of cl.puffs) {
          splatDye(cl.x + p.dx, cl.y + p.dy, inkAbsorption(p.base ? baseCol : body, cl.strength), p.r);
        }
        return true;
      });
      fx.wind = (fx.wind ?? 0) - dt * 1000;
      if (fx.wind <= 0) {
        splatVelocity(Math.random(), rnd(0.45, 0.95), 30, rnd(-3, 3), 20);
        fx.wind = rnd(500, 900);
      }
    },

    fire(now, dt) {
      // a campfire: narrow ember bed, quick small flame licks, stray sparks
      for (let i = 0; i < 3; i++) {
        const x = 0.5 + (Math.random() - 0.5) * 0.34;
        const r = Math.random();
        const hex = r < 0.5 ? "#e04a12" : r < 0.85 ? "#f28b1c" : "#f8d84a";
        splatDye(x, rnd(0.02, 0.07), inkAbsorption(hex, 0.07), rnd(0.7, 1.5));
      }
      fx.buoy = (fx.buoy ?? 0) - dt * 1000;
      if (fx.buoy <= 0) {
        splatVelocity(0.5 + (Math.random() - 0.5) * 0.36, rnd(0.04, 0.16), rnd(-30, 30), rnd(90, 180), rnd(1, 2.2));
        fx.buoy = rnd(40, 110) * slow;
      }
      fx.spark = (fx.spark ?? 0) - dt * 1000;
      if (fx.spark <= 0) {
        const x = 0.5 + (Math.random() - 0.5) * 0.3;
        splatDye(x, rnd(0.1, 0.2), inkAbsorption("#f8d84a", 0.25), 0.25);
        splatVelocity(x, rnd(0.1, 0.2), rnd(-15, 15), rnd(160, 240), 0.5);
        fx.spark = rnd(300, 700) * slow;
      }
    },

    galaxy(now, dt) {
      fx.th = (fx.th ?? 0) + dt * 0.55;
      const asp = innerWidth / innerHeight;
      for (let arm = 0; arm < 2; arm++) {
        const r = rnd(0.04, 0.42);
        const a = fx.th + arm * Math.PI + r * 6.5; // trailing spiral arms
        const x = 0.5 + (Math.cos(a) * r) / asp;
        const y = 0.5 + Math.sin(a) * r;
        const hue = r < 0.1 ? 0.12 : 0.68 + r * 0.25; // golden core, violet arms
        splatDye(x, y, inkAbsorption(hsl(hue, r < 0.1 ? 0.5 : 0.7, dark ? 0.65 : 0.45), 0.02), rnd(0.7, 1.4));
      }
      fx.spin = (fx.spin ?? 0) - dt * 1000;
      if (fx.spin <= 0) {
        for (let k = 0; k < 4; k++) {
          const a = fx.th * 1.3 + (k * Math.PI) / 2;
          splatVelocity(0.5 + (Math.cos(a) * 0.28) / asp, 0.5 + Math.sin(a) * 0.28, -Math.sin(a) * 90, Math.cos(a) * 90, 6);
        }
        fx.spin = rnd(250, 450) * slow;
      }
    },

    ripple(now, dt) {
      // delicate raindrop rings, not tidal waves
      fx.list = fx.list || [];
      fx.spawn = (fx.spawn ?? 300) - dt * 1000;
      if (fx.spawn <= 0) {
        fx.list.push({ x: rnd(0.12, 0.88), y: rnd(0.15, 0.85), age: 0, hue: Math.random() });
        fx.spawn = rnd(700, 1400) * slow;
      }
      const asp = innerWidth / innerHeight;
      fx.list = fx.list.filter((rp) => {
        rp.age += dt;
        if (rp.age > 1.2) return false;
        const R = 0.015 + rp.age * 0.045;
        const fade = Math.max(0, 1 - rp.age / 1.2);
        for (let k = 0; k < 10; k++) {
          const a = (k / 10) * Math.PI * 2 + rp.age * 1.5;
          const x = rp.x + (Math.cos(a) * R) / asp;
          const y = rp.y + Math.sin(a) * R;
          splatVelocity(x, y, Math.cos(a) * 25 * fade, Math.sin(a) * 25 * fade, 0.6);
          // dye only once the ring has opened up, so the centre stays clear
          if (rp.age > 0.3) splatDye(x, y, inkAbsorption(hsl(rp.hue, 0.5, dark ? 0.6 : 0.45), 0.028 * fade), 0.18);
        }
        return true;
      });
    },

    breathing(now, dt) {
      // a small soft orb that wanders slowly and breathes gently
      const phase = Math.sin(now * 0.0005); // >0 exhale, <0 inhale
      fx.hue = (fx.hue ?? Math.random()) + dt * 0.006;
      const cx = 0.5 + 0.18 * Math.sin(now * 0.00011);
      const cy = 0.5 + 0.14 * Math.sin(now * 0.00017 + 1.3);
      if (phase > 0.05) {
        splatDye(cx, cy, inkAbsorption(hsl(fx.hue, 0.55, dark ? 0.6 : 0.45), 0.02 * phase), 4.5);
      }
      fx.pulse = (fx.pulse ?? 0) - dt * 1000;
      if (fx.pulse <= 0) {
        const asp = innerWidth / innerHeight;
        for (let k = 0; k < 5; k++) {
          const a = (k / 5) * Math.PI * 2 + now * 0.0001;
          splatVelocity(
            cx + (Math.cos(a) * 0.09) / asp,
            cy + Math.sin(a) * 0.09,
            Math.cos(a) * 55 * phase,
            Math.sin(a) * 55 * phase,
            3.5
          );
        }
        fx.pulse = rnd(180, 380) * slow;
      }
    },

    rainbowCycle(now, dt) {
      fx.hue = fx.hue ?? Math.random();
      fx.drop = (fx.drop ?? 600) - dt * 1000;
      if (fx.drop <= 0) {
        fx.hue = (fx.hue + 0.09) % 1;
        dropInk(rnd(0.14, 0.86), rnd(0.16, 0.84), hsl(fx.hue, 0.8, dark ? 0.6 : 0.45), rnd(1.0, 1.7));
        fx.drop = rnd(600, 1300) * slow;
      }
      fx.stir = (fx.stir ?? 2600) - dt * 1000;
      if (!reducedMotion && fx.stir <= 0) {
        const t = now * 0.00012;
        const a = t * 6.0 + rnd(0, 1.5);
        splatVelocity(0.5 + Math.sin(t * 1.7) * 0.3, 0.5 + Math.cos(t * 1.1) * 0.3, Math.cos(a) * 130, Math.sin(a) * 130, 14);
        fx.stir = rnd(700, 1600);
      }
    },

    rainbowWave(now, dt) {
      const front = ((now * 0.00006) % 1.25) - 0.125; // sweeps left → right
      for (let i = 0; i < 3; i++) {
        const y = Math.random();
        splatDye(
          front + rnd(-0.02, 0.02),
          y,
          inkAbsorption(hsl(now * 0.00005 + y * 0.25, 0.8, dark ? 0.52 : 0.45), 0.02),
          rnd(1, 2)
        );
      }
      fx.push = (fx.push ?? 0) - dt * 1000;
      if (fx.push <= 0) {
        splatVelocity(front, Math.random(), 110, rnd(-25, 25), 10);
        fx.push = rnd(150, 400) * slow;
      }
    },

    rain(now, dt) {
      fx.spawn = (fx.spawn ?? 0) - dt * 1000;
      if (fx.spawn <= 0) {
        const x = Math.random();
        splatDye(x, rnd(0.9, 0.99), inkAbsorption(dark ? "#8fb4d8" : "#4a6b8a", 0.5), rnd(0.35, 0.7));
        splatVelocity(x, 0.95, rnd(-15, 15), -rnd(260, 420), rnd(0.8, 1.6));
        fx.spawn = rnd(90, 260) * slow;
      }
    },

    hanabi(now, dt) {
      // 花火大会: shells rise and burst as 割物 (chrysanthemum spheres),
      // 半割物 (half fans), 型物 (hearts/stars), スターマイン volleys, and
      // 手筒花火 (handheld fountains spraying gold from below)
      fx.shells = fx.shells || [];
      fx.next = (fx.next ?? 800) - dt * 1000;
      if (fx.next <= 0) {
        const type =
          fx.forceType ||
          ["warimono", "hanwarimono", "katamono", "starmine", "tezutsu"][Math.floor(Math.random() * 5)];
        if (type === "starmine") {
          const list = fx.shells;
          for (let i = 0; i < 6; i++) {
            setTimeout(() => {
              if (fx.shells === list) list.push(hanabiShell("small"));
            }, i * 320);
          }
          fx.next = rnd(6000, 9000) * slow;
        } else if (type === "tezutsu") {
          fx.tezutsu = { x: rnd(0.3, 0.7), t: rnd(2.5, 3.5) };
          fx.next = rnd(5500, 8000) * slow;
        } else {
          fx.shells.push(hanabiShell(type));
          fx.next = rnd(2800, 5000) * slow;
        }
      }
      fx.shells = fx.shells.filter((sh) => {
        sh.y += sh.vy * dt;
        if (sh.y > 1.05) return false;
        // dye-only trail: repeated velocity splats along one line would
        // build a standing jet that streams everything to the top edge
        splatDye(sh.x + rnd(-0.002, 0.002), sh.y, inkAbsorption("#e8c87a", 0.045), 0.28);
        if (sh.y >= sh.ty) {
          hanabiBurst(sh);
          return false;
        }
        return true;
      });
      // petal streaks: draw the expanding shell for ~half a second
      fx.bursts = (fx.bursts || []).filter((b) => {
        b.age += dt;
        if (b.age > 0.5) return false;
        const asp = innerWidth / innerHeight;
        if (b.kind === "katamono") {
          const s = 0.05 + b.age * 0.09;
          for (const p of b.pts) {
            splatDye(b.x + (p[0] * s) / asp, b.y + p[1] * s, inkAbsorption(b.color, 0.08), 0.15);
          }
        } else {
          const R = 0.015 + b.age * (b.kind === "small" ? 0.22 : 0.3);
          for (let k = 0; k < b.n; k++) {
            const a = b.half ? (k / (b.n - 1)) * Math.PI : (k / b.n) * Math.PI * 2;
            splatDye(
              b.x + (Math.cos(a) * R) / asp,
              b.y + Math.sin(a) * R,
              inkAbsorption(k % 2 ? b.color : b.color2, 0.07),
              0.12
            );
          }
        }
        return true;
      });
      if (fx.tezutsu) {
        fx.tezutsu.t -= dt;
        const tz = fx.tezutsu;
        // sparks scattered along a short cone above the tube, falling back
        for (let i = 0; i < 3; i++) {
          const spread = rnd(-0.06, 0.06);
          const h = Math.abs(rnd(0, 1) * rnd(0, 1)) * 0.3; // denser near the tube
          splatDye(
            tz.x + spread * (0.3 + h * 2.5),
            0.05 + h,
            inkAbsorption(Math.random() < 0.8 ? "#f2c14e" : "#f8e6a0", 0.1),
            rnd(0.25, 0.5)
          );
        }
        const a = Math.PI / 2 + rnd(-0.55, 0.55);
        splatVelocity(tz.x, 0.08, Math.cos(a) * 110, Math.sin(a) * 110, 1.4);
        if (tz.t <= 0) delete fx.tezutsu;
      }
    },

    starry(now, dt) {
      // moon and twinkling stars are drawn crisply in the display shader;
      // the fluid adds thin night mists that drift across them, plus the
      // occasional shooting star
      fx.mist = (fx.mist ?? 0) - dt * 1000;
      if (fx.mist <= 0) {
        splatDye(Math.random(), rnd(0.45, 0.95), inkAbsorption(dark ? "#8d94a8" : "#9aa0b4", 0.05), rnd(5, 10));
        fx.mist = rnd(700, 1400) * slow;
      }
      fx.list = fx.list || [];
      fx.shoot = (fx.shoot ?? 4000) - dt * 1000;
      if (fx.shoot <= 0) {
        fx.list.push({ x: rnd(0.2, 0.9), y: rnd(0.8, 0.95), vx: -rnd(0.5, 0.8), vy: -rnd(0.15, 0.3), life: 0.7 });
        fx.shoot = rnd(7000, 14000) * slow;
      }
      fx.list = fx.list.filter((s) => {
        s.life -= dt;
        s.x += s.vx * dt * 0.9;
        s.y += s.vy * dt * 0.9;
        if (s.life <= 0) return false;
        splatDye(s.x, s.y, inkAbsorption(dark ? "#ffffff" : "#8a86c8", 0.12), 0.4);
        splatVelocity(s.x, s.y, s.vx * 150, s.vy * 150, 1);
        return true;
      });
      fx.drift = (fx.drift ?? 0) - dt * 1000;
      if (fx.drift <= 0) {
        splatVelocity(Math.random(), rnd(0.3, 0.9), rnd(-18, 18), rnd(-6, 6), 16);
        fx.drift = rnd(900, 1600);
      }
    },
  };

  function autoUpdate(now, dt) {
    if (effect === "random") {
      fx.switch = (fx.switch ?? 1) - dt * 1000;
      if (fx.switch <= 0) {
        const names = Object.keys(CHOREO).filter((n) => n !== randomCurrent);
        randomCurrent = names[Math.floor(Math.random() * names.length)];
        fx = { switch: rnd(20000, 35000) };
        washing = 0.8;
      }
    }
    (CHOREO[activeEffect()] || CHOREO.suminagashi)(now, dt);
  }

  let washing = 0;

  function step(dt) {
    const P = EFFECT_PARAMS[activeEffect()] || EFFECT_PARAMS.suminagashi;

    curlMat.uniforms.uVelocity.value = velocity.read.texture;
    curlMat.uniforms.uTexel.value.copy(velocity.texel);
    blit(curlMat, curlRT);

    vorticityMat.uniforms.uVelocity.value = velocity.read.texture;
    vorticityMat.uniforms.uCurl.value = curlRT.texture;
    vorticityMat.uniforms.uTexel.value.copy(velocity.texel);
    vorticityMat.uniforms.uCurlStrength.value = P.curl;
    vorticityMat.uniforms.uDt.value = dt;
    blit(vorticityMat, velocity.write);
    velocity.swap();

    divergeMat.uniforms.uVelocity.value = velocity.read.texture;
    divergeMat.uniforms.uTexel.value.copy(velocity.texel);
    blit(divergeMat, divergeRT);

    clearMat.uniforms.uTexture.value = pressure.read.texture;
    clearMat.uniforms.uValue.value = 0.8;
    blit(clearMat, pressure.write);
    pressure.swap();

    pressureMat.uniforms.uDivergence.value = divergeRT.texture;
    pressureMat.uniforms.uTexel.value.copy(velocity.texel);
    for (let i = 0; i < CONFIG.PRESSURE_ITER; i++) {
      pressureMat.uniforms.uPressure.value = pressure.read.texture;
      blit(pressureMat, pressure.write);
      pressure.swap();
    }

    gradientMat.uniforms.uPressure.value = pressure.read.texture;
    gradientMat.uniforms.uVelocity.value = velocity.read.texture;
    gradientMat.uniforms.uTexel.value.copy(velocity.texel);
    blit(gradientMat, velocity.write);
    velocity.swap();

    advectMat.uniforms.uVelocity.value = velocity.read.texture;
    advectMat.uniforms.uSource.value = velocity.read.texture;
    advectMat.uniforms.uTexel.value.copy(velocity.texel);
    advectMat.uniforms.uDt.value = dt;
    advectMat.uniforms.uDissipation.value = CONFIG.VEL_DISSIPATION;
    blit(advectMat, velocity.write);
    velocity.swap();

    advectMat.uniforms.uVelocity.value = velocity.read.texture;
    advectMat.uniforms.uSource.value = dye.read.texture;
    advectMat.uniforms.uTexel.value.copy(dye.texel);
    advectMat.uniforms.uDissipation.value = P.dye + (washing > 0 ? 2.4 : 0);
    blit(advectMat, dye.write);
    dye.swap();

    if (washing > 0) washing -= dt;
  }

  let raf = 0;
  let lastT = performance.now();
  function frame(now) {
    raf = requestAnimationFrame(frame);
    let dt = (now - lastT) / 1000;
    lastT = now;
    dt = Math.min(dt, 1 / 30);
    if (dt <= 0) return;

    applyPointer();
    autoUpdate(now, dt);
    step(dt);

    displayMat.uniforms.uDye.value = dye.read.texture;
    displayMat.uniforms.uStarry.value = activeEffect() === "starry" ? 1 : 0;
    displayMat.uniforms.uTime.value = now * 0.001;
    displayMat.uniforms.uAspect.value = innerWidth / innerHeight;
    blit(displayMat, null);
  }

  function seed() {
    dropInk(0.38, 0.58, palette.inks[0], 0.75);
    setTimeout(() => dropInk(0.62, 0.42, palette.inks[1], 0.6), 450);
    setTimeout(() => dropInk(0.5, 0.62, palette.inks[2], 0.5), 950);
  }

  // Resize a double-FBO without losing its contents: render the old texture
  // into freshly allocated targets (three.js setSize would wipe them).
  function resizePreserving(fbo, nw, nh) {
    const newRead = makeRT(nw, nh);
    clearMat.uniforms.uTexture.value = fbo.read.texture;
    clearMat.uniforms.uValue.value = 1.0;
    blit(clearMat, newRead);
    fbo.read.dispose();
    fbo.write.dispose();
    fbo.read = newRead;
    fbo.write = makeRT(nw, nh);
    fbo.texel.set(1 / nw, 1 / nh);
  }

  // Mobile browsers fire resize while scrolling (URL bar collapse/expand);
  // debounce, skip no-ops, and preserve the ink across real resizes.
  let lastW = innerWidth;
  let lastH = innerHeight;
  let resizeTimer = 0;
  function applyResize() {
    if (innerWidth === lastW && innerHeight === lastH) return;
    lastW = innerWidth;
    lastH = innerHeight;
    renderer.setSize(innerWidth, innerHeight);
    S = simSizes();
    resizePreserving(velocity, S.sw, S.sh);
    resizePreserving(pressure, S.sw, S.sh);
    resizePreserving(dye, S.dw, S.dh);
    curlRT.setSize(S.sw, S.sh);
    divergeRT.setSize(S.sw, S.sh);
  }
  function onResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(applyResize, 200);
  }
  addEventListener("resize", onResize);

  if (activeEffect() === "suminagashi") seed();
  raf = requestAnimationFrame(frame);

  // console access: window.__sumi.setEffect('aurora'), .effects, .tick(n)
  window.__sumi = {
    setEffect,
    getEffect: () => effect,
    effects: [...Object.keys(CHOREO), "random"],
    forceHanabi: (t) => {
      fx.forceType = t; // e.g. 'warimono' — call after setEffect('hanabi')
    },
    // drive n frames manually (e.g. when rAF is suspended in hidden tabs)
    tick(n = 60) {
      for (let i = 0; i < n; i++) {
        cancelAnimationFrame(raf);
        lastT -= 1000 / 60;
        frame(performance.now());
      }
    },
  };

  return {
    setDark(isDark) {
      if (isDark === dark) return;
      dark = isDark;
      palette = PALETTES[dark ? "dark" : "light"];
      const p = new THREE.Color(palette.paper);
      displayMat.uniforms.uPaper.value.set(p.r, p.g, p.b);
      displayMat.uniforms.uDark.value = dark ? 1 : 0;
      // wash away the old ink (its absorbance encodes the other mode's colors)
      washing = 1.6;
      setTimeout(seed, 1400);
    },
    dispose() {
      cancelAnimationFrame(raf);
      clearTimeout(resizeTimer);
      delete window.__sumi;
      removeEventListener("set-bg-effect", onSetEffect);
      removeEventListener("pointermove", onPointerMove);
      removeEventListener("pointerdown", onPointerDown);
      removeEventListener("resize", onResize);
      [velocity, dye, pressure].forEach((f) => f.dispose());
      curlRT.dispose();
      divergeRT.dispose();
      quad.geometry.dispose();
      [advectMat, splatMat, curlMat, vorticityMat, divergeMat, pressureMat, gradientMat, clearMat, displayMat].forEach(
        (m) => m.dispose()
      );
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}

export default function SuminagashiBackground() {
  const mountRef = useRef(null);
  const apiRef = useRef(null);
  const { theme } = useTheme();

  useEffect(() => {
    const api = createSim(mountRef.current);
    apiRef.current = api;
    return () => {
      api.dispose();
      apiRef.current = null;
    };
  }, []);

  useEffect(() => {
    apiRef.current?.setDark(theme === "dark");
  }, [theme]);

  return <div ref={mountRef} className="fixed inset-0 -z-10 pointer-events-none" aria-hidden="true" />;
}
