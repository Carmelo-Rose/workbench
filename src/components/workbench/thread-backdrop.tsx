"use client";

import { InkWashField } from "@/components/workbench/ink-wash-field";
import { ParticleField } from "@/components/workbench/particle-field";
import { useSyncExternalStore } from "react";
import type { FC } from "react";

/**
 * 欢迎屏背景的主题开关：暗色 → WebGL 粒子海，浅色 → 墨迹擦除。
 *
 * 用 useSyncExternalStore 订阅 documentElement 的 class 变化得到 isDark
 * （theme.ts 的 THEME_INIT_SCRIPT 在首帧前已写好 .dark，挂载后直接读即准）。
 * SSR / hydration 期间快照为 null → 先不渲染任何背景，避免闪出错误主题；
 * hydration 完成后 React 会用客户端快照立刻校正。
 */

const subscribe = (onChange: () => void) => {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  });
  return () => observer.disconnect();
};

const getSnapshot = (): boolean | null =>
  document.documentElement.classList.contains("dark");

// 服务端无从得知主题，返回 null 让首帧留白
const getServerSnapshot = (): boolean | null => null;

export const ThreadBackdrop: FC<{ active: boolean }> = ({ active }) => {
  const isDark = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  if (isDark === null) return null;
  return isDark ? (
    <ParticleField active={active} />
  ) : (
    <InkWashField active={active} />
  );
};
