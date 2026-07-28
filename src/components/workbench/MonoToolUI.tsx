"use client";

import { makeAssistantToolUI, useAui } from "@assistant-ui/react";
import { useImage2Mode } from "@/lib/image2-mode";
import {
  CheckIcon,
  LoaderCircleIcon,
  PlaySquareIcon,
  RefreshCwIcon,
  ScissorsIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { JobCard, TaskShell } from "@/components/workbench/JobCard";
import { MonoImageBatchGallery, type MonoGalleryImage } from "@/components/workbench/MonoImageBatch";
import { ProductPipelineCard } from "@/components/workbench/ProductPipelineCard";
import { imageReferenceToFile } from "@/lib/image-reference";
import type {
  MonoAsset,
  MonoAssetInput,
  MonoImageGenerationInput,
  MonoJob,
  MonoMattingInput,
  MonoVideoAnalysisInput,
} from "@/lib/mono/contracts";

function isMonoJob(value: unknown): value is MonoJob {
  return typeof value === "object" && value !== null && "id" in value && "status" in value;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function promptSummary(prompt: string | undefined) {
  if (!prompt) return "正在整理画面描述";
  return prompt.length > 140 ? `${prompt.slice(0, 140)}…` : prompt;
}

function ImageGenerationCard({
  args,
  result,
}: {
  args: Partial<MonoImageGenerationInput>;
  result?: MonoJob;
}) {
  const prompt = args.prompt;

  /**
   * 回填而不是直接发送：原来是 append 一条「请重新生成…」的纯文本消息，
   * 既不给用户改的机会，也丢掉了原始参考图——模型只剩提示词，图生图退化成文生图。
   * 这里把原任务的提示词和参考图一起还原进输入框，由用户确认后再发。
   *
   * 传进来的 job 是工具结果的瘦身版（见 lib/tools/mono.ts 的 lightenMonoJob），
   * referenceImageUrls 已被替换成 referenceImageCount，原始地址取不到了，
   * 所以这里先按 id 单独拉一次全量 job 再取参考图。
   */
  const regenerate = (job: MonoJob) => {
    void (async () => {
      let input = job.input as { prompt?: string; referenceImageUrls?: unknown };
      if (!Array.isArray(input.referenceImageUrls)) {
        try {
          const response = await fetch(`/api/workbench/mono/jobs/${encodeURIComponent(job.id)}`, { cache: "no-store" });
          const payload = await response.json() as { job?: MonoJob };
          if (response.ok && payload.job) input = payload.job.input as typeof input;
        } catch {
          // 拉取失败时退回只带提示词，用户仍可以手动补参考图。
        }
      }
      const references = Array.isArray(input.referenceImageUrls)
        ? input.referenceImageUrls.filter((url): url is string => typeof url === "string")
        : [];
      const files = await Promise.all(references.map((url, index) => imageReferenceToFile(url, `原参考图-${index + 1}`)));
      useImage2Mode.getState().handoffToComposer({
        text: input.prompt ?? prompt ?? "",
        files: files.filter((file): file is File => file !== null),
      });
    })();
  };

  // 只挂成输入框附件，不再把失败时的图片 URL写进输入框；失败交给卡片按钮提示并重试。
  const attachAsReference = (image: MonoGalleryImage) => {
    return (async () => {
      const file = await imageReferenceToFile(image.fetchUrl, `参考图-${image.index + 1}`);
      if (!file) throw new Error("参考图下载失败");
      useImage2Mode.getState().handoffToComposer({ appendFiles: [file] });
    })();
  };

  return (
    <JobCard initialJob={isMonoJob(result) ? result : undefined} kind="image_generation" onRetry={regenerate} inline>
      {(job) => {
        // 瘦身后的工具结果没有 referenceImageUrls，只有计数；实时轮询拿到的
        // 全量 job 两者都可能有，两个来源都要认。
        const references = Array.isArray(job.input.referenceImageUrls)
          ? job.input.referenceImageUrls.length
          : typeof job.input.referenceImageCount === "number"
            ? job.input.referenceImageCount
            : 0;
        const aspectRatio = stringValue(job.input.aspectRatio) ?? args.aspectRatio ?? "1:1";

        if (job.result && "slots" in job.result) {
          return (
            <div>
              <MonoImageBatchGallery job={job} onUseAsReference={attachAsReference} />
              {job.status === "succeeded" ? <div className="mt-3 flex flex-wrap gap-2">
                <Button variant="outline" size="sm" onClick={() => regenerate(job)} title="把原提示词和参考图填回输入框">
                  <RefreshCwIcon />
                  再次生成
                </Button>
              </div> : null}
            </div>
          );
        }

        // 走到这里说明任务在真正开始生成之前就被取消了（还在排队），
        // 没有任何请求发给过图片服务。真正在跑之后再停止，会走上面带 slots 的分支——
        // 已经在飞的那次请求会被放行跑完，结果仍然按每张图分别展示。
        if (job.status === "cancelled") {
          return <p className="text-muted-foreground text-sm">已取消，还没提交给图片服务，不会产生费用。</p>;
        }

        return (
          <div className="space-y-3">
            <p className="text-sm leading-6">{promptSummary(prompt)}</p>
            <div className="text-muted-foreground flex flex-wrap gap-2 text-xs">
              <span className="bg-muted rounded-full px-2.5 py-1">{aspectRatio}</span>
              {references > 0 ? <span className="bg-muted rounded-full px-2.5 py-1">{references} 张参考图</span> : null}
            </div>
          </div>
        );
      }}
    </JobCard>
  );
}

function VideoAnalysisCard({
  args,
  result,
}: {
  args: Partial<MonoVideoAnalysisInput>;
  result?: MonoJob;
}) {
  const aui = useAui();
  const videoUrl = args.videoUrl;
  const retry = () => {
    aui.thread().append({
      content: [{ type: "text", text: `请重新分析这段视频：${videoUrl ?? ""}` }],
      runConfig: aui.composer().getState().runConfig,
    });
  };

  return (
    <JobCard initialJob={isMonoJob(result) ? result : undefined} kind="video_analysis" onRetry={retry}>
      {(job) => {
        const analysis = stringValue(job.result?.text);
        if (job.status === "succeeded" && analysis) {
          return <p className="whitespace-pre-wrap text-sm leading-6">{analysis}</p>;
        }
        if (job.status === "cancelled") return <p className="text-muted-foreground text-sm">视频分析已停止。</p>;
        return (
          <div className="text-muted-foreground flex items-center gap-2 text-sm">
            <PlaySquareIcon className="size-4" />
            正在分析视频内容、镜头和节奏…
          </div>
        );
      }}
    </JobCard>
  );
}

const MATTING_STAGES: Record<string, string> = {
  uploading: "正在上传素材到处理后端…",
  processing: "GPU 正在抠像处理…",
  downloading: "正在取回处理结果…",
};

function MattingCard({ result }: { result?: MonoJob }) {
  return (
    <JobCard initialJob={isMonoJob(result) ? result : undefined} kind="matting">
      {(job) => {
        const url = stringValue(job.result?.url);
        if (job.status === "succeeded" && url) {
          const isVideo = job.result?.mediaType === "video";
          return (
            <div className="space-y-2">
              {isVideo ? (
                <video controls src={url} className="max-h-80 w-full rounded-xl bg-muted" />
              ) : (
                // 结果可能是透明背景 PNG，用棋盘格底衬出透明区域。
                <img
                  src={url}
                  alt="抠像结果"
                  className="max-h-80 rounded-xl [background:repeating-conic-gradient(#e5e5e5_0%_25%,#fafafa_0%_50%)_0_0/16px_16px]"
                />
              )}
              <a
                href={url}
                download={stringValue(job.result?.filename) ?? "matting-result"}
                className="text-muted-foreground text-xs underline underline-offset-4"
              >
                下载结果文件
              </a>
            </div>
          );
        }
        if (job.status === "cancelled") return <p className="text-muted-foreground text-sm">抠像任务已停止。</p>;
        const stage = stringValue(job.result?.stage);
        return (
          <p className="text-muted-foreground flex items-center gap-2 text-sm">
            <ScissorsIcon className="size-4" />
            {(stage && MATTING_STAGES[stage]) ?? "正在准备抠像任务…"}
          </p>
        );
      }}
    </JobCard>
  );
}

function JobStatusCard({ result }: { result?: MonoJob }) {
  // 商品套图有自己的进度板和画廊；用 mono_get_job 查到它时也该看到那个，
  // 而不是「任务仍在处理中」一句话。
  if (isMonoJob(result) && result.kind === "product_pipeline") {
    return <ProductPipelineCard initialJob={result} />;
  }
  return (
    <JobCard initialJob={isMonoJob(result) ? result : undefined} kind={result?.kind ?? "image_generation"}>
      {(job) => (
        <p className="text-muted-foreground text-sm">
          {job.status === "succeeded" ? "任务结果已准备好。" :
          job.status === "cancelled" ? "任务已停止。" :
          job.status === "failed" ? "任务没有完成。" : "任务仍在处理中。"}
        </p>
      )}
    </JobCard>
  );
}

function AssetCard({ args, result }: { args: Partial<MonoAssetInput>; result?: MonoAsset }) {
  const asset = result && typeof result === "object" && "id" in result ? result : undefined;
  return (
    <TaskShell
      title="素材已加入"
      status={asset ? "已完成" : "正在准备"}
      statusClassName={asset ? "text-emerald-600 dark:text-emerald-400" : undefined}
      icon={asset ? <CheckIcon className="size-4" /> : <LoaderCircleIcon className="size-4 animate-spin" />}
    >
      <p className="text-muted-foreground truncate text-sm">{asset?.name ?? args.name ?? "正在登记素材…"}</p>
    </TaskShell>
  );
}

export const MonoGenerateImageToolUI = makeAssistantToolUI<
  MonoImageGenerationInput,
  MonoJob
>({
  toolName: "mono_generate_image",
  display: "standalone",
  render: (props) => <ImageGenerationCard args={props.args} result={props.result} />,
});

export const MonoAnalyzeVideoToolUI = makeAssistantToolUI<
  MonoVideoAnalysisInput,
  MonoJob
>({
  toolName: "mono_analyze_video",
  display: "standalone",
  render: (props) => <VideoAnalysisCard args={props.args} result={props.result} />,
});

export const MonoMattingToolUI = makeAssistantToolUI<MonoMattingInput, MonoJob>({
  toolName: "mono_matting",
  display: "standalone",
  render: (props) => <MattingCard result={props.result} />,
});

export const MonoCreateAssetToolUI = makeAssistantToolUI<MonoAssetInput, MonoAsset>({
  toolName: "mono_create_asset",
  display: "standalone",
  render: (props) => <AssetCard args={props.args} result={props.result} />,
});

export const MonoGetJobToolUI = makeAssistantToolUI<{ jobId: string }, MonoJob>({
  toolName: "mono_get_job",
  display: "standalone",
  render: (props) => <JobStatusCard result={props.result} />,
});

export const MonoCancelJobToolUI = makeAssistantToolUI<{ jobId: string }, MonoJob>({
  toolName: "mono_cancel_job",
  display: "standalone",
  render: (props) => <JobStatusCard result={props.result} />,
});

/**
 * One renderer, two callers.
 *
 * The folder picker and the "只重跑失败槽位" button (via
 * `startProductPipelineRun`, lib/product-pipeline-run.ts) send a real chat turn
 * carrying `config.productPipeline`, which `productPipelineResponse` in
 * src/app/api/chat/route.ts turns into a synthesized `mono_product_pipeline`
 * tool result with no LLM call; the agent tool of the same name
 * (lib/tools/mono.ts) produces the identical shape. `makeAssistantToolUI`
 * matches purely on `toolName`, so both land here.
 *
 * `folderName` comes from the args rather than the job because the resolved
 * share-relative path is stripped on its way to the browser (`lightenMonoJob`),
 * and a queued job has no result to read it back from yet.
 */
export const MonoProductPipelineToolUI = makeAssistantToolUI<
  { folderId?: string; folderName?: string; workflowId?: string; onlySlots?: string[] },
  MonoJob
>({
  toolName: "mono_product_pipeline",
  display: "standalone",
  render: (props) => (
    <ProductPipelineCard
      initialJob={isMonoJob(props.result) ? props.result : undefined}
      folderName={props.args?.folderName}
    />
  ),
});
