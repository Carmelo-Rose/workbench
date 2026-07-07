"use client";

import type { FC } from "react";
import { Thread } from "@/components/assistant-ui/thread";
import { ChatGPT } from "@/components/workbench/variants/chatgpt";
import { Gemini } from "@/components/workbench/variants/gemini";
import { Grok } from "@/components/workbench/variants/grok";

export const THREAD_STYLES: readonly {
  id: "base" | "chatgpt" | "grok" | "gemini";
  name: string;
  Component: FC;
}[] = [
  { id: "base", name: "Base", Component: Thread },
  { id: "chatgpt", name: "ChatGPT", Component: ChatGPT },
  { id: "grok", name: "Grok", Component: Grok },
  { id: "gemini", name: "Gemini", Component: Gemini },
];

export type ThreadStyleId = (typeof THREAD_STYLES)[number]["id"];

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
