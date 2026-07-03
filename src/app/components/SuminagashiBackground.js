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
    splatDye(x, y, inkAbsorption(hex, strength * 0.18), 1.0);
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

  /* auto: periodic drops and a slow circulating current */
  let lastInteraction = 0;
  let nextDrop = 1200;
  let nextStir = 2600;
  function autoUpdate(now, dt) {
    const idle = now - lastInteraction > 3000;

    nextDrop -= dt * 1000;
    if (idle && nextDrop <= 0) {
      const x = 0.14 + Math.random() * 0.72;
      const y = 0.16 + Math.random() * 0.68;
      dropInk(x, y, randomInk(), 0.8 + Math.random() * 0.7);
      if (Math.random() < 0.3) {
        const x2 = Math.min(Math.max(x + (Math.random() - 0.5) * 0.16, 0.08), 0.92);
        const y2 = Math.min(Math.max(y + (Math.random() - 0.5) * 0.16, 0.08), 0.92);
        setTimeout(() => dropInk(x2, y2, randomInk(), 0.5 + Math.random() * 0.4), 220 + Math.random() * 300);
      }
      nextDrop = (reducedMotion ? 6500 : 2600) + Math.random() * 2600;
    }

    nextStir -= dt * 1000;
    if (!reducedMotion && nextStir <= 0) {
      const t = now * 0.00012;
      const cx = 0.5 + Math.sin(t * 1.7) * 0.3;
      const cy = 0.5 + Math.cos(t * 1.1) * 0.3;
      const a = t * 6.0 + Math.random() * 1.5;
      splatVelocity(cx, cy, Math.cos(a) * 130, Math.sin(a) * 130, 14);
      nextStir = 700 + Math.random() * 900;
    }
  }

  let washing = 0;

  function step(dt) {
    curlMat.uniforms.uVelocity.value = velocity.read.texture;
    curlMat.uniforms.uTexel.value.copy(velocity.texel);
    blit(curlMat, curlRT);

    vorticityMat.uniforms.uVelocity.value = velocity.read.texture;
    vorticityMat.uniforms.uCurl.value = curlRT.texture;
    vorticityMat.uniforms.uTexel.value.copy(velocity.texel);
    vorticityMat.uniforms.uCurlStrength.value = CONFIG.CURL;
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
    advectMat.uniforms.uDissipation.value = CONFIG.DYE_DISSIPATION + (washing > 0 ? 2.4 : 0);
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

  seed();
  raf = requestAnimationFrame(frame);

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
