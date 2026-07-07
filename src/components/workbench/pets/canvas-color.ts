"use client";

export type RGB = [number, number, number];

export const resolveThemeColor = (
  host: HTMLElement,
  token: string,
  fallback: RGB,
): RGB => {
  const probe = document.createElement("span");
  probe.style.color = token;
  probe.style.display = "none";
  host.appendChild(probe);
  const css = getComputedStyle(probe).color;
  probe.remove();

  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext("2d");
  if (!ctx) return fallback;
  ctx.fillStyle = css;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return [r, g, b];
};
