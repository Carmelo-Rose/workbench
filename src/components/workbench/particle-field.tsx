"use client";

import { useEffect, useRef } from "react";
import type { FC } from "react";

/**
 * Mono ink field — a GPU particle sea rendered behind the empty-thread
 * welcome view. ~7k points on an undulating 3D plane, monochrome and
 * theme-aware. All motion runs in the vertex shader; JS only feeds
 * uniforms. Fades out (and stops rendering) once a conversation starts.
 *
 * Degrades silently: no WebGL → renders nothing, the welcome view is
 * never gated on this canvas. Honors prefers-reduced-motion with a
 * single static frame.
 */

const COLS = 130;
const ROWS = 56;
const COUNT = COLS * ROWS;
const FOV_Y = Math.PI / 4;
const PLANE_Y = -1.7;

const VERT = `
attribute vec3 a_seed;
uniform mat4 u_proj;
uniform mat4 u_view;
uniform float u_time;
uniform float u_dpr;
uniform vec2 u_pointer;
uniform float u_pointerStrength;
varying float v_fog;
varying float v_rand;
varying float v_lift;
varying float v_tw;

void main() {
  float rand = a_seed.z;
  float x = (a_seed.x - 0.5) * 17.0;
  float z = a_seed.y * 17.5 + 0.5;
  float t = u_time * 0.55;
  float y = 0.0;
  y += sin(x * 0.50 + t) * 0.20;
  y += sin(z * 0.36 - t * 0.85) * 0.26;
  y += sin((x + z) * 0.22 + t * 0.6) * 0.30;
  y += sin(length(vec2(x, z - 7.0)) * 0.65 - t * 1.3) * 0.12;
  float d = distance(vec2(x, z), u_pointer);
  float lift = exp(-d * d * 0.30) * u_pointerStrength;
  y += lift * 0.85;
  vec4 viewPos = u_view * vec4(x, y + ${PLANE_Y.toFixed(1)}, -z, 1.0);
  gl_Position = u_proj * viewPos;
  float dist = length(viewPos.xyz);
  gl_PointSize = clamp(u_dpr * (38.0 / dist) * (0.55 + 0.45 * rand), 1.0, 8.0 * u_dpr);
  v_fog = 1.0 - smoothstep(4.5, 22.0, dist);
  v_rand = rand;
  v_lift = lift;
  v_tw = 0.82 + 0.18 * sin(u_time * (0.6 + rand * 1.7) + rand * 41.0);
}
`;

const FRAG = `
precision mediump float;
uniform vec3 u_color;
uniform float u_alpha;
varying float v_fog;
varying float v_rand;
varying float v_lift;
varying float v_tw;

void main() {
  vec2 c = gl_PointCoord - 0.5;
  float m = smoothstep(0.5, 0.12, length(c));
  float a = u_alpha * v_fog * m * v_tw * (0.55 + 0.45 * v_rand);
  a += v_lift * 0.35 * m * v_fog;
  gl_FragColor = vec4(u_color, a);
}
`;

type Vec3 = [number, number, number];

const perspective = (
  out: Float32Array,
  fovy: number,
  aspect: number,
  near: number,
  far: number,
) => {
  const f = 1 / Math.tan(fovy / 2);
  out.fill(0);
  out[0] = f / aspect;
  out[5] = f;
  out[10] = (far + near) / (near - far);
  out[11] = -1;
  out[14] = (2 * far * near) / (near - far);
};

const lookAt = (out: Float32Array, eye: Vec3, target: Vec3, up: Vec3) => {
  let zx = eye[0] - target[0];
  let zy = eye[1] - target[1];
  let zz = eye[2] - target[2];
  let len = Math.hypot(zx, zy, zz);
  zx /= len;
  zy /= len;
  zz /= len;
  let xx = up[1] * zz - up[2] * zy;
  let xy = up[2] * zx - up[0] * zz;
  let xz = up[0] * zy - up[1] * zx;
  len = Math.hypot(xx, xy, xz);
  xx /= len;
  xy /= len;
  xz /= len;
  const yx = zy * xz - zz * xy;
  const yy = zz * xx - zx * xz;
  const yz = zx * xy - zy * xx;
  out.set([
    xx, yx, zx, 0,
    xy, yy, zy, 0,
    xz, yz, zz, 0,
    -(xx * eye[0] + xy * eye[1] + xz * eye[2]),
    -(yx * eye[0] + yy * eye[1] + yz * eye[2]),
    -(zx * eye[0] + zy * eye[1] + zz * eye[2]),
    1,
  ]);
};

