"use client";

/**
 * 输入框禁区 — 挂件的移动目标需避开页面中央的输入框：
 * `[data-slot="aui_composer-shell"]` 外扩 28px 的矩形。
 * rect 以 ~1s 节流缓存，避免每帧查询 DOM；查不到元素时返回 null（跳过约束）。
 */

export type Zone = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

const PADDING = 28;
const REFRESH_MS = 1000;

export const createComposerZone = () => {
  let zone: Zone | null = null;
  let checkedAt = -Infinity;

  const get = (t: number): Zone | null => {
    if (t - checkedAt >= REFRESH_MS) {
      checkedAt = t;
      const el = document.querySelector('[data-slot="aui_composer-shell"]');
      if (el) {
        const r = el.getBoundingClientRect();
        zone = {
          left: r.left - PADDING,
          top: r.top - PADDING,
          right: r.right + PADDING,
          bottom: r.bottom + PADDING,
        };
      } else {
        zone = null;
      }
    }
    return zone;
  };

  const contains = (t: number, x: number, y: number): boolean => {
    const z = get(t);
    return (
      z !== null && x >= z.left && x <= z.right && y >= z.top && y <= z.bottom
    );
  };

  return { get, contains };
};
