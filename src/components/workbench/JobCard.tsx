"use client";

import { CheckIcon, LoaderCircleIcon, RefreshCwIcon, SparklesIcon, XIcon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import type { MonoJob } from "@/lib/mono/contracts";

/**
 * Shared job shell for every mono capability card.
 *
 * Lives in its own module rather than in MonoToolUI.tsx because the cards it
 * wraps are also imported *by* MonoToolUI to register their tool UIs — keeping
 * it there made MonoToolUI and ProductPipelineCard import each other, which
 * survives a cold build but is exactly the shape that turns into an undefined
 * component after a hot update.
 */

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
  product_pipeline: "商品套图",
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

export function JobCard({ initialJob, kind, children, onRetry, inline = false }: JobCardProps) {
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

export function TaskShell({
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