/** Resolve any CSS color (incl. oklch vars) to linear-ish 0..1 RGB. */
const resolveColor = (cssColor: string): Vec3 => {
  const cv = document.createElement("canvas");
  cv.width = cv.height = 1;
  const ctx = cv.getContext("2d");
  if (!ctx) return [0.5, 0.5, 0.5];
  ctx.fillStyle = cssColor;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return [r / 255, g / 255, b / 255];
};

const readTheme = (host: HTMLElement) => {
  const probe = document.createElement("span");
  probe.style.color = "var(--foreground)";
  probe.style.backgroundColor = "var(--background)";
  probe.style.display = "none";
  host.appendChild(probe);
  const style = getComputedStyle(probe);
  const ink = resolveColor(style.color);
  const bg = resolveColor(style.backgroundColor);
  probe.remove();
  const dark = 0.2126 * bg[0] + 0.7152 * bg[1] + 0.0722 * bg[2] < 0.5;
  return { ink, dark };
};

type Engine = {
  setActive: (active: boolean) => void;
  destroy: () => void;
};

const createEngine = (canvas: HTMLCanvasElement): Engine | null => {
  const gl = canvas.getContext("webgl", {
    alpha: true,
    antialias: false,
    depth: false,
    stencil: false,
    powerPreference: "low-power",
  });
  if (!gl) return null;

  const compile = (type: number, src: string) => {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, src);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  };

  let program: WebGLProgram | null = null;
  let buffer: WebGLBuffer | null = null;
  let uniforms: Record<string, WebGLUniformLocation | null> = {};

  const seeds = new Float32Array(COUNT * 3);
  let i = 0;
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      // deterministic hash keeps the field stable across re-inits
      const h = Math.abs(Math.sin(c * 12.9898 + r * 78.233) * 43758.5453) % 1;
      seeds[i++] = (c + (h - 0.5) * 0.9) / COLS;
      seeds[i++] = (r + (h * 7 - Math.floor(h * 7) - 0.5) * 0.9) / ROWS;
      seeds[i++] = h;
    }
  }

  const setup = () => {
    const vs = compile(gl.VERTEX_SHADER, VERT);
    const fs = compile(gl.FRAGMENT_SHADER, FRAG);
    if (!vs || !fs) return false;
    program = gl.createProgram()!;
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return false;
    gl.useProgram(program);

    buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, seeds, gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(program, "a_seed");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 3, gl.FLOAT, false, 0, 0);

    uniforms = {};
    for (const name of [
      "u_proj",
      "u_view",
      "u_time",
      "u_dpr",
      "u_pointer",
      "u_pointerStrength",
      "u_color",
      "u_alpha",
    ]) {
      uniforms[name] = gl.getUniformLocation(program!, name);
    }
    gl.enable(gl.BLEND);
    gl.clearColor(0, 0, 0, 0);
    return true;
  };

  if (!setup()) return null;

  const proj = new Float32Array(16);
  const view = new Float32Array(16);
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  let dpr = 1;
  let aspect = 1;
  let active = false;
  let opacity = 0;
  let time = 0;
  let lastNow: number | null = null;
  let raf = 0;
  let running = false;
  let contextLost = false;
  let dark = false;

  // pointer state, eased toward targets each frame
  const pointer = { x: 0, z: 9, tx: 0, tz: 9, strength: 0, tStrength: 0 };

  const applyTheme = () => {
    const theme = readTheme(canvas.parentElement ?? document.body);
    dark = theme.dark;
    gl.useProgram(program);
    gl.uniform3fv(uniforms.u_color, theme.ink);
    gl.uniform1f(uniforms.u_alpha, dark ? 0.55 : 0.6);
  };

  const resize = () => {
    dpr = Math.min(window.devicePixelRatio || 1, 1.75);
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    gl.viewport(0, 0, w, h);
    aspect = w / h;
    perspective(proj, FOV_Y, aspect, 0.1, 40);
  };

  const eye: Vec3 = [0, 1.35, 3.4];
  const target: Vec3 = [0, -0.9, -7];

  const frame = () => {
    if (contextLost) return;
    const now = performance.now();
    const dt = lastNow === null ? 0 : Math.min((now - lastNow) / 1000, 0.1);
    lastNow = now;
    if (!reducedMotion.matches) time += dt;

    // ease opacity / pointer
    const fade = active ? 1 : 0;
    opacity += (fade - opacity) * Math.min(1, dt * 4.5);
    if (!active && opacity < 0.01) {
      opacity = 0;
      stop();
    }
    canvas.style.opacity = opacity.toFixed(3);
    pointer.x += (pointer.tx - pointer.x) * Math.min(1, dt * 6);
    pointer.z += (pointer.tz - pointer.z) * Math.min(1, dt * 6);
    pointer.strength +=
      (pointer.tStrength - pointer.strength) * Math.min(1, dt * 4);

    // camera parallax follows the eased pointer
    const px = pointer.x / 8.5;
    const camEye: Vec3 = [
      eye[0] + px * 0.4 * pointer.strength,
      eye[1] - (pointer.z - 9) * 0.012 * pointer.strength,
      eye[2],
    ];
    lookAt(view, camEye, target, [0, 1, 0]);

    gl.useProgram(program);
    gl.blendFunc(gl.SRC_ALPHA, dark ? gl.ONE : gl.ONE_MINUS_SRC_ALPHA);
    gl.uniformMatrix4fv(uniforms.u_proj, false, proj);
    gl.uniformMatrix4fv(uniforms.u_view, false, view);
    gl.uniform1f(uniforms.u_time, time === 0 ? 3 : time);
    gl.uniform1f(uniforms.u_dpr, dpr);
    gl.uniform2f(uniforms.u_pointer, pointer.x, pointer.z);
    gl.uniform1f(uniforms.u_pointerStrength, pointer.strength);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.POINTS, 0, COUNT);

    if (running) raf = requestAnimationFrame(frame);
  };

  const start = () => {
    if (running || contextLost) return;
    running = true;
    lastNow = null;
    raf = requestAnimationFrame(frame);
  };

  const stop = () => {
    running = false;
    cancelAnimationFrame(raf);
  };

  const shouldRun = () =>
    !document.hidden && (active || opacity > 0.01) && !reducedMotion.matches;

  const sync = () => {
    if (reducedMotion.matches) {
      // static alternative: single frame, no loop, instant opacity
      stop();
      opacity = active ? 1 : 0;
      canvas.style.opacity = String(opacity);
      if (active) {
        lastNow = null;
        frame();
        stop();
      }
      return;
    }
    if (shouldRun()) start();
    else if (document.hidden) stop();
  };

  const onPointerMove = (e: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0) return;
    const nx = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const ny = -(((e.clientY - rect.top) / rect.height) * 2 - 1);
    const inside = nx >= -1 && nx <= 1 && ny >= -1 && ny <= 1;
    pointer.tStrength = inside ? 1 : 0;
    if (!inside) return;
    // ray from camera through NDC onto the resting plane
    const tanHalf = Math.tan(FOV_Y / 2);
    const dirX = nx * tanHalf * aspect;
    const dirY = ny * tanHalf;
    const dirZ = -1;
    if (dirY + (PLANE_Y - eye[1]) === 0) return;
    const t = (PLANE_Y - eye[1]) / dirY;
    if (t <= 0) return;
    pointer.tx = eye[0] + dirX * t;
    pointer.tz = Math.min(18, Math.max(0.5, -(eye[2] + dirZ * t)));
  };

  const onPointerLeave = () => {
    pointer.tStrength = 0;
  };

  const onContextLost = (e: Event) => {
    e.preventDefault();
    contextLost = true;
    stop();
  };

  const onContextRestored = () => {
    contextLost = false;
    if (setup()) {
      resize();
      applyTheme();
      sync();
    }
  };

  const ro = new ResizeObserver(() => {
    resize();
    if (!running && opacity > 0) frame(); // repaint static frame after resize
  });
  ro.observe(canvas);

  const themeObserver = new MutationObserver(applyTheme);
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  });

  window.addEventListener("pointermove", onPointerMove, { passive: true });
  window.addEventListener("pointerleave", onPointerLeave);
  document.addEventListener("visibilitychange", sync);
  reducedMotion.addEventListener("change", sync);
  canvas.addEventListener("webglcontextlost", onContextLost);
  canvas.addEventListener("webglcontextrestored", onContextRestored);

  resize();
  applyTheme();

  return {
    setActive(next: boolean) {
      if (active === next) return;
      active = next;
      sync();
    },
    destroy() {
      stop();
      ro.disconnect();
      themeObserver.disconnect();
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerleave", onPointerLeave);
      document.removeEventListener("visibilitychange", sync);
      reducedMotion.removeEventListener("change", sync);
      canvas.removeEventListener("webglcontextlost", onContextLost);
      canvas.removeEventListener("webglcontextrestored", onContextRestored);
      // Intentionally no loseContext(): StrictMode remounts reuse this
      // canvas, and getContext would hand back the same (dead) context.
    },
  };
};

export const ParticleField: FC<{ active: boolean }> = ({ active }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<Engine | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    engineRef.current = createEngine(canvas);
    return () => {
      engineRef.current?.destroy();
      engineRef.current = null;
    };
  }, []);

  useEffect(() => {
    engineRef.current?.setActive(active);
  }, [active]);

  return (
    <canvas
      ref={canvasRef}
      data-slot="mono_particle-field"
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 h-full w-full [mask-image:radial-gradient(115%_100%_at_50%_38%,black_30%,transparent_82%)]"
      style={{ opacity: 0 }}
    />
  );
};
