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
      <div className="my-2 w-full overflow-hidden rounded-2xl border border-black/10 bg-white/70 backdrop-blur">
        <div className="flex items-center gap-2 border-b border-black/5 px-4 py-2.5 text-xs text-black/50">
          <span className="inline-block h-2 w-2 rounded-full bg-black" />
          图 → 提示词
        </div>

        <div className="p-4">
          {args?.imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={args.imageUrl}
              alt="待反推的图片"
              className="mb-3 max-h-56 w-auto rounded-lg border border-black/5 object-contain"
            />
          ) : null}

          {result?.prompt ? (
            <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed text-black/80">
              {result.prompt}
            </pre>
          ) : (
            <div className="flex items-center gap-2 text-sm text-black/40">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-black/40" />
              正在反推提示词…
            </div>
          )}
        </div>
      </div>
    );
  },
});
