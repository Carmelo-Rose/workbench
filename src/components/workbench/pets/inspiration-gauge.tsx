"use client";

import { useEffect, useRef } from "react";
import type { FC } from "react";
import { resolveThemeColor, type RGB } from "@/components/workbench/pets/canvas-color";

/** 灵感刻度尺：工作时逐格上升，输入时短促跃迁，空闲时慢慢回落。 */

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

      ctx.fillStyle = `rgba(${ar},${ag},${ab},${0.7 + bump * 0.18})`;
      ctx.beginPath();
      ctx.arc(0, h - filled, 4.5 + bump * 1.8, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = `rgba(${r},${g},${b},0.2)`;
      ctx.beginPath();
      ctx.arc(0, h - filled, 10 + bump * 14, 0, Math.PI * 2);
      ctx.stroke();

      ctx.restore();
    };

    const tick = (t: number) => {
      if (!canvas.isConnected) return;
      const dt = last === null ? 16 : Math.min(t - last, 64);
      last = t;

      const target = workingRef.current
        ? 0.68 + Math.sin(t / 360) * 0.22
        : 0.22 + Math.sin(t / 1700) * 0.05;
      level += (target - level) * 0.05 * (dt / 16);
      if (t < bumpUntil) level = Math.min(1, level + 0.018 * (dt / 16));

      draw(t);
      raf = requestAnimationFrame(tick);
    };

    const bump = () => {
      bumpUntil = performance.now() + 360;
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
