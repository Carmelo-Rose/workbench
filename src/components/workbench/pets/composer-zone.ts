"use client";

/**
 * 禁区 — 挂件的移动目标需避开输入框、`/` 命令面板与模型选择器弹层，逐个外扩
 * 28px 后取矩形并集（命中任一即算禁区）。rect 以 ~1s 节流缓存，避免每帧查询
 * DOM；查不到的选择器直接跳过，不会让整体约束失效。
 */

export type Zone = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

const PADDING = 28;
const REFRESH_MS = 1000;

const DEFAULT_AVOID_SELECTORS: readonly string[] = [
  '[data-slot="aui_composer-shell"]',
  '[data-slot="composer-trigger-popover"]',
  '[data-slot="model-selector-content"]',
];

export const createComposerZone = (
  selectors: readonly string[] = DEFAULT_AVOID_SELECTORS,
) => {
  let zones: Zone[] = [];
  let checkedAt = -Infinity;

  const getAll = (t: number): Zone[] => {
    if (t - checkedAt >= REFRESH_MS) {
      checkedAt = t;
      zones = selectors.flatMap((selector) => {
        const el = document.querySelector(selector);
        if (!el) return [];
        const r = el.getBoundingClientRect();
        return [{
          left: r.left - PADDING,
          top: r.top - PADDING,
          right: r.right + PADDING,
          bottom: r.bottom + PADDING,
        }];
      });
    }
    return zones;
  };

  // 现有消费者的转向/逃逸算法只吃单个矩形；多禁区里挑第一个可解析的作为
  // 逃逸目标即可——三个禁区在版面上本就互不重叠，不值得为此重写那套几何。
  const get = (t: number): Zone | null => getAll(t)[0] ?? null;

  const contains = (t: number, x: number, y: number): boolean =>
    getAll(t).some(
      (z) => x >= z.left && x <= z.right && y >= z.top && y <= z.bottom,
    );

  return { get, contains };
};
