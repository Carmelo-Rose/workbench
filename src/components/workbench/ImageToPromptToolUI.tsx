"use client";

import { makeAssistantToolUI } from "@assistant-ui/react";
import type {
  ImageToPromptArgs,
  ImageToPromptResult,
} from "@/lib/tools/image-to-prompt";

/**
 * 生成式 UI 卡片：把 image_to_prompt 工具的调用/结果渲染成对话里的一张卡片。
 * 这就是"渐进式披露"落到技术上的那一下——能力的结果不是一段裸文字，而是从对话里长出的卡片。
 */
export const ImageToPromptToolUI = makeAssistantToolUI<
  ImageToPromptArgs,
  ImageToPromptResult
>({
  toolName: "image_to_prompt",
  render: ({ args, result }) => {
    return (
      <div className="my-3 w-full overflow-hidden rounded-2xl border border-border/70 bg-card/80 shadow-sm backdrop-blur">
        <div className="text-muted-foreground flex items-center gap-2 border-b border-border/60 px-4 py-3 text-xs">
          <span className="bg-foreground inline-block size-2 rounded-full" />
          图 → 提示词
        </div>

        <div className="p-4">
          {args?.imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={args.imageUrl}
              alt="待反推的图片"
              className="mb-3 max-h-56 w-auto rounded-xl border border-border/70 object-contain"
            />
          ) : null}

          {result?.prompt ? (
            <pre className="text-foreground whitespace-pre-wrap break-words font-sans text-sm leading-relaxed">
              {result.prompt}
            </pre>
          ) : (
            <div className="text-muted-foreground flex items-center gap-2 text-sm">
              <span className="bg-muted-foreground h-1.5 w-1.5 animate-pulse rounded-full" />
              正在反推提示词…
            </div>
          )}
        </div>
      </div>
    );
  },
});
