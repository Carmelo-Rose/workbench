"use client";

import { useMemo } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

/**
 * Pointer-following 3D tilt for small interactive surfaces (suggestion
 * chips). Handler-only — reads/writes e.currentTarget so no ref plumbing
 * is needed through asChild slots. Skips coarse pointers and honors
 * prefers-reduced-motion.
 */
export const useTilt = (maxDeg = 6) => {
  return useMemo(() => {
    const enabled = () =>
      typeof window !== "undefined" &&
      window.matchMedia("(pointer: fine)").matches &&
      !window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const onPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
      if (!enabled()) return;
      const el = e.currentTarget;
      const rect = el.getBoundingClientRect();
      const dx = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      const dy = ((e.clientY - rect.top) / rect.height) * 2 - 1;
      el.style.transition = "transform 80ms var(--ease-out-quart)";
      el.style.transform = `perspective(520px) rotateX(${(-dy * maxDeg).toFixed(2)}deg) rotateY(${(dx * maxDeg).toFixed(2)}deg) scale3d(1.02, 1.02, 1.02)`;
    };

    const onPointerLeave = (e: ReactPointerEvent<HTMLElement>) => {
      const el = e.currentTarget;
      el.style.transition = "transform 350ms var(--ease-out-quart)";
      el.style.transform = "";
    };

    return { onPointerMove, onPointerLeave };
  }, [maxDeg]);
};
