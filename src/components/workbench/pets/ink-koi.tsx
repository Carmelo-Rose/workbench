"use client";

import { useEffect, useRef } from "react";
import type { FC } from "react";
import {
  resolveThemeColor,
  type RGB,
} from "@/components/workbench/pets/canvas-color";
import { createComposerZone } from "@/components/workbench/pets/composer-zone";

/**
 * 墨鲤 — 一条小水墨锦鲤在视口下半部悠游。
 *
 * - 身体：8 节脊柱链（跟随头部的等距约束），摆尾从头部横向摆动自然传导到尾部；
 *   笔触感用前景色渐细椭圆叠出，尾鳍两笔淡墨随相位飘逸；
 * - 游动：慵懒随机巡游（下半部水域挑路径点）+ 最大角速度限制的平滑转向；
 * - 互动：光标在附近掠过/点击时，优雅转身游到光标下方停留片刻
 *   （像浮上来看饵），再游走并进入冷却；
 * - 身后留极淡的墨迹涟漪（淡出的圆环）；
 * - 巡游落点避开输入框禁区；主题自适应；
 *   prefers-reduced-motion 下只静置一帧。
 */

const SEG_LEN = 7;
// 每节半径（头略窄于肩、向尾渐细）与透明度
const SEG_R = [3.4, 4.5, 4.8, 4.3, 3.5, 2.7, 1.9, 1.2] as const;
const SEG_A = [0.82, 0.86, 0.86, 0.8, 0.68, 0.54, 0.42, 0.3] as const;
const SEGS = SEG_R.length;
const MAX_TURN = 1.8; // rad/s，转向角速度上限，避免抽搐
const MAX_RIPPLES = 5;

type KoiMode = "cruise" | "approach" | "linger";

