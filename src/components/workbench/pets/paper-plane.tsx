"use client";

import { useEffect, useRef } from "react";
import type { FC } from "react";
import {
  resolveThemeColor,
  type RGB,
} from "@/components/workbench/pets/canvas-color";
import { createComposerZone } from "@/components/workbench/pets/composer-zone";

/**
 * 纸飞机 — 一只极简折纸飞机在视口上半部慢速滑翔巡航。
 *
 * - 巡航：沿上半部随机路径点绕圈，机身旋转对齐速度方向，转弯时带 bank 倾角
 *   （内侧翼收窄、外侧翼展开）；
 * - 停泊：偶尔滑向某个上方角落降落，歇 8~20s（轻微上下漂浮），再缓出起飞；
 * - 航迹：身后一串淡出的虚线短划；
 * - 路径点避开输入框禁区；主题自适应（前景色三角面，透明度区分折面）；
 *   prefers-reduced-motion 下只静置一帧。
 */

const MAX_TURN = 1.35; // rad/s，转向角速度上限
const TRAIL_MAX = 12;
const TRAIL_LIFE = 2600;
const PARK_MIN_GAP = 26000; // 两次停泊的最小间隔
const CORNER_MARGIN = 72;

type PlaneMode = "cruise" | "landing" | "parked" | "takeoff";

const easeOutQuart = (t: number) => 1 - (1 - t) ** 4;

