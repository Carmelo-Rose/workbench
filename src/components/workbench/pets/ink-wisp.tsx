"use client";

import { useEffect, useRef } from "react";
import type { FC } from "react";
import {
  resolveThemeColor,
  type RGB,
} from "@/components/workbench/pets/canvas-color";
import { createComposerZone } from "@/components/workbench/pets/composer-zone";

/**
 * 墨点精灵 — Mono 原生桌宠。一小团墨点组成的生物，慵懒地尾随光标，
 * 光标停下几秒后飘回右下角的"窝"打盹（呼吸起伏），偶尔眨眼，
 * 移动时在身后留下一串淡出的墨迹。与欢迎屏的墨海粒子场同一视觉语言。
 *
 * 灵魂感：
 * - 好奇心：光标停下后不总是直接回窝，偶尔先飘到光标附近绕一小圈"打量"再走；
 * - 自主性：长时间无输入时偶尔离窝出门闲逛到随机位置（避开输入框禁区），
 *   驻足片刻再回窝；
 * - 表情：打盹落定后眼睛半闭成扁缝；快速移动后落定时抖一下身体；
 *   不追光标时偶尔看向随机方向。
 *
 * 纯 canvas 2D、零依赖、主题自适应；prefers-reduced-motion 下只静置一帧。
 */

const DOTS = 24;
const TRAIL = 14;

/** 行为状态机：跟随 → (好奇打量) → 打盹 ⇄ 出门闲逛 */
type WispMode =
  | "follow" // 跟随光标
  | "inspect" // 好奇：绕光标打量一小圈
  | "doze" // 回窝打盹
  | "wanderOut" // 闲逛：去程
  | "wanderPause" // 闲逛：中途驻足
  | "wanderBack"; // 闲逛：返程