export const InkKoiPet: FC = () => {
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
    let raf = 0;
    let last: number | null = null;

    // 巡游水域：视口下半部
    const band = () => ({
      minX: 48,
      maxX: Math.max(96, window.innerWidth - 48),
      minY: window.innerHeight * 0.55,
      maxY: Math.max(window.innerHeight * 0.6, window.innerHeight - 36),
    });

    /** 挑一个巡游路径点：避开输入框禁区，实在避不开就沉到角落 */
    const pickWaypoint = (t: number) => {
      const b = band();
      for (let i = 0; i < 10; i += 1) {
        const x = b.minX + Math.random() * (b.maxX - b.minX);
        const y = b.minY + Math.random() * (b.maxY - b.minY);
        if (!zone.contains(t, x, y)) return { x, y };
      }
      return {
        x: Math.random() < 0.5 ? b.minX + 30 : b.maxX - 30,
        y: b.maxY - 8,
      };
    };

    const start = {
      x: window.innerWidth * 0.3,
      y: window.innerHeight * 0.74,
    };
    const state = {
      x: start.x,
      y: start.y,
      heading: 0,
      speed: 0.8,
      phase: 0, // 摆尾相位
      mode: "cruise" as KoiMode,
      wpX: start.x + 180,
      wpY: start.y,
      wpUntil: 0,
      lingerUntil: 0,
      approachUntil: 0,
      cooldownUntil: 0,
      mouseX: 0,
      mouseY: 0,
    };
    const segs = Array.from({ length: SEGS }, (_, i) => ({
      x: start.x - i * SEG_LEN,
      y: start.y,
    }));
    const ripples: { x: number; y: number; t: number }[] = [];
    let nextRipple = 0;

    const pushRipple = (t: number) => {
      ripples.push({ x: state.x, y: state.y, t });
      if (ripples.length > MAX_RIPPLES) ripples.shift();
    };

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

    const draw = (t: number) => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
      const [r, g, b] = ink;

      // 墨迹涟漪：淡出的圆环
      for (const p of ripples) {
        const age = (t - p.t) / 1900;
        if (age >= 1) continue;
        ctx.strokeStyle = `rgba(${r},${g},${b},${(0.11 * (1 - age)).toFixed(3)})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 4 + age * 16, 0, Math.PI * 2);
        ctx.stroke();
      }

      // 各节朝向：头用 heading，其余指向前一节
      const angles: number[] = [state.heading];
      for (let i = 1; i < SEGS; i += 1) {
        angles.push(
          Math.atan2(segs[i - 1].y - segs[i].y, segs[i - 1].x - segs[i].x),
        );
      }

      // 尾鳍：最后一节后方两笔飘逸的淡墨，随摆尾相位开合
      const tail = segs[SEGS - 1];
      const ta = angles[SEGS - 1];
      for (const side of [-1, 1]) {
        const spread = Math.max(
          0.14,
          0.34 + Math.sin(state.phase - 2.4) * side * 0.18,
        );
        const fa = ta + Math.PI + side * spread;
        ctx.save();
        ctx.translate(tail.x + Math.cos(fa) * 5.5, tail.y + Math.sin(fa) * 5.5);
        ctx.rotate(fa);
        ctx.fillStyle = `rgba(${r},${g},${b},0.26)`;
        ctx.beginPath();
        ctx.ellipse(0, 0, 5, 1.5, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }

      // 胸鳍：第 3 节两侧，随摆尾轻扇
      const finSeg = segs[2];
      const fba = angles[2];
      for (const side of [-1, 1]) {
        const pa = fba + (side * Math.PI) / 2;
        ctx.save();
        ctx.translate(
          finSeg.x + Math.cos(pa) * 4.6,
          finSeg.y + Math.sin(pa) * 4.6,
        );
        ctx.rotate(fba + side * (0.95 + Math.sin(state.phase) * side * 0.22));
        ctx.fillStyle = `rgba(${r},${g},${b},0.3)`;
        ctx.beginPath();
        ctx.ellipse(0, 0, 4.2, 1.4, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }

      // 身体：从尾到头叠渐细椭圆，笔触感
      for (let i = SEGS - 1; i >= 0; i -= 1) {
        const s = segs[i];
        ctx.save();
        ctx.translate(s.x, s.y);
        ctx.rotate(angles[i]);
        ctx.fillStyle = `rgba(${r},${g},${b},${SEG_A[i]})`;
        ctx.beginPath();
        ctx.ellipse(0, 0, SEG_R[i] * 1.5, SEG_R[i], 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }

      // 眼睛：头两侧抠出的小点
      ctx.save();
      ctx.globalCompositeOperation = "destination-out";
      for (const side of [-1, 1]) {
        ctx.beginPath();
        ctx.arc(
          state.x + Math.cos(state.heading + side * 0.85) * 2.6,
          state.y + Math.sin(state.heading + side * 0.85) * 2.6,
          0.8,
          0,
          Math.PI * 2,
        );
        ctx.fill();
      }
      ctx.restore();
    };

    const tick = (t: number) => {
      if (!canvas.isConnected) return;
      const dt = last === null ? 16 : Math.min(t - last, 64);
      last = t;

      // ── 模式流转 ──────────────────────────────────────
      if (state.mode === "cruise") {
        const d = Math.hypot(state.wpX - state.x, state.wpY - state.y);
        if (d < 36 || t > state.wpUntil) {
          const p = pickWaypoint(t);
          state.wpX = p.x;
          state.wpY = p.y;
          state.wpUntil = t + 9000 + Math.random() * 8000;
        }
      } else if (state.mode === "approach") {
        // 目标：光标正下方（避开禁区、留在视口内）
        const tx = Math.min(Math.max(state.mouseX, 30), window.innerWidth - 30);
        let ty = state.mouseY + 46;
        const z = zone.get(t);
        if (z && tx > z.left && tx < z.right && ty > z.top && ty < z.bottom) {
          ty = z.bottom + 18;
        }
        ty = Math.min(Math.max(ty, 40), window.innerHeight - 30);
        state.wpX = tx;
        state.wpY = ty;
        if (Math.hypot(tx - state.x, ty - state.y) < 26) {
          // 浮上来看饵
          state.mode = "linger";
          state.lingerUntil = t + 2400 + Math.random() * 2200;
          pushRipple(t);
        } else if (t > state.approachUntil) {
          // 追太久就作罢
          state.mode = "cruise";
          state.cooldownUntil = t + 6000;
        }
      } else if (state.mode === "linger" && t > state.lingerUntil) {
        // 看够了，游走并进入冷却
        state.mode = "cruise";
        state.cooldownUntil = t + 9000 + Math.random() * 7000;
        const p = pickWaypoint(t);
        state.wpX = p.x;
        state.wpY = p.y;
        state.wpUntil = t + 12000;
      }

      // ── 转向：期望方向 + 最大角速度限制 ─────────────────
      let desired = Math.atan2(state.wpY - state.y, state.wpX - state.x);
      const z = zone.get(t);
      if (
        z &&
        state.x > z.left &&
        state.x < z.right &&
        state.y > z.top &&
        state.y < z.bottom
      ) {
        // 误入禁区：朝离开禁区中心的方向游
        desired = Math.atan2(
          state.y - (z.top + z.bottom) / 2,
          state.x - (z.left + z.right) / 2,
        );
      }
      let diff = desired - state.heading;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      const maxTurn = MAX_TURN * (dt / 1000);
      diff = Math.max(-maxTurn, Math.min(maxTurn, diff));
      state.heading += diff;

      // ── 速度：慵懒巡游，凑近时略快，看饵时几乎悬停 ─────
      const targetSpeed =
        state.mode === "linger"
          ? 0.18
          : state.mode === "approach"
            ? 1.5
            : 0.75 + Math.sin(t / 2600) * 0.25;
      state.speed += (targetSpeed - state.speed) * 0.03 * (dt / 16);

      // 摆尾：相位随速度推进，游得快摆得快；横摆叠加在前进方向上
      state.phase += dt * (0.005 + state.speed * 0.0028);
      const wiggle = Math.sin(state.phase) * (0.1 + state.speed * 0.06);
      const dir = state.heading + wiggle;
      state.x += Math.cos(dir) * state.speed * (dt / 16);
      state.y += Math.sin(dir) * state.speed * (dt / 16);
      state.x = Math.min(Math.max(state.x, 12), window.innerWidth - 12);
      state.y = Math.min(Math.max(state.y, 12), window.innerHeight - 12);

      // ── 脊柱链：等距跟随头部，摆尾自然传导 ─────────────
      segs[0].x = state.x;
      segs[0].y = state.y;
      for (let i = 1; i < SEGS; i += 1) {
        const ang = Math.atan2(
          segs[i].y - segs[i - 1].y,
          segs[i].x - segs[i - 1].x,
        );
        segs[i].x = segs[i - 1].x + Math.cos(ang) * SEG_LEN;
        segs[i].y = segs[i - 1].y + Math.sin(ang) * SEG_LEN;
      }

      // 涟漪：低频冒泡，看饵时略密
      if (t > nextRipple) {
        pushRipple(t);
        nextRipple =
          t + (state.mode === "linger" ? 1100 : 2100) + Math.random() * 900;
      }

      draw(t);
      raf = requestAnimationFrame(tick);
    };

    const startApproach = (x: number, y: number, radius: number) => {
      const now = performance.now();
      if (now < state.cooldownUntil || state.mode === "linger") return;
      if (Math.hypot(x - state.x, y - state.y) < radius) {
        state.mode = "approach";
        state.approachUntil = now + 6000;
      }
    };

    const onPointerMove = (e: PointerEvent) => {
      state.mouseX = e.clientX;
      state.mouseY = e.clientY;
      if (state.mode === "cruise") startApproach(e.clientX, e.clientY, 90);
    };

    const onPointerDown = (e: PointerEvent) => {
      state.mouseX = e.clientX;
      state.mouseY = e.clientY;
      startApproach(e.clientX, e.clientY, 220);
    };

    const themeObserver = new MutationObserver(applyTheme);

    resize();
    applyTheme();
    draw(performance.now());

    if (!reduced.matches) {
      window.addEventListener("pointermove", onPointerMove, { passive: true });
      window.addEventListener("pointerdown", onPointerDown, { passive: true });
      window.addEventListener("resize", resize);
      themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["class"],
      });
      raf = requestAnimationFrame(tick);
    }

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("resize", resize);
      themeObserver.disconnect();
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      data-slot="mono_pet-ink-koi"
      className="pointer-events-none fixed inset-0 z-40 h-full w-full"
    />
  );
};
