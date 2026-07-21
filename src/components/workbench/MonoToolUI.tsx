"use client";

import { makeAssistantToolUI, useAui } from "@assistant-ui/react";
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

function JobCard({ initialJob, kind, children, onRetry, inline = false }: JobCardProps) {
  const [polledJob, setPolledJob] = useState<MonoJob | undefined>();
  const [pollError, setPollError] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);

  // A new tool call supplies a new id, so an older polling result must not
  // replace it while React is reconciling the message stream.
  const job = polledJob?.id === initialJob?.id ? polledJob : initialJob;
  const jobId = job?.id;
  const jobStatus = job?.status;

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
          {isActive ? <Button variant="ghost" size="xs" onClick={() => void cancel()} disabled={isCancelling}>{isCancelling ? "正在停止" : "停止"}</Button> : null}
        </div>
        {children(job)}
        {pollError && isActive ? <p className="text-muted-foreground mt-3 text-xs">任务仍在后台执行，正在重新连接…</p> : null}
        {job.status === "failed" && onRetry ? (
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
          <Button variant="ghost" size="xs" onClick={() => void cancel()} disabled={isCancelling}>
            {isCancelling ? "正在停止" : "停止"}
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
            <Button variant="outline" size="xs" onClick={onRetry}>
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
  const aui = useAui();
  const prompt = args.prompt;
  const retry = () => {
    aui.thread().append({
      content: [{ type: "text", text: `请重新生成这张图片：${prompt ?? ""}` }],
      runConfig: aui.composer().getState().runConfig,
    });
  };

  // 挂成输入框附件而不是直接发一条带 URL 的消息，用户可以先补充要改什么。
  const attachAsReference = async (image: MonoGalleryImage) => {
    try {
      const blob = await (await fetch(image.fetchUrl)).blob();
      await aui.composer().addAttachment(
        new File([blob], `参考图-${image.index + 1}.png`, { type: blob.type || "image/png" }),
      );
    } catch {
      aui.composer().setText(`以这张图片为参考继续创作：${image.displayUrl}`);
    }
  };

  return (
    <JobCard initialJob={isMonoJob(result) ? result : undefined} kind="image_generation" onRetry={retry} inline>
      {(job) => {
        const references = Array.isArray(job.input.referenceImageUrls)
          ? job.input.referenceImageUrls.length
          : 0;
        const aspectRatio = stringValue(job.input.aspectRatio) ?? args.aspectRatio ?? "1:1";

        if (job.result && "slots" in job.result) {
          return (
            <div>
              <MonoImageBatchGallery
                job={job}
                onUseAsReference={(image) => void attachAsReference(image)}
              />
              {job.status === "succeeded" ? <div className="mt-3 flex flex-wrap gap-2">
                <Button variant="outline" size="sm" onClick={retry}>
                  <RefreshCwIcon />
                  再次生成
                </Button>
              </div> : null}
            </div>
          );
        }

        if (job.status === "cancelled") return <p className="text-muted-foreground text-sm">图片生成已停止。</p>;

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
