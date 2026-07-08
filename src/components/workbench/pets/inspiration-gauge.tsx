"use client";

import { useEffect, useRef } from "react";
import type { FC } from "react";
import { resolveThemeColor, type RGB } from "@/components/workbench/pets/canvas-color";

/**
 * 灵感刻度尺：工作时逐格上升，输入时短促跃迁，空闲时慢慢回落。
 *
 * 微妙生命感：
 * - 长时间空闲时指示点偶尔轻轻"呼吸"浮动（慢波门控，时有时无）；
 * - isWorking 从 true 变 false 时来一次舒展的回落（缓出 + 轻微余摆），
 *   而非线性插值；
 * - 偶尔（分钟级）在刻度上方冒出一颗随即淡出的小墨点——灵感火花，保持克制。
 */

export const InspirationGaugePet: FC<{ isWorking: boolean }> = ({
  isWorking,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const workingRef = useRef(isWorking);

  useEffect(() => {
    workingRef.current = isWorking;
  }, [isWorking]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    let dpr = 1;
    let ink: RGB = [28, 28, 34];
    let accent: RGB = [82, 94, 255];
    let raf = 0;
    let last: number | null = null;
    let level = 0.28;
    let bumpUntil = 0;
    let lastActivity = performance.now();
    // 舒展回落：记录 isWorking true→false 的时刻与起始高度
    let prevWorking = false;
    let releaseAt = -1e9;
    let releaseFrom = 0;
    const RELEASE_MS = 1700;
    // 灵感火花：分钟级偶发，随即淡出（坐标相对刻度尺原点）
    const sparks: { ox: number; oy: number; t: number }[] = [];
    let nextSpark = performance.now() + 45000 + Math.random() * 75000;

    const home = () => ({
      x: window.innerWidth - 74,
      y: window.innerHeight - 146,
    });

    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(window.innerWidth * dpr);
      canvas.height = Math.round(window.innerHeight * dpr);
    };

    const applyTheme = () => {
      const host = canvas.parentElement ?? document.body;
      ink = resolveThemeColor(host, "var(--foreground)", [28, 28, 34]);
      accent = resolveThemeColor(host, "var(--primary)", [82, 94, 255]);
    };

    const draw = (t: number) => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);

      const [r, g, b] = ink;
      const [ar, ag, ab] = accent;
      const p = home();
      const h = 70;
      const filled = h * level;
      const bump = t < bumpUntil ? 1 - (bumpUntil - t) / 360 : 0;

      ctx.save();
      ctx.translate(p.x, p.y);

      ctx.strokeStyle = `rgba(${r},${g},${b},0.22)`;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(0, h);
      ctx.stroke();

      for (let i = 0; i <= 7; i += 1) {
        const y = h - (i / 7) * h;
        const major = i % 2 === 0;
        ctx.strokeStyle = `rgba(${r},${g},${b},${major ? 0.34 : 0.18})`;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(major ? 17 : 10, y);
        ctx.stroke();
      }

      const gradient = ctx.createLinearGradient(0, h, 0, h - filled);
      gradient.addColorStop(0, `rgba(${ar},${ag},${ab},0.18)`);
      gradient.addColorStop(1, `rgba(${ar},${ag},${ab},0.74)`);
      ctx.strokeStyle = gradient;
      ctx.lineWidth = 3 + bump * 1.2;
      ctx.beginPath();
      ctx.moveTo(0, h);
      ctx.lineTo(0, h - filled);
      ctx.stroke();

      // 空闲呼吸：长时间无输入时指示点偶尔轻轻浮动（慢波门控，时有时无）
      const idleFor = t - lastActivity;
      const gate = Math.max(0, Math.sin(t / 9000));
      const ramp = Math.min(1, Math.max(0, (idleFor - 12000) / 6000));
      const float = workingRef.current ? 0 : Math.sin(t / 1100) * 2 * ramp * gate;

      ctx.fillStyle = `rgba(${ar},${ag},${ab},${0.7 + bump * 0.18})`;
      ctx.beginPath();
      ctx.arc(0, h - filled + float, 4.5 + bump * 1.8, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = `rgba(${r},${g},${b},0.2)`;
      ctx.beginPath();
      ctx.arc(0, h - filled + float, 10 + bump * 14, 0, Math.PI * 2);
      ctx.stroke();

      // 灵感火花：刻度上方冒出的小墨点，边上浮边淡出
      for (const s of sparks) {
        const age = (t - s.t) / 1400;
        if (age >= 1) continue;
        ctx.fillStyle = `rgba(${r},${g},${b},${(0.5 * (1 - age)).toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(s.ox, s.oy - age * 9, 1.6 + age * 0.5, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.restore();
    };

    const tick = (t: number) => {
      if (!canvas.isConnected) return;
      const dt = last === null ? 16 : Math.min(t - last, 64);
      last = t;

      const working = workingRef.current;
      if (prevWorking && !working) {
        // 工作结束：起一段舒展的回落
        releaseAt = t;
        releaseFrom = level;
      }
      prevWorking = working;

      const idleTarget = 0.22 + Math.sin(t / 1700) * 0.05;
      if (!working && t - releaseAt < RELEASE_MS) {
        // 舒展回落：缓出 + 随进度衰减的余摆，替代线性插值
        const p = (t - releaseAt) / RELEASE_MS;
        const ease = 1 - Math.pow(1 - p, 3);
        const sway = Math.sin(p * Math.PI * 2.4) * (1 - p) * 0.05;
        level = releaseFrom + (idleTarget - releaseFrom) * ease + sway;
      } else {
        const target = working ? 0.68 + Math.sin(t / 360) * 0.22 : idleTarget;
        level += (target - level) * 0.05 * (dt / 16);
      }
      if (t < bumpUntil) level = Math.min(1, level + 0.018 * (dt / 16));

      // 灵感火花：分钟级偶发，最多同时存在 3 颗
      if (t > nextSpark) {
        sparks.push({ ox: -5 + Math.random() * 20, oy: -10 - Math.random() * 10, t });
        if (sparks.length > 3) sparks.shift();
        nextSpark = t + 50000 + Math.random() * 80000;
      }

      draw(t);
      raf = requestAnimationFrame(tick);
    };

    const bump = () => {
      bumpUntil = performance.now() + 360;
      lastActivity = performance.now();
    };

    const themeObserver = new MutationObserver(applyTheme);
    resize();
    applyTheme();
    draw(performance.now());

    if (!reduced.matches) {
      window.addEventListener("keydown", bump);
      window.addEventListener("pointerdown", bump, { passive: true });
      window.addEventListener("resize", resize);
      themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["class"],
      });
      raf = requestAnimationFrame(tick);
    }

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", bump);
      window.removeEventListener("pointerdown", bump);
      window.removeEventListener("resize", resize);
      themeObserver.disconnect();
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      data-slot="mono_pet-inspiration-gauge"
      className="pointer-events-none fixed inset-0 z-40 h-full w-full"
    />
  );
};
