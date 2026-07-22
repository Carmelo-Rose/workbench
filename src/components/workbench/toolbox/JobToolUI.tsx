"use client";

import { makeAssistantToolUI } from "@assistant-ui/react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FC,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import {
  capabilityName,
  chainTargets,
  isTerminalStatus,
  primaryVideoArtifact,
  type JobInfo,
  type ToolboxRegion,
} from "@/lib/toolbox/types";
import type { VideoEraseArgs, VideoEraseResult } from "@/lib/tools/video-erase";
import type { VideoEnhanceArgs, VideoEnhanceResult } from "@/lib/tools/video-enhance";
import type { VideoMattingArgs, VideoMattingResult } from "@/lib/tools/video-matting";

/**
 * 视频工具箱的通用任务卡片：所有异步视频能力（擦除/抠像/口型/增强…）共用。
 * 支持两种入场方式：
 * - 工具直接返回 jobId（无交互能力，如修复增强）→ 直接进入轮询；
 * - regionFlow（智能擦除 v1）→ 先在首帧上框选区域，卡片内提交后再轮询。
 *
 * 一张卡片可以承载多个「步骤」：第一个是本次调用的任务，后续是用户在成功态
 * 点「继续 …」串联出来的任务（复用上一步产物，见网关的 job:<id>/<产物> 引用）。
 * 步骤列表落 localStorage（按 toolCallId 键），刷新页面后继续轮询。
 */

const POLL_INTERVAL_MS = 2000;

/** 卡片里的一个任务步骤。 */
type JobStepRef = { capability: string; jobId: string };

const jobStorageKey = (toolCallId: string) => `vt-job:${toolCallId}`;

/** 读回步骤列表；旧版本存的是裸 jobId 字符串，按当前能力补齐成一个步骤。 */
function loadSteps(toolCallId: string, capability: string): JobStepRef[] {
  if (typeof window === "undefined") return [];
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(jobStorageKey(toolCallId));
  } catch {
    return [];
  }
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as JobStepRef[];
  } catch {
    // 不是 JSON，说明是旧格式的裸 jobId。
  }
  return [{ capability, jobId: raw }];
}

function saveSteps(toolCallId: string, steps: JobStepRef[]): void {
  try {
    window.localStorage.setItem(jobStorageKey(toolCallId), JSON.stringify(steps));
  } catch {
    // localStorage 不可用只影响刷新恢复，不阻塞主流程。
  }
}

