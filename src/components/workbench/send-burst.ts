"use client";

import { prefersReducedMotion } from "@/components/workbench/use-prefers-reduced-motion";

/**
 * A restrained puff of ink dots from the send button — fired on click,
 * removed when the last dot finishes. Skipped entirely under
 * prefers-reduced-motion or when WAAPI is unavailable.
 */
export const emitSendBurst = (origin: HTMLElement) => {
  if (typeof window === "undefined") return;
  if (prefersReducedMotion()) return;
  if (typeof origin.animate !== "function") return;

  const rect = origin.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;

  const host = document.createElement("div");
  host.setAttribute("aria-hidden", "true");
  host.style.cssText = `position:fixed;left:0;top:0;width:0;height:0;pointer-events:none;z-index:50;`;
  document.body.appendChild(host);

  const color = getComputedStyle(origin).backgroundColor;
  const count = 14;
  let alive = count;

  for (let i = 0; i < count; i++) {
    const dot = document.createElement("span");
    const size = 2.5 + Math.random() * 2.5;
    dot.style.cssText = `position:absolute;left:${cx}px;top:${cy}px;width:${size}px;height:${size}px;margin:-${size / 2}px 0 0 -${size / 2}px;border-radius:50%;background:${color};`;
    host.appendChild(dot);

    // upward-biased fan: -30° … -150° with slight spill
    const angle =
      (-30 - Math.random() * 120 + (Math.random() - 0.5) * 20) *
      (Math.PI / 180);
    const radius = 22 + Math.random() * 34;
    const x = Math.cos(angle) * radius;
    const y = Math.sin(angle) * radius;

    const anim = dot.animate(
      [
        { transform: "translate(0, 0) scale(1)", opacity: 0.9 },
        {
          transform: `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) scale(0.35)`,
          opacity: 0,
        },
      ],
      {
        duration: 450 + Math.random() * 250,
        easing: "cubic-bezier(0.22, 1, 0.36, 1)",
        fill: "forwards",
      },
    );
    anim.onfinish = () => {
      dot.remove();
      if (--alive === 0) host.remove();
    };
  }

  // safety net if onfinish never fires (e.g. detached document)
  window.setTimeout(() => host.remove(), 1200);
};
