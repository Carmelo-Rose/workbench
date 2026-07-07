"use client";

import { useEffect, useRef } from "react";
import type { FC } from "react";

/**
 * 墨点精灵 — Mono 原生桌宠。一小团墨点组成的生物，慵懒地尾随光标，
 * 光标停下几秒后飘回右下角的"窝"打盹（呼吸起伏），偶尔眨眼，
 * 移动时在身后留下一串淡出的墨迹。与欢迎屏的墨海粒子场同一视觉语言。
 *
 * 纯 canvas 2D、零依赖、主题自适应；prefers-reduced-motion 下只静置一帧。
 */

const DOTS = 24;
const TRAIL = 14;

const resolveInk = (host: HTMLElement): [number, number, number] => {
  const probe = document.createElement("span");
  probe.style.color = "var(--foreground)";
  probe.style.display = "none";
  host.appendChild(probe);
  const css = getComputedStyle(probe).color;
  probe.remove();
  const cv = document.createElement("canvas");
  cv.width = cv.height = 1;
  const ctx = cv.getContext("2d");
  if (!ctx) return [30, 30, 35];
  ctx.fillStyle = css;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return [r, g, b];
};

export const InkWispPet: FC = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    let dpr = 1;
    let ink: [number, number, number] = [30, 30, 35];

    const home = () => ({
      x: window.innerWidth - 90,
      y: window.innerHeight - 110,
    });

    // body dots: stable radial offsets + per-dot phase for jitter
    const dots = Array.from({ length: DOTS }, (_, i) => {
      const a = (i / DOTS) * Math.PI * 2 + Math.sin(i * 7.3) * 1.7;
      const r = Math.abs(Math.sin(i * 3.1)) * 7 + 1.5;
      return {
        ox: Math.cos(a) * r,
        oy: Math.sin(a) * r * 0.85,
        size: 1 + Math.abs(Math.sin(i * 5.7)) * 1.8,
        phase: i * 2.4,
      };
    });

    const start = home();
    const state = {
      x: start.x,
      y: start.y,
      vx: 0,
      vy: 0,
      mouseX: start.x,
      mouseY: start.y,
      lastMove: 0,
      blinkUntil: 0,
      nextBlink: performance.now() + 2500,
      facing: 1,
    };
    const trail: { x: number; y: number; t: number }[] = [];

    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(window.innerWidth * dpr);
      canvas.height = Math.round(window.innerHeight * dpr);
    };

    const applyTheme = () => {
      ink = resolveInk(canvas.parentElement ?? document.body);
    };

    const draw = (t: number) => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
      const [r, g, b] = ink;

      // fading ink trail
      for (const p of trail) {
        const age = (t - p.t) / 900;
        if (age >= 1) continue;
        ctx.fillStyle = `rgba(${r},${g},${b},${(0.25 * (1 - age)).toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 1.6 * (1 - age * 0.5), 0, Math.PI * 2);
        ctx.fill();
      }

      const speed = Math.hypot(state.vx, state.vy);
      const stretch = Math.min(speed * 0.04, 0.45);
      const breathe = 1 + Math.sin(t / 900) * 0.05;

      // body
      for (const d of dots) {
        const jx = Math.sin(t / 260 + d.phase) * 0.9;
        const jy = Math.cos(t / 310 + d.phase) * 0.9;
        const x = state.x + (d.ox * (1 + stretch) + jx) * breathe;
        const y = state.y + (d.oy * (1 - stretch * 0.5) + jy) * breathe;
        ctx.fillStyle = `rgba(${r},${g},${b},0.85)`;
        ctx.beginPath();
        ctx.arc(x, y, d.size, 0, Math.PI * 2);
        ctx.fill();
      }

      // eyes: punched out of the ink (background shows through)
      if (t > state.blinkUntil) {
        ctx.save();
        ctx.globalCompositeOperation = "destination-out";
        const ey = state.y - 1.5;
        const ex = state.x + state.facing * 2.2;
        for (const side of [-1, 1]) {
          ctx.beginPath();
          ctx.arc(ex + side * 3.1, ey, 1.25, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      }
    };

    let raf = 0;
    let last: number | null = null;

    const tick = (t: number) => {
      if (!canvas.isConnected) return;
      const dt = last === null ? 16 : Math.min(t - last, 64);
      last = t;

      const dozing = t - state.lastMove > 4500;
      const target = dozing
        ? {
            x: home().x + Math.sin(t / 1600) * 10,
            y: home().y + Math.cos(t / 1300) * 6,
          }
        : { x: state.mouseX + 26, y: state.mouseY + 30 };

      const k = dozing ? 0.012 : 0.03;
      state.vx += (target.x - state.x) * k * (dt / 16);
      state.vy += (target.y - state.y) * k * (dt / 16);
      state.vx *= 0.88;
      state.vy *= 0.88;
      state.x += state.vx * (dt / 16);
      state.y += state.vy * (dt / 16);
      if (Math.abs(state.vx) > 0.4) state.facing = state.vx > 0 ? 1 : -1;

      if (Math.hypot(state.vx, state.vy) > 1.2) {
        const lastP = trail[trail.length - 1];
        if (!lastP || t - lastP.t > 70) {
          trail.push({ x: state.x, y: state.y + 4, t });
          if (trail.length > TRAIL) trail.shift();
        }
      }

      if (t > state.nextBlink) {
        state.blinkUntil = t + 130;
        state.nextBlink = t + 2200 + Math.random() * 3800;
      }

      draw(t);
      raf = requestAnimationFrame(tick);
    };

    const onMouseMove = (e: MouseEvent) => {
      state.mouseX = e.clientX;
      state.mouseY = e.clientY;
      state.lastMove = performance.now();
    };

    const themeObserver = new MutationObserver(applyTheme);

    resize();
    applyTheme();
    draw(performance.now());

    if (!reduced.matches) {
      window.addEventListener("mousemove", onMouseMove, { passive: true });
      window.addEventListener("resize", resize);
      themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["class"],
      });
      raf = requestAnimationFrame(tick);
    }

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("resize", resize);
      themeObserver.disconnect();
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      data-slot="mono_pet-ink-wisp"
      className="pointer-events-none fixed inset-0 z-40 h-full w-full"
    />
  );
};
