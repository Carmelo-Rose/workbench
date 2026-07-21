"use client";

import { makeAssistantToolUI, useAui } from "@assistant-ui/react";
import { useImage2Mode } from "@/lib/image2-mode";
import {
  CheckIcon,
  LoaderCircleIcon,
  PlaySquareIcon,
  RefreshCwIcon,
  ScissorsIcon,
  SparklesIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { MonoImageBatchGallery, type MonoGalleryImage } from "@/components/workbench/MonoImageBatch";
import type {
  MonoAsset,
  MonoAssetInput,
  MonoImageGenerationInput,
  MonoJob,
  MonoMattingInput,
  MonoVideoAnalysisInput,
} from "@/lib/mono/contracts";

type JobCardProps = {
  initialJob?: MonoJob;
  kind: MonoJob["kind"];
  children: (job: MonoJob) => ReactNode;
  onRetry?: (job: MonoJob) => void;
  inline?: boolean;
};

const JOB_TITLES: Record<MonoJob["kind"], string> = {
  image_generation: "图片生成",
  video_analysis: "视频分析",
  matting: "抠像换背景",
};

const terminalStatuses = new Set<MonoJob["status"]>([
  "succeeded",
  "failed",
  "cancelled",
]);

const jobMeta: Record<MonoJob["status"], { label: string; tone: string }> = {
  queued: { label: "已提交", tone: "text-muted-foreground" },
  running: { label: "正在处理", tone: "text-foreground" },
  succeeded: { label: "已完成", tone: "text-emerald-600 dark:text-emerald-400" },
  failed: { label: "未完成", tone: "text-destructive" },
  cancelled: { label: "已取消", tone: "text-muted-foreground" },
};

function isMonoJob(value: unknown): value is MonoJob {
  return typeof value === "object" && value !== null && "id" in value && "status" in value;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** 参考图可能是 data URL，也可能是图片服务上的地址（后者要走同源代理才绕得过 CORS）。 */
async function toFile(url: string, name: string): Promise<File | null> {
  try {
    const blob = await (await fetch(url)).blob();
    const extension = (blob.type.split("/")[1] || "png").replace(/[^a-z0-9]/gi, "");
    return new File([blob], `${name}.${extension}`, { type: blob.type || "image/png" });
  } catch {
    return null;
  }
}

function JobCard({ initialJob, kind, children, onRetry, inline = false }: JobCardProps) {
  const [polledJob, setPolledJob] = useState<MonoJob | undefined>();
  const [pollError, setPollError] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  // 图片生成的「停止」是软停止：点了之后 job 可能还在跑（正在收尾最后一张），
  // 这个状态让按钮在那段收尾期间保持禁用，不给用户第二次点、也不假装什么都没发生。
  // 记的是「对哪个 job id 点过停止」而不是一个裸 boolean，新任务 id 一来
  // 天然就不再匹配，不用额外的 effect 去重置。
  const [stopRequestedJobId, setStopRequestedJobId] = useState<string | null>(null);

  // A new tool call supplies a new id, so an older polling result must not
  // replace it while React is reconciling the message stream.
  const job = polledJob?.id === initialJob?.id ? polledJob : initialJob;
  const jobId = job?.id;
  const jobStatus = job?.status;
  const stopRequested = stopRequestedJobId !== null && stopRequestedJobId === jobId;

  useEffect(() => {
    if (!jobId || !jobStatus || terminalStatuses.has(jobStatus)) return undefined;

    let disposed = false;
    const refresh = async () => {
      try {
        const response = await fetch(
          `/api/workbench/mono/jobs/${encodeURIComponent(jobId)}`,
          { cache: "no-store" },
        );
        const payload = (await response.json()) as { job?: MonoJob };
        if (!response.ok || !payload.job) throw new Error("任务状态暂不可用");
        if (!disposed) {
          setPollError(false);
          setPolledJob(payload.job);
        }
      } catch {
        if (!disposed) setPollError(true);
      }
    };

    void refresh();
    const timer = window.setInterval(() => void refresh(), 2_000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [jobId, jobStatus]);

  const cancel = async () => {
    if (!job || terminalStatuses.has(job.status)) return;
    setIsCancelling(true);
    try {
      const response = await fetch(
        `/api/workbench/mono/jobs/${encodeURIComponent(job.id)}`,
        { method: "DELETE" },
      );
      const payload = (await response.json()) as { job?: MonoJob };
      if (!response.ok || !payload.job) throw new Error("取消失败");
      setPolledJob(payload.job);
      // 图片生成任务软停止后 job 仍是 running（在等最后一次请求收尾），
      // 不是「取消失败」——但也不该让按钮变回可点，用这个状态锁住它。
      if (!terminalStatuses.has(payload.job.status)) setStopRequestedJobId(payload.job.id);
    } catch {
      setPollError(true);
    } finally {
      setIsCancelling(false);
    }
  };

  const title = JOB_TITLES[kind];

  if (!job) {
    if (inline) {
      return <p className="text-muted-foreground my-3 flex items-center gap-2 text-sm"><LoaderCircleIcon className="size-4 animate-spin" />正在创建图片…</p>;
    }
    return (
      <TaskShell title={title} status="正在准备" icon={<LoaderCircleIcon className="size-4 animate-spin" />}>
        <p className="text-muted-foreground text-sm">正在提交任务…</p>
      </TaskShell>
    );
  }

  const meta = jobMeta[job.status];
  const isActive = !terminalStatuses.has(job.status);
  if (inline) {
    return (
      <section className="my-3 w-full">
        <div className="text-muted-foreground mb-3 flex items-center justify-between gap-3 text-sm">
          <span className="flex items-center gap-2">
            {isActive ? <LoaderCircleIcon className="size-4 animate-spin" /> : job.status === "succeeded" ? <CheckIcon className="size-4" /> : <XIcon className="size-4" />}
            {/* 图片任务串行执行，排队和真正在跑要分开说，否则用户只看到一个转圈。 */}
            <span>{job.status === "queued" ? "排队中，等前面的任务完成" : isActive ? "正在创建图片" : job.status === "succeeded" ? "图片已生成" : meta.label}</span>
          </span>
          {isActive ? (
            <Button variant="ghost" size="xs" onClick={() => void cancel()} disabled={isCancelling || stopRequested}>
              {stopRequested ? "正在收尾" : isCancelling ? "正在停止" : "停止"}
            </Button>
          ) : null}
        </div>
        {stopRequested && isActive ? (
          <p className="text-muted-foreground -mt-2 mb-3 text-xs">已停止后续重试，正在等这张的结果</p>
        ) : null}
        {children(job)}
        {pollError && isActive ? <p className="text-muted-foreground mt-3 text-xs">任务仍在后台执行，正在重新连接…</p> : null}
        {(job.status === "failed" || job.status === "cancelled") && onRetry ? (
          <Button variant="outline" size="sm" className="mt-3" onClick={() => onRetry(job)}><RefreshCwIcon />重新生成</Button>
        ) : null}
      </section>
    );
  }
  return (
    <TaskShell
      title={title}
      status={meta.label}
      statusClassName={meta.tone}
      icon={
        isActive ? <LoaderCircleIcon className="size-4 animate-spin" /> :
        job.status === "succeeded" ? <CheckIcon className="size-4" /> :
        <XIcon className="size-4" />
      }
      action={
        isActive ? (
          <Button variant="ghost" size="xs" onClick={() => void cancel()} disabled={isCancelling || stopRequested}>
            {stopRequested ? "正在收尾" : isCancelling ? "正在停止" : "停止"}
          </Button>
        ) : null
      }
    >
      {children(job)}
      {pollError && isActive ? (
        <p className="text-muted-foreground mt-3 text-xs">任务仍在后台执行，正在重新连接…</p>
      ) : null}
      {job.status === "failed" ? (
        <div className="mt-3 flex items-center justify-between gap-3 rounded-xl bg-destructive/8 px-3 py-2.5">
          <p className="text-sm">任务没有完成，请调整描述后重试。</p>
          {onRetry ? (
            <Button variant="outline" size="xs" onClick={() => onRetry(job)}>
              <RefreshCwIcon />
              重试
            </Button>
          ) : null}
        </div>
      ) : null}
    </TaskShell>
  );
}

function TaskShell({
  title,
  status,
  statusClassName = "text-muted-foreground",
  icon,
  action,
  children,
}: {
  title: string;
  status: string;
  statusClassName?: string;
  icon: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="my-3 w-full overflow-hidden rounded-2xl border border-border/70 bg-card/80 shadow-sm backdrop-blur">
      <header className="flex items-center justify-between gap-3 border-b border-border/60 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="bg-muted flex size-7 items-center justify-center rounded-lg">
            <SparklesIcon className="size-3.5" />
          </span>
          <span className="font-medium">{title}</span>
          <span className={`flex items-center gap-1 text-xs ${statusClassName}`}>
            {icon}
            {status}
          </span>
        </div>
        {action}
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
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
      const files = await Promise.all(references.map((url, index) => toFile(url, `原参考图-${index + 1}`)));
      useImage2Mode.getState().handoffToComposer({
        text: input.prompt ?? prompt ?? "",
        files: files.filter((file): file is File => file !== null),
      });
    })();
  };

  // 挂成输入框附件而不是直接发一条带 URL 的消息，用户可以先补充要改什么。
  const attachAsReference = (image: MonoGalleryImage) => {
    void (async () => {
      const file = await toFile(image.fetchUrl, `参考图-${image.index + 1}`);
      useImage2Mode.getState().handoffToComposer(
        file
          ? { appendFiles: [file] }
          : { text: `以这张图片为参考继续创作：${image.displayUrl}` },
      );
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
