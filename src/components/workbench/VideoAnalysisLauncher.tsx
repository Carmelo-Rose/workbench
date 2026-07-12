"use client";

import { useState, type FC } from "react";
import { PlaySquareIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

/**
 * 「分析视频」的入口卡：点建议 chip 后先收输入（链接 + 分析重点），
 * 一次确认就把完整意图发进对话，由 mono_analyze_video 工具卡接管进度。
 */
const FOCUS_OPTIONS = [
  { label: "总结要点", instruction: "总结视频的内容要点和叙事结构" },
  { label: "拆解镜头节奏", instruction: "拆解视频的镜头语言、剪辑节奏和转场方式" },
  { label: "反推视频提示词", instruction: "反推出可复用于 AI 视频生成的提示词" },
  { label: "提取口播文案", instruction: "提取视频中的口播文案和字幕要点" },
] as const;

function isHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export const VideoAnalysisLauncher: FC<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (prompt: string) => void;
}> = ({ open, onOpenChange, onSubmit }) => {
  const [url, setUrl] = useState("");
  const [focusLabel, setFocusLabel] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);

  const trimmedUrl = url.trim();
  const urlValid = isHttpUrl(trimmedUrl);
  const showError = touched && trimmedUrl !== "" && !urlValid;

  const reset = () => {
    setUrl("");
    setFocusLabel(null);
    setTouched(false);
  };

  const submit = () => {
    if (!urlValid) {
      setTouched(true);
      return;
    }
    const focus = FOCUS_OPTIONS.find((option) => option.label === focusLabel);
    onSubmit(
      `分析这个视频：${trimmedUrl}${focus ? `，${focus.instruction}` : ""}`,
    );
    onOpenChange(false);
    reset();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) reset();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <PlaySquareIcon className="size-4.5" />
            分析视频
          </DialogTitle>
          <DialogDescription>
            粘贴公开视频链接，选择分析重点。本地视频上传即将支持。
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <input
            type="url"
            value={url}
            autoFocus
            onChange={(event) => setUrl(event.target.value)}
            onBlur={() => setTouched(true)}
            onKeyDown={(event) => {
              if (event.key === "Enter") submit();
            }}
            placeholder="https://example.com/video.mp4"
            aria-invalid={showError}
            className={cn(
              "bg-background h-10 w-full rounded-lg border px-3 text-sm outline-none transition-colors focus:ring-2",
              showError && "border-destructive",
            )}
          />
          {showError ? (
            <p className="text-destructive text-xs">
              请输入 http(s) 开头的完整视频链接
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {FOCUS_OPTIONS.map((option) => (
              <button
                key={option.label}
                type="button"
                onClick={() =>
                  setFocusLabel((current) =>
                    current === option.label ? null : option.label,
                  )
                }
                className={cn(
                  "rounded-full border px-3 py-1.5 text-sm transition-colors",
                  focusLabel === option.label
                    ? "border-foreground bg-foreground text-background"
                    : "border-border/60 hover:bg-muted",
                )}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
        <DialogFooter>
          <Button onClick={submit} disabled={!trimmedUrl} className="rounded-full">
            开始分析
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