export const InkWispPet: FC = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const zone = createComposerZone();
    let dpr = 1;
    let ink: RGB = [30, 30, 35];

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
    const now0 = performance.now();
    const state = {
      x: start.x,
      y: start.y,
      vx: 0,
      vy: 0,
      mouseX: start.x,
      mouseY: start.y,
      lastMove: 0,
      blinkUntil: 0,
      nextBlink: now0 + 2500,
      facing: 1,
      mode: "doze" as WispMode,
      modeUntil: 0,
      inspectAngle: 0,
      inspectDir: 1,
      nextWander: now0 + 14000 + Math.random() * 20000,
      wanderX: start.x,
      wanderY: start.y,
      // 落定抖动：快速移动后停下的那几帧
      wasFast: false,
      shakeUntil: 0,
      // 眼神：不追光标时偶尔瞟向随机方向（当前值向目标缓动）
      glanceX: 0,
      glanceY: 0,
      glanceTX: 0,
      glanceTY: 0,
      glanceUntil: 0,
      nextGlance: now0 + 4000,
    };
    const trail: { x: number; y: number; t: number }[] = [];

    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(window.innerWidth * dpr);
      canvas.height = Math.round(window.innerHeight * dpr);
    };

    const applyTheme = () => {
      ink = resolveThemeColor(canvas.parentElement ?? document.body, "var(--foreground)", [
        30, 30, 35,
      ]);
    };

    /** 挑一个闲逛落点：避开输入框禁区，挑不到就作罢回窝 */
    const pickWanderPoint = (t: number) => {
      const m = 60;
      for (let i = 0; i < 8; i += 1) {
        const x = m + Math.random() * Math.max(1, window.innerWidth - m * 2);
        const y = m + Math.random() * Math.max(1, window.innerHeight - m * 2);
        if (!zone.contains(t, x, y)) return { x, y };
      }
      return home();
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

      // 落定抖动：高频小幅，随剩余时间衰减
      let sx = state.x;
      let sy = state.y;
      if (t < state.shakeUntil) {
        const decay = (state.shakeUntil - t) / 260;
        sx += Math.sin(t * 0.11) * 1.8 * decay;
        sy += Math.cos(t * 0.13) * 1.1 * decay;
      }

      // body
      for (const d of dots) {
        const jx = Math.sin(t / 260 + d.phase) * 0.9;
        const jy = Math.cos(t / 310 + d.phase) * 0.9;
        const x = sx + (d.ox * (1 + stretch) + jx) * breathe;
        const y = sy + (d.oy * (1 - stretch * 0.5) + jy) * breathe;
        ctx.fillStyle = `rgba(${r},${g},${b},0.85)`;
        ctx.beginPath();
        ctx.arc(x, y, d.size, 0, Math.PI * 2);
        ctx.fill();
      }

      // eyes: punched out of the ink (background shows through)
      if (t > state.blinkUntil) {
        ctx.save();
        ctx.globalCompositeOperation = "destination-out";
        const ey = sy - 1.5 + state.glanceY;
        const ex = sx + state.facing * 2.2 + state.glanceX;
        // 打盹落定后半闭眼：扁椭圆代替圆
        const dozy = state.mode === "doze" && speed < 0.6;
        for (const side of [-1, 1]) {
          ctx.beginPath();
          if (dozy) {
            ctx.ellipse(ex + side * 3.1, ey + 0.4, 1.5, 0.55, 0, 0, Math.PI * 2);
          } else {
            ctx.arc(ex + side * 3.1, ey, 1.25, 0, Math.PI * 2);
          }
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

      const idleFor = t - state.lastMove;

      // ── 状态流转 ──────────────────────────────────────
      if (idleFor < 400) {
        // 光标一动，什么都放下先跟上去
        state.mode = "follow";
      } else if (state.mode === "follow" && idleFor > 4500) {
        // 光标停下：偶尔先凑近打量一圈，否则直接回窝
        if (Math.random() < 0.45) {
          state.mode = "inspect";
          state.modeUntil = t + 1500 + Math.random() * 1300;
          state.inspectAngle = Math.random() * Math.PI * 2;
          state.inspectDir = Math.random() < 0.5 ? 1 : -1;
        } else {
          state.mode = "doze";
          state.nextWander = t + 16000 + Math.random() * 24000;
        }
      } else if (state.mode === "inspect") {
        state.inspectAngle += state.inspectDir * 0.0022 * dt;
        if (t > state.modeUntil) {
          state.mode = "doze";
          state.nextWander = t + 16000 + Math.random() * 24000;
        }
      } else if (state.mode === "doze" && t > state.nextWander && idleFor > 9000) {
        // 睡够了，出门溜达一圈
        const p = pickWanderPoint(t);
        state.wanderX = p.x;
        state.wanderY = p.y;
        state.mode = "wanderOut";
      } else if (state.mode === "wanderOut") {
        if (Math.hypot(state.wanderX - state.x, state.wanderY - state.y) < 16) {
          state.mode = "wanderPause";
          state.modeUntil = t + 2200 + Math.random() * 3200;
        }
      } else if (state.mode === "wanderPause" && t > state.modeUntil) {
        state.mode = "wanderBack";
      } else if (state.mode === "wanderBack") {
        const h = home();
        if (Math.hypot(h.x - state.x, h.y - state.y) < 18) {
          state.mode = "doze";
          state.nextWander = t + 18000 + Math.random() * 26000;
        }
      }

      // ── 各模式的移动目标与弹簧刚度 ─────────────────────
      let target: { x: number; y: number };
      let k: number;
      switch (state.mode) {
        case "follow":
          target = { x: state.mouseX + 26, y: state.mouseY + 30 };
          k = 0.03;
          break;
        case "inspect":
          target = {
            x: state.mouseX + Math.cos(state.inspectAngle) * 42,
            y: state.mouseY + Math.sin(state.inspectAngle) * 34,
          };
          k = 0.035;
          break;
        case "wanderOut":
          target = { x: state.wanderX, y: state.wanderY };
          k = 0.02;
          break;
        case "wanderPause":
          target = {
            x: state.wanderX + Math.sin(t / 1400) * 8,
            y: state.wanderY + Math.cos(t / 1100) * 5,
          };
          k = 0.016;
          break;
        case "wanderBack":
          target = home();
          k = 0.02;
          break;
        default: {
          const h = home();
          target = {
            x: h.x + Math.sin(t / 1600) * 10,
            y: h.y + Math.cos(t / 1300) * 6,
          };
          k = 0.012;
        }
      }

      state.vx += (target.x - state.x) * k * (dt / 16);
      state.vy += (target.y - state.y) * k * (dt / 16);
      state.vx *= 0.88;
      state.vy *= 0.88;
      state.x += state.vx * (dt / 16);
      state.y += state.vy * (dt / 16);
      if (Math.abs(state.vx) > 0.4) state.facing = state.vx > 0 ? 1 : -1;

      // 快速移动后落定：抖一下身体
      const speed = Math.hypot(state.vx, state.vy);
      if (speed > 7) {
        state.wasFast = true;
      } else if (state.wasFast && speed < 1.1) {
        state.wasFast = false;
        state.shakeUntil = t + 260;
      }

      if (speed > 1.2) {
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

      // 眼神：不追光标时偶尔瞟向随机方向
      const tracking = state.mode === "follow" || state.mode === "inspect";
      if (!tracking && t > state.nextGlance) {
        state.glanceTX = (Math.random() * 2 - 1) * 1.8;
        state.glanceTY = (Math.random() * 2 - 1) * 1.1;
        state.glanceUntil = t + 700 + Math.random() * 1000;
        state.nextGlance = t + 3200 + Math.random() * 5200;
      }
      if (tracking || t > state.glanceUntil) {
        state.glanceTX = 0;
        state.glanceTY = 0;
      }
      state.glanceX += (state.glanceTX - state.glanceX) * 0.12 * (dt / 16);
      state.glanceY += (state.glanceTY - state.glanceY) * 0.12 * (dt / 16);

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
