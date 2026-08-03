"use client";

import { useEffect, useState } from "react";

/**
 * `prefers-reduced-motion` 的单一真源。pets / particle-field / ink-wash-field /
 * use-tilt / send-burst 各自都重复过一遍 `window.matchMedia(...)` 样板——
 * 这里收成三个口子：一次性读取（rAF 引擎挂载时的静态门禁）、订阅变化
 * （引擎需要在系统设置切换时响应）、React hook（组件内响应式读取）。
 */
const QUERY = "(prefers-reduced-motion: reduce)";

export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia(QUERY).matches;
}

/** 返回取消订阅函数；立即以当前值触发一次 onChange。 */
export function watchPrefersReducedMotion(
  onChange: (reduced: boolean) => void,
): () => void {
  if (typeof window === "undefined") return () => {};
  const mq = window.matchMedia(QUERY);
  const handler = () => onChange(mq.matches);
  handler();
  mq.addEventListener("change", handler);
  return () => mq.removeEventListener("change", handler);
}

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(prefersReducedMotion);
  useEffect(() => watchPrefersReducedMotion(setReduced), []);
  return reduced;
}
