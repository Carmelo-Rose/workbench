"use client";

import { makeAssistantToolUI } from "@assistant-ui/react";
import {
  useEffect,
  useRef,
  useState,
  type FC,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import {
  capabilityName,
  isTerminalStatus,
  primaryVideoArtifact,
  type JobInfo,
  type ToolboxRegion,
} from "@/lib/toolbox/types";
import type { VideoEraseArgs, VideoEraseResult } from "@/lib/tools/video-erase";

/**
 * 视频工具箱的通用任务卡片：所有异步视频能力（擦除/抠像/口型/增强…）共用。
 * 支持两种入场方式：
 * - 工具直接返回 jobId（无交互能力，如后续的修复增强）→ 直接进入轮询；
 * - regionFlow（智能擦除 v1）→ 先在首帧上框选区域，卡片内提交后再轮询。
 * 提交出的 jobId 落 localStorage（按 toolCallId 键），刷新页面后继续轮询。
 */

const POLL_INTERVAL_MS = 2000;

const jobStorageKey = (toolCallId: string) => `vt-job:${toolCallId}`;

/** 轮询任务状态；到达终态或组件卸载即停。 */
function useJobPolling(jobId: string | undefined): JobInfo | null {
  const [job, setJob] = useState<JobInfo | null>(null);

  useEffect(() => {
    if (!jobId) return;
    let stopped = false;
    let timer: number | undefined;

    const tick = async () => {
      try {
        const res = await fetch(`/api/toolbox/jobs/${jobId}`, {
          cache: "no-store",
        });
        if (res.ok) {
          const next = (await res.json()) as JobInfo;
          if (stopped) return;
          setJob(next);
          if (isTerminalStatus(next.status)) return;
        }
      } catch {
        // 网关暂时不可达时静默重试，卡片保持上一次状态。
      }
      if (!stopped) timer = window.setTimeout(tick, POLL_INTERVAL_MS);
    };

    void tick();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [jobId]);

  return job;
}

function formatDuration(job: JobInfo): string | null {
  if (!job.started_at || !job.finished_at) return null;
  const seconds = Math.round(
    (new Date(job.finished_at).getTime() - new Date(job.started_at).getTime()) /
      1000,
  );
  if (seconds < 0) return null;
  return seconds < 60
    ? `${seconds} 秒`
    : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

function artifactUrl(jobId: string, path: string): string {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  return `/api/toolbox/jobs/${jobId}/artifacts/${encoded}`;
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

const Spinner: FC<{ label: string }> = ({ label }) => (
  <div className="flex items-center gap-2 text-sm text-black/40">
    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-black/40" />
    {label}
  </div>
);

const ProgressBar: FC<{ progress: number; stage: string }> = ({
  progress,
  stage,
}) => (
  <div className="space-y-1.5">
    <div className="flex items-center justify-between text-xs text-black/50">
      <span>{stage || "处理中…"}</span>
      <span>{Math.max(0, Math.min(100, progress))}%</span>
    </div>
    <div className="h-1.5 overflow-hidden rounded-full bg-black/10">
      <div
        className="h-full rounded-full bg-black transition-[width] duration-500"
        style={{ width: `${Math.max(2, Math.min(100, progress))}%` }}
      />
    </div>
  </div>
);

/** 首帧框选：在视频首帧上拖拽出一个或多个矩形（归一化坐标）。 */
const RegionSelect: FC<{
  fileId: string;
  submitting: boolean;
  submitError?: string;
  onSubmit: (regions: ToolboxRegion[]) => void;
}> = ({ fileId, submitting, submitError, onSubmit }) => {
  const [boxes, setBoxes] = useState<ToolboxRegion[]>([]);
  const [draft, setDraft] = useState<ToolboxRegion | null>(null);
  const [posterFailed, setPosterFailed] = useState(false);
  const [posterKey, setPosterKey] = useState(0);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const startRef = useRef<{ x: number; y: number } | null>(null);

  const toNorm = (e: ReactPointerEvent) => {
    const rect = surfaceRef.current!.getBoundingClientRect();
    return {
      x: clamp01((e.clientX - rect.left) / rect.width),
      y: clamp01((e.clientY - rect.top) / rect.height),
    };
  };

  const handleDown = (e: ReactPointerEvent) => {
    if (submitting || posterFailed) return;
    e.preventDefault();
    surfaceRef.current?.setPointerCapture(e.pointerId);
    const p = toNorm(e);
    startRef.current = p;
    setDraft({ x: p.x, y: p.y, w: 0, h: 0 });
  };

  const handleMove = (e: ReactPointerEvent) => {
    const start = startRef.current;
    if (!start) return;
    const p = toNorm(e);
    setDraft({
      x: Math.min(start.x, p.x),
      y: Math.min(start.y, p.y),
      w: Math.abs(p.x - start.x),
      h: Math.abs(p.y - start.y),
    });
  };

  const handleUp = () => {
    if (draft && draft.w >= 0.01 && draft.h >= 0.01) {
      setBoxes((prev) => [...prev, draft]);
    }
    startRef.current = null;
    setDraft(null);
  };

  const overlays = draft ? [...boxes, draft] : boxes;

  return (
    <div className="space-y-2">
      <p className="text-sm text-black/70">
        在首帧画面上拖拽，框选要擦除的区域（可框多个）
      </p>
      <div
        ref={surfaceRef}
        className="relative cursor-crosshair touch-none select-none overflow-hidden rounded-lg border border-black/10 bg-black/5"
        onPointerDown={handleDown}
        onPointerMove={handleMove}
        onPointerUp={handleUp}
        onPointerCancel={handleUp}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={`/api/toolbox/files/${fileId}/poster${posterKey ? `?r=${posterKey}` : ""}`}
          alt="视频首帧"
          draggable={false}
          onError={() => setPosterFailed(true)}
          onLoad={() => setPosterFailed(false)}
          className="block h-auto w-full"
        />
        {overlays.map((box, i) => (
          <div
            key={i}
            className="pointer-events-none absolute border-2 border-red-500/90 bg-red-500/15"
            style={{
              left: `${box.x * 100}%`,
              top: `${box.y * 100}%`,
              width: `${box.w * 100}%`,
              height: `${box.h * 100}%`,
            }}
          >
            {i < boxes.length && (
              <button
                type="button"
                aria-label="移除此框"
                className="pointer-events-auto absolute -right-2 -top-2 flex h-4 w-4 items-center justify-center rounded-full bg-black text-[10px] leading-none text-white"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() =>
                  setBoxes((prev) => prev.filter((_, idx) => idx !== i))
                }
              >
                ×
              </button>
            )}
          </div>
        ))}
      </div>

      {posterFailed ? (
        <p className="text-sm text-red-600/80">
          首帧加载失败（网关不可达或文件已过期）
          <button
            type="button"
            className="ml-2 underline underline-offset-2"
            onClick={() => {
              setPosterFailed(false);
              setPosterKey((k) => k + 1);
            }}
          >
            重试
          </button>
        </p>
      ) : null}

      <div className="flex items-center gap-3">
        <button
          type="button"
          disabled={boxes.length === 0 || submitting}
          onClick={() => onSubmit(boxes)}
          className="rounded-full bg-black px-4 py-1.5 text-sm text-white transition-opacity disabled:opacity-30"
        >
          {submitting ? "提交中…" : "开始擦除"}
        </button>
        {boxes.length > 0 && (
          <button
            type="button"
            className="text-sm text-black/50 underline underline-offset-2"
            onClick={() => setBoxes([])}
          >
            清空（已框 {boxes.length} 处）
          </button>
        )}
      </div>

      {submitError ? (
        <p className="text-sm text-red-600/80">提交失败：{submitError}</p>
      ) : null}
    </div>
  );
};

export type JobCardResult = {
  jobId?: string;
  videoFileId?: string;
  note?: string;
  error?: string;
};

type JobCardProps = {
  /** 卡片标题，如「智能擦除」。 */
  title: string;
  /** 用于任务恢复的稳定键（刷新后继续轮询）。 */
  toolCallId: string;
  /** 提交给网关的能力 id。 */
  capability: string;
  /** 参数摘要行，如「擦除目标：右下角字幕」。 */
  argsSummary?: string;
  /** true 时需要用户先在首帧框选区域再提交（智能擦除 v1 流程）。 */
  regionFlow?: boolean;
  /** 工具 execute 的返回值；undefined 表示还在准备中。 */
  result?: JobCardResult;
};

export const JobCard: FC<JobCardProps> = ({
  title,
  toolCallId,
  capability,
  argsSummary,
  regionFlow,
  result,
}) => {
  // 服务端不渲染工具卡片（消息历史是客户端拉取的），lazy init 读 localStorage 安全。
  const [localJobId, setLocalJobId] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    try {
      return window.localStorage.getItem(jobStorageKey(toolCallId));
    } catch {
      return null;
    }
  });
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string>();

  const jobId = result?.jobId ?? localJobId ?? undefined;
  const job = useJobPolling(jobId);
  const duration = job ? formatDuration(job) : null;

  const submitRegions = async (regions: ToolboxRegion[]) => {
    if (!result?.videoFileId) return;
    setSubmitting(true);
    setSubmitError(undefined);
    try {
      const res = await fetch("/api/toolbox/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          capability,
          params: { regions },
          inputs: { video: result.videoFileId },
        }),
      });
      const data = (await res.json().catch(() => null)) as
        | (JobInfo & { error?: string })
        | null;
      if (!res.ok || !data?.id) {
        throw new Error(data?.error ?? `提交失败（${res.status}）`);
      }
      try {
        window.localStorage.setItem(jobStorageKey(toolCallId), data.id);
      } catch {
        // localStorage 不可用只影响刷新恢复，不阻塞主流程。
      }
      setLocalJobId(data.id);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "提交失败");
    } finally {
      setSubmitting(false);
    }
  };

  let body: ReactNode;
  if (result?.error) {
    body = <p className="text-sm text-red-600/80">{result.error}</p>;
  } else if (!result) {
    body = <Spinner label="正在准备…" />;
  } else if (jobId) {
    if (!job) {
      body = <Spinner label="正在连接网关…" />;
    } else if (job.status === "queued") {
      body = <Spinner label="排队中，等待 GPU 空闲…" />;
    } else if (job.status === "running") {
      body = <ProgressBar progress={job.progress} stage={job.stage} />;
    } else if (job.status === "failed") {
      body = (
        <div className="space-y-1 text-sm">
          <p className="text-red-600/80">处理失败</p>
          {job.error ? (
            <pre className="whitespace-pre-wrap break-words font-sans text-xs leading-relaxed text-black/50">
              {job.error}
            </pre>
          ) : null}
        </div>
      );
    } else if (job.status === "canceled") {
      body = <p className="text-sm text-black/50">任务已取消</p>;
    } else {
      const video = primaryVideoArtifact(job.artifacts);
      const others = job.artifacts.filter((a) => a !== video);
      body = (
        <div className="space-y-3">
          {video ? (
            <video
              controls
              preload="metadata"
              className="max-h-72 w-full rounded-lg border border-black/5 bg-black/5 object-contain"
              src={artifactUrl(job.id, video.path)}
            />
          ) : (
            <p className="text-sm text-black/50">任务完成，但没有产出文件</p>
          )}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-black/50">
            {duration ? <span>耗时 {duration}</span> : null}
            {video ? (
              <a
                href={artifactUrl(job.id, video.path)}
                download={video.name}
                className="underline underline-offset-2 hover:text-black/80"
              >
                下载 {video.name}
              </a>
            ) : null}
            {others.map((a) => (
              <a
                key={a.path}
                href={artifactUrl(job.id, a.path)}
                download={a.name}
                className="underline underline-offset-2 hover:text-black/80"
              >
                {a.name}
              </a>
            ))}
          </div>
        </div>
      );
    }
  } else if (regionFlow && result.videoFileId) {
    body = (
      <RegionSelect
        fileId={result.videoFileId}
        submitting={submitting}
        submitError={submitError}
        onSubmit={submitRegions}
      />
    );
  } else {
    body = <Spinner label="正在准备…" />;
  }

  return (
    <div className="my-2 w-full overflow-hidden rounded-2xl border border-black/10 bg-white/70 backdrop-blur">
      <div className="flex items-center gap-2 border-b border-black/5 px-4 py-2.5 text-xs text-black/50">
        <span className="inline-block h-2 w-2 rounded-full bg-black" />
        {title}
        {job && !isTerminalStatus(job.status) ? (
          <span className="ml-auto text-black/30">#{job.id}</span>
        ) : null}
      </div>
      <div className="space-y-2 p-4">
        {argsSummary ? (
          <p className="text-sm text-black/70">{argsSummary}</p>
        ) : null}
        {body}
      </div>
    </div>
  );
};

/** 智能擦除的对话卡片。后续能力照此各包一个即可。 */
export const VideoEraseToolUI = makeAssistantToolUI<
  VideoEraseArgs,
  VideoEraseResult
>({
  toolName: "video_erase",
  render: ({ args, result, toolCallId }) => (
    <JobCard
      title={capabilityName("smart_erase")}
      toolCallId={toolCallId}
      capability="smart_erase"
      regionFlow
      argsSummary={args?.note ? `擦除目标：${args.note}` : undefined}
      result={result ?? undefined}
    />
  ),
});