function formatSeconds(seconds: number): string {
  if (seconds < 0) return "0 秒";
  return seconds < 60
    ? `${seconds} 秒`
    : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

/** 完成后的总耗时。 */
function finishedDuration(job: JobInfo): string | null {
  if (!job.started_at || !job.finished_at) return null;
  const seconds = Math.round(
    (new Date(job.finished_at).getTime() - new Date(job.started_at).getTime()) /
      1000,
  );
  return seconds < 0 ? null : formatSeconds(seconds);
}

function artifactUrl(jobId: string, path: string): string {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  return `/api/toolbox/jobs/${jobId}/artifacts/${encoded}`;
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** 提交任务的统一出口（首次提交、重试、串联共用）。 */
async function postJob(body: {
  capability: string;
  params?: Record<string, unknown>;
  inputs?: Record<string, string>;
}): Promise<JobInfo> {
  const res = await fetch("/api/toolbox/jobs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => null)) as
    | (JobInfo & { error?: string })
    | null;
  if (!res.ok || !data?.id) {
    throw new Error(data?.error ?? `提交失败（${res.status}）`);
  }
  return data;
}

/** 轮询任务状态；到达终态或组件卸载即停。 */
function useJobPolling(jobId: string | undefined): JobInfo | null {
  const [job, setJob] = useState<JobInfo | null>(null);

  // jobId 变化时不用手动清状态：JobStep 以 jobId 为 key，换 id 即整体重挂。
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

/**
 * 运行中的已用时（秒）；未开始或已终态时返回 null。
 * 读时钟只发生在 interval 回调里（渲染期读 Date.now() 是不纯的），所以头一秒
 * 还没有值，调用方按 null 处理即可——对动辄几分钟的任务无所谓。
 */
function useElapsedSeconds(job: JobInfo | null): number | null {
  const startedAt = job && !isTerminalStatus(job.status) ? job.started_at : null;
  const [elapsed, setElapsed] = useState<number | null>(null);

  useEffect(() => {
    if (!startedAt) return;
    const start = new Date(startedAt).getTime();
    const timer = window.setInterval(
      () => setElapsed(Math.max(0, Math.round((Date.now() - start) / 1000))),
      1000,
    );
    return () => window.clearInterval(timer);
  }, [startedAt]);

  return startedAt ? elapsed : null;
}

const Spinner: FC<{ label: string }> = ({ label }) => (
  <div className="flex items-center gap-2 text-sm text-black/40">
    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-black/40" />
    {label}
  </div>
);

const linkButtonClass =
  "text-xs text-black/50 underline underline-offset-2 transition-colors hover:text-black/80 disabled:opacity-40 disabled:no-underline";

const ProgressBar: FC<{ progress: number; stage: string; elapsed: string | null }> = ({
  progress,
  stage,
  elapsed,
}) => (
  <div className="space-y-1.5">
    <div className="flex items-center justify-between text-xs text-black/50">
      <span>{stage || "处理中…"}</span>
      <span className="tabular-nums">
        {elapsed ? `已用 ${elapsed} · ` : ""}
        {Math.max(0, Math.min(100, progress))}%
      </span>
    </div>
    <div className="h-1.5 overflow-hidden rounded-full bg-black/10">
      <div
        className="h-full rounded-full bg-black transition-[width] duration-500"
        style={{ width: `${Math.max(2, Math.min(100, progress))}%` }}
      />
    </div>
  </div>
);

/** 失败态的日志查看：按需拉取网关的日志尾部。 */
const JobLog: FC<{ jobId: string }> = ({ jobId }) => {
  const [open, setOpen] = useState(false);
  const [log, setLog] = useState<string>();
  const [error, setError] = useState<string>();

  const toggle = async () => {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (log !== undefined || error) return;
    try {
      const res = await fetch(`/api/toolbox/jobs/${jobId}/log`, {
        cache: "no-store",
      });
      const text = await res.text();
      if (!res.ok) throw new Error(text.slice(0, 200) || "日志读取失败");
      setLog(text || "（日志为空）");
    } catch (e) {
      setError(e instanceof Error ? e.message : "日志读取失败");
    }
  };

  return (
    <div className="space-y-1.5">
      <button type="button" className={linkButtonClass} onClick={() => void toggle()}>
        {open ? "收起日志" : "查看日志"}
      </button>
      {open ? (
        <pre className="max-h-52 overflow-auto rounded-lg bg-black/5 p-2.5 text-[11px] leading-relaxed whitespace-pre-wrap text-black/60">
          {error ?? log ?? "读取中…"}
        </pre>
      ) : null}
    </div>
  );
};

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

/**
 * 卡片里的一个任务步骤：轮询 + 排队/运行/失败/取消/成功五态。
 * 重试会把本步骤换成新 jobId，串联则由上层追加一个新步骤。
 */
const JobStep: FC<{
  step: JobStepRef;
  /** 非首个步骤显示「接续上一步产物」。 */
  chained: boolean;
  onReplace: (jobId: string) => void;
  onChain: (capability: string, jobId: string) => void;
}> = ({ step, chained, onReplace, onChain }) => {
  const job = useJobPolling(step.jobId);
  const elapsed = useElapsedSeconds(job);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string>();

  const cancel = async () => {
    setBusy(true);
    setActionError(undefined);
    try {
      const res = await fetch(`/api/toolbox/jobs/${step.jobId}/cancel`, {
        method: "POST",
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(data?.error ?? `取消失败（${res.status}）`);
      }
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "取消失败");
    } finally {
      setBusy(false);
    }
  };

  // 重试直接复用网关回给的 capability / params / inputs，
  // 所以擦除任务不用重新框选（区域就在 params.regions 里）。
  const retry = async () => {
    if (!job) return;
    setBusy(true);
    setActionError(undefined);
    try {
      const next = await postJob({
        capability: job.capability,
        params: job.params,
        inputs: job.inputs,
      });
      onReplace(next.id);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "重试失败");
    } finally {
      setBusy(false);
    }
  };

  const chain = async (capability: string, defaultParams?: Record<string, unknown>) => {
    if (!job) return;
    const video = primaryVideoArtifact(job.artifacts);
    if (!video) return;
    setBusy(true);
    setActionError(undefined);
    try {
      const next = await postJob({
        capability,
        params: defaultParams ?? {},
        inputs: { video: `job:${job.id}/${video.path}` },
      });
      onChain(capability, next.id);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "提交失败");
    } finally {
      setBusy(false);
    }
  };

  let body: ReactNode;
  if (!job) {
    body = <Spinner label="正在连接网关…" />;
  } else if (job.status === "queued") {
    body = <Spinner label="排队中，等待 GPU 空闲…" />;
  } else if (job.status === "running") {
    body = (
      <ProgressBar
        progress={job.progress}
        stage={job.stage}
        elapsed={elapsed === null ? null : formatSeconds(elapsed)}
      />
    );
  } else if (job.status === "failed" || job.status === "canceled") {
    body = (
      <div className="space-y-2 text-sm">
        <p className={job.status === "failed" ? "text-red-600/80" : "text-black/50"}>
          {job.status === "failed" ? "处理失败" : "任务已取消"}
        </p>
        {job.error ? (
          <pre className="whitespace-pre-wrap break-words font-sans text-xs leading-relaxed text-black/50">
            {job.error}
          </pre>
        ) : null}
        <div className="flex items-center gap-3">
          <button
            type="button"
            className={linkButtonClass}
            disabled={busy}
            onClick={() => void retry()}
          >
            {busy ? "提交中…" : "重试"}
          </button>
          <JobLog jobId={job.id} />
        </div>
      </div>
    );
  } else {
    // 4x enhancement returns a high-resolution master plus a browser-friendly rendition.
    // The card plays the compatible file, while chaining continues to use the master.
    const masterVideo = primaryVideoArtifact(job.artifacts);
    const compatibleVideo =
      job.capability === "video_enhance"
        ? job.artifacts.find((a) => a.path === "enhanced_compatible.mp4")
        : undefined;
    const video = compatibleVideo ?? masterVideo;
    const others = job.artifacts.filter((a) => a !== video && a !== masterVideo);
    const duration = finishedDuration(job);
    const targets = masterVideo ? chainTargets(job.capability) : [];
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
          {compatibleVideo ? (
            <>
              <a
                href={artifactUrl(job.id, compatibleVideo.path)}
                download={compatibleVideo.name}
                className="underline underline-offset-2 hover:text-black/80"
              >
                下载兼容版
              </a>
              {masterVideo ? (
                <a
                  href={artifactUrl(job.id, masterVideo.path)}
                  download={masterVideo.name}
                  className="underline underline-offset-2 hover:text-black/80"
                >
                  下载原始 4 倍版
                </a>
              ) : null}
            </>
          ) : video ? (
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
        {targets.length > 0 ? (
          <div className="flex flex-wrap items-center gap-2 border-t border-black/5 pt-3">
            {targets.map((target) => (
              <button
                key={target.id}
                type="button"
                disabled={busy}
                onClick={() => void chain(target.id, target.defaultParams)}
                className="rounded-full border border-black/15 px-3 py-1 text-xs text-black/70 transition-colors hover:bg-black/5 disabled:opacity-40"
              >
                继续{target.name}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    );
  }

  const running = job !== null && !isTerminalStatus(job.status);

  return (
    <div className={chained ? "space-y-2 border-t border-black/5 pt-3" : "space-y-2"}>
      {chained || running ? (
        <div className="flex items-center gap-2 text-xs text-black/40">
          {chained ? (
            <span>
              {capabilityName(step.capability)} · 接续上一步产物
            </span>
          ) : null}
          {running ? (
            <>
              <span className="font-mono text-black/30">#{step.jobId}</span>
              <button
                type="button"
                className={`ml-auto ${linkButtonClass}`}
                disabled={busy}
                onClick={() => void cancel()}
              >
                取消
              </button>
            </>
          ) : null}
        </div>
      ) : null}
      {body}
      {actionError ? (
        <p className="text-xs text-red-600/80">{actionError}</p>
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
  const [stored, setStored] = useState<JobStepRef[]>(() =>
    loadSteps(toolCallId, capability),
  );
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string>();

  const commitSteps = useCallback(
    (next: JobStepRef[]) => {
      setStored(next);
      saveSteps(toolCallId, next);
    },
    [toolCallId],
  );

  // 工具直接提交型（如修复增强）的 jobId 由 execute 返回，本来就随消息历史落库，
  // 不必再存一份，渲染时并进步骤列表即可；localStorage 只负责卡片内自己发起的
  // 那些任务（框选提交、重试、串联）。
  const toolJobId = result?.jobId;
  const steps = useMemo<JobStepRef[]>(
    () =>
      toolJobId && !stored.some((s) => s.jobId === toolJobId)
        ? [{ capability, jobId: toolJobId }, ...stored]
        : stored,
    [toolJobId, stored, capability],
  );

  const submitRegions = async (regions: ToolboxRegion[]) => {
    if (!result?.videoFileId) return;
    setSubmitting(true);
    setSubmitError(undefined);
    try {
      const job = await postJob({
        capability,
        params: { regions },
        inputs: { video: result.videoFileId },
      });
      commitSteps([{ capability, jobId: job.id }]);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "提交失败");
    } finally {
      setSubmitting(false);
    }
  };

  const replaceStep = (index: number, jobId: string) =>
    commitSteps(steps.map((s, i) => (i === index ? { ...s, jobId } : s)));

  const appendStep = (index: number, nextCapability: string, jobId: string) =>
    commitSteps([
      ...steps.slice(0, index + 1),
      { capability: nextCapability, jobId },
    ]);

  let body: ReactNode;
  if (result?.error) {
    body = <p className="text-sm text-red-600/80">{result.error}</p>;
  } else if (steps.length > 0) {
    body = (
      <div className="space-y-3">
        {steps.map((step, i) => (
          <JobStep
            key={step.jobId}
            step={step}
            chained={i > 0}
            onReplace={(jobId) => replaceStep(i, jobId)}
            onChain={(cap, jobId) => appendStep(i, cap, jobId)}
          />
        ))}
      </div>
    );
  } else if (!result) {
    body = <Spinner label="正在准备…" />;
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
  // 卡片本身就是操作界面与交付物，不该收进「N tool calls」折叠区。
  display: "standalone",
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

/** 修复增强的对话卡片：无交互步骤，工具直接提交任务、卡片直接进入轮询。 */
export const VideoEnhanceToolUI = makeAssistantToolUI<
  VideoEnhanceArgs,
  VideoEnhanceResult
>({
  toolName: "video_enhance",
  display: "standalone",
  render: ({ args, result, toolCallId }) => (
    <JobCard
      title={capabilityName("video_enhance")}
      toolCallId={toolCallId}
      capability="video_enhance"
      argsSummary={args?.outscale ? `放大 ${args.outscale} 倍` : undefined}
      result={result ?? undefined}
    />
  ),
});

/** 抠像换背景的对话卡片：无交互步骤，工具直接提交任务、卡片直接进入轮询。 */
export const VideoMattingToolUI = makeAssistantToolUI<
  VideoMattingArgs,
  VideoMattingResult
>({
  toolName: "video_matting",
  display: "standalone",
  render: ({ args, result, toolCallId }) => (
    <JobCard
      title={capabilityName("matting")}
      toolCallId={toolCallId}
      capability="matting"
      argsSummary={args?.background ? `背景：${args.background}` : undefined}
      result={result ?? undefined}
    />
  ),
});
