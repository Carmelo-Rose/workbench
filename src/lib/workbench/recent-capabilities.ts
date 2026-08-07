"use client";

import { useSyncExternalStore } from "react";

const STORAGE_KEY = "workbench:recent-capabilities";
/** 顶部「常用」分段的容量。再多就把下面的分组挤出首屏了。 */
const MAX_RECENT = 4;

/**
 * 固定的空快照。`getSnapshot` 每次渲染都会被调用，返回值按引用比较——
 * 每次新建 `[]` 会让 React 认为 store 一直在变，进而无限重渲染。
 */
const EMPTY: readonly string[] = [];

let cache: readonly string[] = EMPTY;
let hydrated = false;
const listeners = new Set<() => void>();

function readStorage(): readonly string[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return EMPTY;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return EMPTY;
    const ids = parsed
      .filter((value): value is string => typeof value === "string")
      .slice(0, MAX_RECENT);
    return ids.length ? ids : EMPTY;
  } catch {
    // 隐私模式 / 配额满 / 存了脏数据都走这里，静默退回空列表。
    return EMPTY;
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 首次调用才碰 localStorage，之后一律吃缓存，保证引用稳定。 */
function getSnapshot(): readonly string[] {
  if (!hydrated) {
    hydrated = true;
    cache = readStorage();
  }
  return cache;
}

/**
 * SSR 与 hydration 阶段一律当作空。React 会在 hydration 完成后用
 * `getSnapshot` 再渲染一次，所以这里不会产生 hydration mismatch 警告。
 */
function getServerSnapshot(): readonly string[] {
  return EMPTY;
}

/** 记一次能力执行。最新的排在最前，重复执行只是把它顶回第一位。 */
export function recordRecentCapability(id: string): void {
  const next = [id, ...getSnapshot().filter((existing) => existing !== id)].slice(
    0,
    MAX_RECENT,
  );
  cache = next;
  hydrated = true;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // 写不进去就只在本次会话内生效，不影响菜单可用。
  }
  listeners.forEach((listener) => listener());
}

/** 最近执行过的能力 id，最新在前。引用稳定，可直接进 useMemo 依赖。 */
export function useRecentCapabilityIds(): readonly string[] {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
