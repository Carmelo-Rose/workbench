"use client";

import { useEffect, useState, type FC } from "react";
import { useAssistantRuntime } from "@assistant-ui/react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useExitImage2Mode } from "@/components/workbench/Image2ChatMode";
import { useExitVideoGenerationMode } from "@/components/workbench/VideoGenerationMode";
import { useImage2Mode } from "@/lib/image2-mode";
import { useVideoGenerationMode } from "@/lib/video-generation-mode";

/**
 * 全站快捷键体系 + `?` 速查表。⌘K（命令面板）与 ⌘F（会话内查找）各自挂在
 * 自己的组件里；这里收拢剩下几条全局级别的，外加速查表本身——按下 `?`
 * 之前它完全不存在，是最纯粹的渐进式披露。
 */
const SHORTCUTS: { keys: string; desc: string }[] = [
  { keys: "⌘K", desc: "打开命令面板" },
  { keys: "⌘⇧O", desc: "新建会话" },
  { keys: "⌘F", desc: "在当前会话中查找" },
  { keys: "Esc", desc: "退出生图 / 视频模式" },
  { keys: "?", desc: "显示这份速查表" },
];

const isTypingTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.isContentEditable
  );
};

/** 已有对话框 / ⌘F 查找条打开时，全局快捷键让位，避免互相打架。 */
const hasOverlayOpen = () =>
  !!document.querySelector('[role="dialog"], [role="search"]');

export const GlobalShortcuts: FC = () => {
  const [cheatSheetOpen, setCheatSheetOpen] = useState(false);
  const runtime = useAssistantRuntime();
  const image2Active = useImage2Mode((s) => s.active);
  const videoActive = useVideoGenerationMode((s) => s.active);
  const exitImage2Mode = useExitImage2Mode();
  const exitVideoGenerationMode = useExitVideoGenerationMode();

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        event.shiftKey &&
        event.key.toLowerCase() === "o"
      ) {
        if (hasOverlayOpen()) return;
        event.preventDefault();
        runtime.threads.switchToNewThread();
        return;
      }

      if (
        event.key === "Escape" &&
        (image2Active || videoActive) &&
        !hasOverlayOpen()
      ) {
        event.preventDefault();
        if (image2Active) void exitImage2Mode();
        else exitVideoGenerationMode();
        return;
      }

      if (
        event.key === "?" &&
        !event.metaKey &&
        !event.ctrlKey &&
        !isTypingTarget(event.target) &&
        !hasOverlayOpen()
      ) {
        event.preventDefault();
        setCheatSheetOpen(true);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [runtime, image2Active, videoActive, exitImage2Mode, exitVideoGenerationMode]);

  return (
    <Dialog open={cheatSheetOpen} onOpenChange={setCheatSheetOpen}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>快捷键</DialogTitle>
          <DialogDescription>随时按 ? 呼出这份速查表。</DialogDescription>
        </DialogHeader>
        <ul className="flex flex-col gap-2.5">
          {SHORTCUTS.map((s) => (
            <li
              key={s.keys}
              className="flex items-center justify-between text-sm"
            >
              <span className="text-muted-foreground">{s.desc}</span>
              <kbd className="bg-muted rounded-md border px-1.5 py-0.5 font-mono text-xs">
                {s.keys}
              </kbd>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
};
