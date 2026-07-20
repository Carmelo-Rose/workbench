"use client";

import { useRef, useState, type FC } from "react";
import { LoaderCircleIcon, PlaySquareIcon, UploadIcon } from "lucide-react";
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
 * 输入既可以是视频直链，也可以整段粘贴平台分享口令（自动提取其中的链接）。
 */
const FOCUS_OPTIONS = [
  { label: "总结要点", instruction: "总结视频的内容要点和叙事结构" },
  { label: "拆解镜头节奏", instruction: "拆解视频的镜头语言、剪辑节奏和转场方式" },
  { label: "反推视频提示词", instruction: "反推出可复用于 AI 视频生成的提示词" },
  { label: "提取口播文案", instruction: "提取视频中的口播文案和字幕要点" },
] as const;

// 与 Mono 插件同源的链接提取规则：先按平台专属模式匹配，最后兜底匹配任意 URL。
const VIDEO_URL_PATTERNS = [
  /https?:\/\/v\.douyin\.com\/[A-Za-z0-9_\-]+\/?/,
  /https?:\/\/www\.douyin\.com\/video\/\d+/,
  /https?:\/\/v\.kuaishou\.com\/[A-Za-z0-9_\-]+\/?/,
  /https?:\/\/www\.kuaishou\.com\/short-video\/[A-Za-z0-9_\-]+/,
  /https?:\/\/www\.xiaohongshu\.com\/(?:explore|discovery\/item)\/[A-Za-z0-9]+/,
  /https?:\/\/xhslink\.com\/[A-Za-z0-9_\-]+\/?/,
  /https?:\/\/www\.tiktok\.com\/@[^\/\s]+\/video\/\d+/,
  /https?:\/\/vm\.tiktok\.com\/[A-Za-z0-9_\-]+\/?/,
  /https?:\/\/www\.bilibili\.com\/video\/[A-Za-z0-9]+/,
  /https?:\/\/b23\.tv\/[A-Za-z0-9_\-]+\/?/,
  /https?:\/\/[^\s，。；]+/,
] as const;

function extractVideoUrl(text: string): string | null {
  for (const pattern of VIDEO_URL_PATTERNS) {
    const match = text.match(pattern);
    if (match) return match[0];
  }
  return null;
}

type Platform = { name: string; shareOnly: boolean };

// shareOnly 平台的链接是分享页而非视频直链，需要服务端解析；目前仅接了抖音。
function detectPlatform(url: string): Platform | null {
  if (/douyin\.com/i.test(url)) return { name: "抖音", shareOnly: true };
  if (/kuaishou\.com/i.test(url)) return { name: "快手", shareOnly: true };
  if (/xiaohongshu\.com|xhslink\.com/i.test(url)) return { name: "小红书", shareOnly: true };
  if (/tiktok\.com/i.test(url)) return { name: "TikTok", shareOnly: true };
  if (/bilibili\.com|b23\.tv/i.test(url)) return { name: "B站", shareOnly: true };
  return null;
}

export const VideoAnalysisLauncher: FC<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (prompt: string) => void;
}> = ({ open, onOpenChange, onSubmit }) => {
  const [text, setText] = useState("");
  const [focusLabel, setFocusLabel] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const trimmed = text.trim();
  const detectedUrl = trimmed ? extractVideoUrl(trimmed) : null;
  const platform = detectedUrl ? detectPlatform(detectedUrl) : null;
  // 仅抖音的分享页有服务端解析；其余平台分享页拦下，直链一律放行。
  const unsupportedPlatform = platform?.shareOnly && platform.name !== "抖音";
  const submittable = Boolean(detectedUrl) && !unsupportedPlatform;
  const showNoUrlError = touched && trimmed !== "" && !detectedUrl;

  const reset = () => {
    setText("");
    setFocusLabel(null);
    setTouched(false);
    setUploading(false);
    setUploadError(null);
  };

  const focusSuffix = () => {
    const focus = FOCUS_OPTIONS.find((option) => option.label === focusLabel);
    return focus ? `，${focus.instruction}` : "";
  };

  const submit = () => {
    if (!submittable || !detectedUrl) {
      setTouched(true);
      return;
    }
    onSubmit(`分析这个视频：${detectedUrl}${focusSuffix()}`);
    onOpenChange(false);
    reset();
  };

  // 本地视频先流式上传落盘，再以素材 id 发起分析（大文件不过 data URL）。
  const uploadAndSubmit = async (file: File) => {
    setUploading(true);
    setUploadError(null);
    try {
      const response = await fetch("/api/workbench/mono/uploads", {
        method: "POST",
        headers: {
          "Content-Type": file.type || "video/mp4",
          "x-workbench-filename": encodeURIComponent(file.name),
        },
        body: file,
      });
      const payload = (await response.json()) as { asset?: { id: string }; error?: string };
      if (!response.ok || !payload.asset) throw new Error(payload.error ?? "上传失败");
      onSubmit(`分析视频素材 ${payload.asset.id}（${file.name}）${focusSuffix()}`);
      onOpenChange(false);
      reset();
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : "上传失败，请重试");
      setUploading(false);
    }
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
            粘贴视频直链、整段抖音分享口令，或上传本地视频，选择分析重点。
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <textarea
            value={text}
            autoFocus
            rows={2}
            onChange={(event) => setText(event.target.value)}
            onBlur={() => setTouched(true)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
            }}
            placeholder="https://example.com/video.mp4 或「8.32 复制打开抖音…」分享口令"
            aria-invalid={showNoUrlError}
            className={cn(
              "bg-background w-full resize-none rounded-lg border px-3 py-2 text-sm outline-none transition-colors focus:ring-2",
              showNoUrlError && "border-destructive",
            )}
          />
          {detectedUrl ? (
            unsupportedPlatform ? (
              <p className="text-destructive text-xs">
                检测到{platform!.name}分享链接，暂仅支持抖音分享链接或视频直链
              </p>
            ) : (
              <p className="text-muted-foreground text-xs break-all">
                已识别{platform ? `${platform.name}链接` : "链接"}：{detectedUrl}
              </p>
            )
          ) : showNoUrlError ? (
            <p className="text-destructive text-xs">
              未检测到有效链接，请粘贴 http(s) 视频直链或分享口令
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
          <input
            ref={fileInputRef}
            type="file"
            accept="video/*"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void uploadAndSubmit(file);
            }}
          />
          {uploadError ? (
            <p className="text-destructive text-xs">{uploadError}</p>
          ) : null}
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            className="rounded-full"
            disabled={uploading}
            onClick={() => fileInputRef.current?.click()}
          >
            {uploading ? (
              <LoaderCircleIcon className="size-4 animate-spin" />
            ) : (
              <UploadIcon className="size-4" />
            )}
            {uploading ? "正在上传" : "上传本地视频"}
          </Button>
          <Button onClick={submit} disabled={!submittable || uploading} className="rounded-full">
            开始分析
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
