"use client";

import { makeAssistantToolUI } from "@assistant-ui/react";
import { CheckIcon, CopyIcon, SparklesIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, type FC } from "react";
import { Button } from "@/components/ui/button";
import { stashImage2Prompt } from "@/lib/mono/image2-handoff";
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
  display: "standalone",
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
            <>
              <pre className="text-foreground whitespace-pre-wrap break-words font-sans text-sm leading-relaxed">
                {result.prompt}
              </pre>
              <PromptActions prompt={result.prompt} />
            </>
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

/** 反推的下一步动作：留在对话里复制，或带着提示词进 Image2 工作台。 */
const PromptActions: FC<{ prompt: string }> = ({ prompt }) => {
  const router = useRouter();
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // 剪贴板权限被拒时静默失败，用户仍可手动选中文本复制。
    }
  };

  const generate = () => {
    stashImage2Prompt(prompt);
    router.push("/mono/image2");
  };

  return (
    <div className="mt-3 flex flex-wrap gap-2">
      <Button variant="outline" size="sm" onClick={() => void copy()}>
        {copied ? <CheckIcon /> : <CopyIcon />}
        {copied ? "已复制" : "复制提示词"}
      </Button>
      <Button size="sm" onClick={generate}>
        <SparklesIcon />
        用它生图
      </Button>
    </div>
  );
};