export const PaperPlanePet: FC = () => {
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

    // 巡航空域：视口上半部（避开头部工具栏一点距离）
    const sky = () => ({
      minX: 56,
      maxX: Math.max(112, window.innerWidth - 56),
      minY: 68,
      maxY: Math.max(120, window.innerHeight * 0.46),
    });

    /** 挑一个巡航路径点：避开输入框禁区 */
    const pickWaypoint = (t: number) => {
      const s = sky();
      for (let i = 0; i < 10; i += 1) {
        const x = s.minX + Math.random() * (s.maxX - s.minX);
        const y = s.minY + Math.random() * (s.maxY - s.minY);
        if (!zone.contains(t, x, y)) return { x, y };
      }
      return { x: s.minX + 30, y: s.minY + 20 };
    };

    /** 停泊角落：左上或右上，带一点随机内缩 */
    const pickCorner = () => ({
      x:
        Math.random() < 0.5
          ? CORNER_MARGIN + Math.random() * 40
          : window.innerWidth - CORNER_MARGIN - Math.random() * 40,
      y: 64 + Math.random() * 36,
    });

    const start = { x: window.innerWidth * 0.68, y: 120 };
    const state = {
      x: start.x,
      y: start.y,
      heading: Math.PI * 0.9,
      speed: 1.1,
      bank: 0, // 平滑后的转向速率，驱动翼面倾斜
      mode: "cruise" as PlaneMode,
      wpX: start.x - 200,
      wpY: start.y + 40,
      wpUntil: 0,
      parkX: 0,
      parkY: 0,
      parkedUntil: 0,
      nextParkAt: performance.now() + 14000 + Math.random() * 12000,
      takeoffStart: 0,
    };
    const trail: { x: number; y: number; a: number; t: number }[] = [];
    let nextTrailAt = 0;

    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(window.innerWidth * dpr);
      canvas.height = Math.round(window.innerHeight * dpr);
    };

    const applyTheme = () => {
      ink = resolveThemeColor(
        canvas.parentElement ?? document.body,
        "var(--foreground)",
        [30, 30, 35],
      );
    };

    const draw = (t: number) => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
      const [r, g, b] = ink;

      // 航迹：淡出的虚线短划，沿当时的航向
      for (const p of trail) {
        const age = (t - p.t) / TRAIL_LIFE;
        if (age >= 1) continue;
        ctx.strokeStyle = `rgba(${r},${g},${b},${(0.16 * (1 - age)).toFixed(3)})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(p.x - Math.cos(p.a) * 3, p.y - Math.sin(p.a) * 3);
        ctx.lineTo(p.x + Math.cos(p.a) * 3, p.y + Math.sin(p.a) * 3);
        ctx.stroke();
      }

      // 停泊时的轻微上下漂浮
      const bob =
        state.mode === "parked" ? Math.sin(t / 620) * 2.2 : 0;

      ctx.save();
      ctx.translate(state.x, state.y + bob);
      ctx.rotate(state.heading);

      // bank：转弯内侧翼收窄、外侧翼展开（近似三维滚转的俯视投影）
      const bank = Math.max(-1, Math.min(1, state.bank * 1.6));
      const spanL = 7 * (1 - Math.max(0, bank) * 0.45);
      const spanR = 7 * (1 - Math.max(0, -bank) * 0.45);

      // 左右翼面：两个三角面，透明度差表现折纸的受光面
      ctx.fillStyle = `rgba(${r},${g},${b},0.72)`;
      ctx.beginPath();
      ctx.moveTo(11, 0);
      ctx.lineTo(-8, -spanL);
      ctx.lineTo(-5, 0);
      ctx.closePath();
      ctx.fill();

      ctx.fillStyle = `rgba(${r},${g},${b},0.46)`;
      ctx.beginPath();
      ctx.moveTo(11, 0);
      ctx.lineTo(-8, spanR);
      ctx.lineTo(-5, 0);
      ctx.closePath();
      ctx.fill();

      // 中缝折线
      ctx.strokeStyle = `rgba(${r},${g},${b},0.85)`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(11, 0);
      ctx.lineTo(-5, 0);
      ctx.stroke();

      ctx.restore();
    };

    const tick = (t: number) => {
      if (!canvas.isConnected) return;
      const dt = last === null ? 16 : Math.min(t - last, 64);
      last = t;

      // ── 模式流转 ──────────────────────────────────────
      if (state.mode === "cruise") {
        const d = Math.hypot(state.wpX - state.x, state.wpY - state.y);
        if (d < 40 || t > state.wpUntil) {
          const p = pickWaypoint(t);
          state.wpX = p.x;
          state.wpY = p.y;
          state.wpUntil = t + 8000 + Math.random() * 7000;
        }
        if (t > state.nextParkAt) {
          const c = pickCorner();
          state.mode = "landing";
          state.parkX = c.x;
          state.parkY = c.y;
        }
      } else if (state.mode === "landing") {
        state.wpX = state.parkX;
        state.wpY = state.parkY;
        if (Math.hypot(state.parkX - state.x, state.parkY - state.y) < 14) {
          state.mode = "parked";
          state.parkedUntil = t + 8000 + Math.random() * 12000;
        }
      } else if (state.mode === "parked") {
        if (t > state.parkedUntil) {
          state.mode = "takeoff";
          state.takeoffStart = t;
          const p = pickWaypoint(t);
          state.wpX = p.x;
          state.wpY = p.y;
        }
      } else if (state.mode === "takeoff" && t > state.takeoffStart + 1600) {
        state.mode = "cruise";
        state.nextParkAt = t + PARK_MIN_GAP + Math.random() * 20000;
      }

      // ── 转向与速度 ────────────────────────────────────
      if (state.mode !== "parked") {
        let desired = Math.atan2(state.wpY - state.y, state.wpX - state.x);
        const z = zone.get(t);
        if (
          z &&
          state.x > z.left &&
          state.x < z.right &&
          state.y > z.top &&
          state.y < z.bottom
        ) {
          // 误入禁区：朝离开禁区中心的方向飞
          desired = Math.atan2(
            state.y - (z.top + z.bottom) / 2,
            state.x - (z.left + z.right) / 2,
          );
        }
        let diff = desired - state.heading;
        while (diff > Math.PI) diff -= Math.PI * 2;
        while (diff < -Math.PI) diff += Math.PI * 2;
        const maxTurn = MAX_TURN * (dt / 1000);
        const turn = Math.max(-maxTurn, Math.min(maxTurn, diff));
        state.heading += turn;
        // bank 跟随转向速率并平滑回正
        state.bank += (turn / Math.max(maxTurn, 1e-6) - state.bank) * 0.08;

        const targetSpeed =
          state.mode === "landing"
            ? 0.7
            : state.mode === "takeoff"
              ? 0.4 + easeOutQuart((t - state.takeoffStart) / 1600) * 0.9
              : 1.15 + Math.sin(t / 3100) * 0.2;
        state.speed += (targetSpeed - state.speed) * 0.04 * (dt / 16);

        state.x += Math.cos(state.heading) * state.speed * (dt / 16);
        state.y += Math.sin(state.heading) * state.speed * (dt / 16);
        state.x = Math.min(Math.max(state.x, 16), window.innerWidth - 16);
        state.y = Math.min(Math.max(state.y, 16), window.innerHeight - 16);

        // 航迹采样
        if (t > nextTrailAt) {
          trail.push({ x: state.x, y: state.y, a: state.heading, t });
          if (trail.length > TRAIL_MAX) trail.shift();
          nextTrailAt = t + 170;
        }
      } else {
        state.bank *= 0.94;
      }

      draw(t);
      raf = requestAnimationFrame(tick);
    };

    const themeObserver = new MutationObserver(applyTheme);

    resize();
    applyTheme();
    draw(performance.now());

    if (!reduced.matches) {
      window.addEventListener("resize", resize);
      themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["class"],
      });
      raf = requestAnimationFrame(tick);
    }

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      themeObserver.disconnect();
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      data-slot="mono_pet-paper-plane"
      className="pointer-events-none fixed inset-0 z-40 h-full w-full"
    />
  );
};
