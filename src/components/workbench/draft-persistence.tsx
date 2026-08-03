"use client";

import { useEffect, useRef } from "react";
import type { FC } from "react";
import { useAui, useAuiState } from "@assistant-ui/react";

const DRAFT_PREFIX = "wb:draft:";
const SAVE_DEBOUNCE_MS = 300;

const draftKey = (threadId: string) => `${DRAFT_PREFIX}${threadId}`;

/**
 * 按 threadId 把未发送的输入框文本存 localStorage：切会话或刷新页面后
 * 原样恢复，避免手滑关掉标签页或点错会话时丢字。只认文本，不含附件——
 * 附件本身不落 localStorage（File 对象序列化不了），范围对齐 plan 的最小要求。
 */
export const DraftPersistence: FC = () => {
  const aui = useAui();
  const threadId = useAuiState((s) => s.threads.mainThreadId);
  const text = useAuiState((s) => s.composer.text);
  const lastThreadIdRef = useRef<string | null>(null);

  // 切到（或首次加载落在）一个会话：把它存过的草稿写回 composer。
  useEffect(() => {
    if (lastThreadIdRef.current === threadId) return;
    lastThreadIdRef.current = threadId;
    const draft = window.localStorage.getItem(draftKey(threadId));
    if (draft) aui.composer().setText(draft);
  }, [threadId, aui]);

  // 防抖落盘；清空文本时删掉 key，不留空字符串占位。
  useEffect(() => {
    const timer = setTimeout(() => {
      if (text.trim()) {
        window.localStorage.setItem(draftKey(threadId), text);
      } else {
        window.localStorage.removeItem(draftKey(threadId));
      }
    }, SAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [threadId, text]);

  // 有未落盘/未发送的内容时，关闭或刷新标签页前拦一下。
  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!aui.composer().getState().text.trim()) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [aui]);

  return null;
};
