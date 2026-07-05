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
    uniform float uDark;

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
    meteor: { dye: 0.5, curl: 14 },
    ocean: { dye: 0.45, curl: 12 },
    cloud: { dye: 0.12, curl: 6 },
    fire: { dye: 1.4, curl: 30 },
    galaxy: { dye: 1.0, curl: 8 },
    ripple: { dye: 0.2, curl: 16 },
    breathing: { dye: 0.5, curl: 8 },
    rainbowCycle: { dye: 0.06, curl: 24 },
    rainbowWave: { dye: 0.35, curl: 12 },
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
      for (let i = 0; i < 3; i++) {
        const x = Math.random();
        fx.band = ((fx.band ?? 0) + 1) % 3;
        const y = 0.14 + fx.band * 0.11 + 0.07 * Math.sin(x * 9 - now * 0.0011 + fx.band * 1.8);
        splatDye(x, y, inkAbsorption(hsl(0.55 + 0.06 * fx.band, 0.7, dark ? 0.6 : 0.4), 0.03), rnd(2, 4.5));
      }
      fx.surge = (fx.surge ?? 0) - dt * 1000;
      if (fx.surge <= 0) {
        const x = Math.random();
        splatVelocity(x, rnd(0.1, 0.4), Math.cos(now * 0.0009) * 140, Math.sin(x * 9 - now * 0.0011) * 60, 12);
        fx.surge = rnd(200, 500) * slow;
      }
    },

    cloud(now, dt) {
      fx.puff = (fx.puff ?? 0) - dt * 1000;
      if (fx.puff <= 0) {
        splatDye(Math.random(), rnd(0.55, 0.92), inkAbsorption(dark ? "#d9d6cf" : "#9aa0ab", 0.16), rnd(8, 16));
        fx.puff = rnd(500, 1100) * slow;
      }
      fx.wind = (fx.wind ?? 0) - dt * 1000;
      if (fx.wind <= 0) {
        splatVelocity(Math.random(), rnd(0.5, 0.95), 60 + Math.sin(now * 0.0002) * 40, rnd(-8, 8), 18);
        fx.wind = rnd(400, 900);
      }
    },

    fire(now, dt) {
      for (let i = 0; i < 2; i++) {
        const x = 0.5 + (Math.random() - 0.5) * rnd(0.2, 0.85);
        const r = Math.random();
        const hex = r < 0.45 ? "#d43a0f" : r < 0.8 ? "#f28b1c" : "#f6d43c";
        splatDye(x, rnd(0.02, 0.1), inkAbsorption(hex, 0.09), rnd(1, 2.6));
      }
      fx.buoy = (fx.buoy ?? 0) - dt * 1000;
      if (fx.buoy <= 0) {
        splatVelocity(0.5 + (Math.random() - 0.5) * 0.8, rnd(0.05, 0.25), rnd(-50, 50), rnd(220, 380), rnd(2, 5));
        fx.buoy = rnd(80, 200) * slow;
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
      fx.list = fx.list || [];
      fx.spawn = (fx.spawn ?? 400) - dt * 1000;
      if (fx.spawn <= 0) {
        fx.list.push({ x: rnd(0.15, 0.85), y: rnd(0.2, 0.8), age: 0, hue: Math.random() });
        fx.spawn = rnd(1400, 2600) * slow;
      }
      const asp = innerWidth / innerHeight;
      fx.list = fx.list.filter((rp) => {
        rp.age += dt;
        if (rp.age > 1.3) return false;
        const R = rp.age * 0.28;
        for (let k = 0; k < 6; k++) {
          const a = (k / 6) * Math.PI * 2 + rp.age * 2;
          const x = rp.x + (Math.cos(a) * R) / asp;
          const y = rp.y + Math.sin(a) * R;
          splatVelocity(x, y, Math.cos(a) * 120 * (1.3 - rp.age), Math.sin(a) * 120 * (1.3 - rp.age), 3);
          if (k % 2 === 0) splatDye(x, y, inkAbsorption(hsl(rp.hue, 0.55, dark ? 0.65 : 0.45), 0.03), 1.4);
        }
        return true;
      });
    },

    breathing(now, dt) {
      const phase = Math.sin(now * 0.00045); // >0 exhale, <0 inhale
      fx.hue = (fx.hue ?? Math.random()) + dt * 0.008;
      if (phase > 0.1) {
        splatDye(0.5, 0.5, inkAbsorption(hsl(fx.hue, 0.6, dark ? 0.62 : 0.45), 0.022 * phase), 12);
      }
      fx.pulse = (fx.pulse ?? 0) - dt * 1000;
      if (fx.pulse <= 0) {
        const asp = innerWidth / innerHeight;
        for (let k = 0; k < 6; k++) {
          const a = (k / 6) * Math.PI * 2 + now * 0.0001;
          splatVelocity(
            0.5 + (Math.cos(a) * 0.16) / asp,
            0.5 + Math.sin(a) * 0.16,
            Math.cos(a) * 110 * phase,
            Math.sin(a) * 110 * phase,
            6
          );
        }
        fx.pulse = rnd(150, 350) * slow;
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
          inkAbsorption(hsl(now * 0.00005 + y * 0.25, 0.85, dark ? 0.6 : 0.45), 0.05),
          rnd(1.5, 3)
        );
      }
      fx.push = (fx.push ?? 0) - dt * 1000;
      if (fx.push <= 0) {
        splatVelocity(front, Math.random(), 160, rnd(-30, 30), 10);
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
