"use client";

import type { FC, ReactNode } from "react";

/**
 * 会话皮肤。
 *
 * 早期每个皮肤是一个独立的 Thread 实现（variants/chatgpt|grok|gemini.tsx），
 * 那些文件是从 assistant-ui 文档例子里搬来的静态演示：切过去之后 `/` 命令、
 * @ 引用、生图/生视频模式、任务中心、工具卡片等等全部消失。所以皮肤现在只是
 * 一层 CSS 作用域——渲染的永远是同一个 `<Thread />`，功能一个不少，换的只有
 * 配色、圆角、气泡形状这些外观变量（见 `src/app/skins.css`）。
 */
export const THREAD_STYLES: readonly {
  id: "base" | "chatgpt" | "grok" | "gemini";
  name: string;
}[] = [
  { id: "base", name: "Base" },
  { id: "chatgpt", name: "ChatGPT" },
  { id: "grok", name: "Grok" },
  { id: "gemini", name: "Gemini" },
];

export type ThreadStyleId = (typeof THREAD_STYLES)[number]["id"];

/** 皮肤作用域：CSS 靠 `[data-thread-skin]` 选中里面的 Thread。 */
export const ThreadSkinScope: FC<{
  skin: ThreadStyleId;
  children: ReactNode;
}> = ({ skin, children }) => (
  <div data-thread-skin={skin} className="h-full">
    {children}
  </div>
);

export const STYLE_STORAGE_KEY = "wb:thread-style";

export const loadThreadStyle = (): ThreadStyleId => {
  if (typeof window === "undefined") return "base";
  const stored = window.localStorage.getItem(STYLE_STORAGE_KEY);
  return THREAD_STYLES.some((s) => s.id === stored)
    ? (stored as ThreadStyleId)
    : "base";
};

export const saveThreadStyle = (id: ThreadStyleId) => {
  window.localStorage.setItem(STYLE_STORAGE_KEY, id);
};
