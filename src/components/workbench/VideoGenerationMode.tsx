"use client";

import { useAui, useAuiState } from "@assistant-ui/react";
import {
  CheckIcon,
  DownloadIcon,
  FilmIcon,
  HeartIcon,
  HistoryIcon,
  ImageUpIcon,
  LoaderCircleIcon,
  PlayIcon,
  RefreshCwIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button";
import { JobCard } from "@/components/workbench/JobCard";
import { emitSendBurst } from "@/components/workbench/send-burst";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { monoVideoGenerationResultSchema, type MonoJob } from "@/lib/mono/contracts";
import { cn } from "@/lib/utils";
import {
  useVideoGenerationMode,
  validateVideoGenerationDraft,
  videoAspectRatios,
  videoDurations,
  videoResolutions,
  type VideoAspectRatio,
  type VideoGenerationDraft,
  type VideoGenerationKind,
} from "@/lib/video-generation-mode";

type VideoCapabilities = {
  configured: boolean;
  provider: string | null;
  message?: string;
  modes: VideoGenerationKind[];
  models: Array<{ id: string; label: string; modes: VideoGenerationKind[] }>;
  durations: number[];
  resolutions: string[];
  variants: number[];
  aspectRatios: string[];
  supportsLastFrame: boolean;
};

type CapabilityResponse = { workspaceId: string; capabilities: VideoCapabilities };
type Aui = ReturnType<typeof useAui>;

const kindLabels: Record<VideoGenerationKind, string> = {
  "text-to-video": "文生视频",
  "image-to-video": "图生视频",
};

function useObjectUrl(file?: File) {
  const url = useMemo(() => file ? URL.createObjectURL(file) : undefined, [file]);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  return url;
}

function useVideoCapabilities(enabled: boolean) {
  const [value, setValue] = useState<CapabilityResponse>();
  const [error, setError] = useState<string>();
  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/workbench/mono/video-generation/capabilities", { cache: "no-store" });
      const payload = await response.json() as CapabilityResponse & { error?: string };
      if (!response.ok || !payload.capabilities) throw new Error(payload.error ?? "无法读取视频生成能力");
      setValue(payload);
      setError(undefined);
      return payload;
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "无法读取视频生成能力";
      setError(message);
      return undefined;
    }
  }, []);
  useEffect(() => {
    if (!enabled) return undefined;
    const timer = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(timer);
  }, [enabled, refresh]);
  return { value, error, refresh };
}

/** Exiting only changes the composer route; the durable current-job pointer stays in browser storage. */
export function useExitVideoGenerationMode() {
  const router = useRouter();
  const aui = useAui();
  const deactivate = useVideoGenerationMode((state) => state.deactivate);
  return () => {
    deactivate();
    aui.composer().setText("");
    router.replace("/");
  };
}

function VideoQuickOption<T extends string | number>({
  label, value, options, display, onChange,
}: { label: string; value: T; options: readonly T[]; display?: string; onChange: (value: T) => void }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" aria-label={label} className="hover:bg-muted-foreground/10 h-7 rounded-full px-2 text-xs transition-colors">
          {display ?? String(value)}
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-36 p-1.5">
        <p className="text-muted-foreground px-2 py-1 text-xs">{label}</p>
        <div className="space-y-0.5">
          {options.map((option) => (
            <button key={String(option)} type="button" onClick={() => onChange(option)} className="hover:bg-muted flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm">
              <span>{String(option)}</span>{option === value ? <CheckIcon className="size-3.5" /> : null}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function VideoHistory({ onReuse }: { onReuse: (job: MonoJob) => void }) {
  const [open, setOpen] = useState(false);
  const [jobs, setJobs] = useState<MonoJob[]>([]);
  useEffect(() => {
    if (!open) return;
    void fetch("/api/workbench/mono/jobs?kind=video_generation&limit=12", { cache: "no-store" })
      .then(async (response) => response.ok ? response.json() as Promise<{ jobs: MonoJob[] }> : { jobs: [] })
      .then((payload) => setJobs(payload.jobs))
      .catch(() => setJobs([]));
  }, [open]);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild><Button type="button" variant="ghost" size="xs" className="w-full justify-start"><HistoryIcon />视频历史</Button></PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-80 p-2">
        <p className="px-1 py-1 text-sm font-medium">视频历史</p>
        <div className="max-h-64 space-y-1 overflow-y-auto">
          {jobs.length ? jobs.map((job) => (
            <button key={job.id} type="button" onClick={() => { onReuse(job); setOpen(false); }} className="hover:bg-muted w-full rounded-md px-2 py-2 text-left text-xs">
              <span className="block truncate">{typeof job.input.prompt === "string" ? job.input.prompt || "首帧图生视频" : "视频任务"}</span>
              <span className="text-muted-foreground">{job.status} · {typeof job.input.durationSeconds === "number" ? `${job.input.durationSeconds} 秒` : ""}</span>
            </button>
          )) : <p className="text-muted-foreground px-2 py-4 text-xs">暂无视频历史</p>}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** Compact capability-driven composer control. No provider model capability is hard-coded in the UI. */
export function VideoGenerationModeControl() {
  const active = useVideoGenerationMode((state) => state.active);
  const draft = useVideoGenerationMode((state) => state.draft);
  const setKind = useVideoGenerationMode((state) => state.setKind);
  const setAspectRatio = useVideoGenerationMode((state) => state.setAspectRatio);
  const setDurationSeconds = useVideoGenerationMode((state) => state.setDurationSeconds);
  const setResolution = useVideoGenerationMode((state) => state.setResolution);
  const setVariants = useVideoGenerationMode((state) => state.setVariants);
  const setModel = useVideoGenerationMode((state) => state.setModel);
  const restoreCurrentJob = useVideoGenerationMode((state) => state.restoreCurrentJob);
  const restoreFromInput = useVideoGenerationMode((state) => state.restoreFromInput);
  const { value, error } = useVideoCapabilities(active);
  const aui = useAui();
  const exit = useExitVideoGenerationMode();
  const capabilities = value?.capabilities;

  useEffect(() => {
    if (value) restoreCurrentJob(value.workspaceId);
  }, [restoreCurrentJob, value]);
  useEffect(() => {
    if (!capabilities?.configured) return;
    if (!capabilities.modes.includes(draft.kind)) setKind(capabilities.modes[0] ?? "text-to-video");
    if (!capabilities.durations.includes(draft.durationSeconds)) setDurationSeconds(capabilities.durations[0] ?? 5);
    if (!capabilities.resolutions.includes(draft.resolution)) setResolution(capabilities.resolutions[0] ?? "480p");
    if (!capabilities.variants.includes(draft.variants)) setVariants(capabilities.variants[0] ?? 1);
  }, [capabilities, draft.durationSeconds, draft.kind, draft.resolution, draft.variants, setDurationSeconds, setKind, setResolution, setVariants]);

  if (!active) return null;
  const modes = capabilities?.modes ?? [];
  const models = capabilities?.models.filter((model) => model.modes.includes(draft.kind)) ?? [];
  const reuse = (job: MonoJob) => {
    const prompt = restoreFromInput(job.input);
    if (prompt !== undefined) aui.composer().setText(prompt);
  };

  return (
    <span className="bg-muted flex h-7 max-w-full items-center overflow-x-auto rounded-full text-xs font-medium scrollbar-none">
      <Popover>
        <PopoverTrigger asChild><button type="button" className="hover:bg-muted-foreground/10 flex h-7 shrink-0 items-center gap-1.5 rounded-l-full pl-2.5 pr-2 transition-colors"><FilmIcon className="size-3.5" /><span>创建视频</span></button></PopoverTrigger>
        <PopoverContent side="top" align="start" className="w-72 p-2">
          <div className="mb-2 px-1"><strong className="block text-sm">创建视频</strong><p className="text-muted-foreground mt-0.5 text-xs">{capabilities?.configured ? `当前 provider：${capabilities.provider}` : capabilities?.message ?? error ?? "正在读取能力…"}</p></div>
          {capabilities?.configured ? <>
            <div className="mb-2 grid grid-cols-2 gap-1 rounded-lg bg-muted/70 p-1">
              {modes.map((kind) => <button key={kind} type="button" onClick={() => setKind(kind)} className={cn("rounded-md px-2 py-1.5 text-xs", draft.kind === kind ? "bg-background shadow-sm" : "text-muted-foreground hover:text-foreground")}>{kindLabels[kind]}</button>)}
            </div>
            <p className="text-muted-foreground px-1 py-1 text-xs">模型</p>
            <div className="space-y-0.5">
              <button type="button" onClick={() => setModel("auto")} className="hover:bg-muted flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm"><span>自动（管理员指定 provider）</span>{draft.model === "auto" ? <CheckIcon className="size-3.5" /> : null}</button>
              {models.map((model) => <button key={model.id} type="button" onClick={() => setModel(model.id)} className="hover:bg-muted flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm"><span>{model.label}</span>{draft.model === model.id ? <CheckIcon className="size-3.5" /> : null}</button>)}
            </div>
            <div className="mt-2 border-t pt-2"><VideoHistory onReuse={reuse} /></div>
          </> : null}
        </PopoverContent>
      </Popover>
      {draft.kind === "text-to-video" ? <><span className="bg-muted-foreground/20 h-3.5 w-px shrink-0" /><VideoQuickOption label="画面比例" value={draft.aspectRatio} options={(capabilities?.aspectRatios.filter((value): value is VideoAspectRatio => videoAspectRatios.includes(value as VideoAspectRatio)) ?? videoAspectRatios)} onChange={setAspectRatio} /></> : null}
      <span className="bg-muted-foreground/20 h-3.5 w-px shrink-0" />
      <VideoQuickOption label="时长" value={draft.durationSeconds} options={capabilities?.durations ?? videoDurations} display={`${draft.durationSeconds} 秒`} onChange={setDurationSeconds} />
      <span className="bg-muted-foreground/20 h-3.5 w-px shrink-0" />
      <VideoQuickOption label="清晰度" value={draft.resolution} options={capabilities?.resolutions ?? videoResolutions} onChange={setResolution} />
      <span className="bg-muted-foreground/20 h-3.5 w-px shrink-0" />
      <VideoQuickOption label="生成数量" value={draft.variants} options={capabilities?.variants ?? [1]} display={`${draft.variants} 条`} onChange={setVariants} />
      <button type="button" onClick={exit} aria-label="退出创建视频模式" title="退出创建视频模式" className="text-muted-foreground hover:bg-muted-foreground/10 hover:text-foreground mx-1 flex size-5 shrink-0 items-center justify-center rounded-full"><XIcon className="size-3" /></button>
    </span>
  );
}

function FrameSlot({ label, optional, file, assetId, onChoose, onRemove }: { label: string; optional?: boolean; file?: File; assetId?: string; onChoose: (event: ChangeEvent<HTMLInputElement>) => void; onRemove: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const previewUrl = useObjectUrl(file);
  return <div className="relative h-16 w-24 shrink-0">
    <button type="button" onClick={() => inputRef.current?.click()} className={cn("border-border/70 hover:border-foreground/35 hover:bg-muted/70 flex size-full flex-col items-center justify-center overflow-hidden rounded-xl border text-center transition-colors", !file && !assetId && "border-dashed")}>
      {/* User-selected object URLs cannot be optimized by next/image. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {previewUrl ? <img src={previewUrl} alt={`${label}预览`} className="size-full object-cover" /> : assetId ? <><CheckIcon className="mb-1 size-3.5" /><span className="text-[10px]">已复用{label}</span></> : <><ImageUpIcon className="text-muted-foreground mb-1 size-3.5" /><span className="text-[10px]">{label}</span>{optional ? <span className="text-muted-foreground text-[9px]">可选</span> : null}</>}
    </button>
    {(file || assetId) ? <button type="button" aria-label={`移除${label}`} onClick={onRemove} className="bg-background/90 hover:bg-background absolute -right-1 -top-1 flex size-4 items-center justify-center rounded-full border shadow-sm"><XIcon className="size-2.5" /></button> : null}
    <input ref={inputRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={onChoose} />
  </div>;
}

export function VideoGenerationSlots() {
  const active = useVideoGenerationMode((state) => state.active);
  const draft = useVideoGenerationMode((state) => state.draft);
  const setFrame = useVideoGenerationMode((state) => state.setFrame);
  const { value } = useVideoCapabilities(active && draft.kind === "image-to-video");
  if (!active || draft.kind !== "image-to-video") return null;
  const chooseFrame = (slot: "firstFrame" | "lastFrame", event: ChangeEvent<HTMLInputElement>) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) setFrame(slot, file); };
  const canUseLastFrame = Boolean(value?.capabilities.supportsLastFrame);
  return <div className="flex items-center gap-2 px-2 pt-1" aria-label="图生视频素材">
    <FrameSlot label="首帧" file={draft.firstFrame} assetId={draft.firstFrameAssetId} onChoose={(event) => chooseFrame("firstFrame", event)} onRemove={() => setFrame("firstFrame")} />
    {canUseLastFrame ? <FrameSlot label="尾帧" optional file={draft.lastFrame} assetId={draft.lastFrameAssetId} onChoose={(event) => chooseFrame("lastFrame", event)} onRemove={() => setFrame("lastFrame")} /> : null}
    <p className="text-muted-foreground min-w-0 text-xs leading-5">首帧必填，比例跟随首帧。{canUseLastFrame ? "尾帧可选，用于约束收镜。" : "尾帧将在云模型支持后开放。"}</p>
  </div>;
}

export function VideoGenerationNotice() {
  const notice = useVideoGenerationMode((state) => state.notice);
  const clearNotice = useVideoGenerationMode((state) => state.clearNotice);
  useEffect(() => { if (!notice) return; const timer = window.setTimeout(clearNotice, 4_500); return () => window.clearTimeout(timer); }, [clearNotice, notice]);
  return notice ? <p role="status" className="text-destructive px-2 pt-1 text-xs">{notice}</p> : null;
}

function idempotencyKey(): string { return `video:${typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`}`; }

/**
 * Video mode owns its input frames. Move a visible composer image into the
 * first-frame slot and remove every chat attachment so a hidden stale image
 * can never be submitted to the normal image-generation path.
 */
export async function adoptComposerImageAsVideoFrame(aui: Aui): Promise<boolean> {
  const attachments = aui.composer().getState().attachments;
  const firstFrame = attachments.find((attachment) =>
    attachment.type === "image" &&
    attachment.file instanceof File &&
    !attachment.name.startsWith("模板参考图"),
  )?.file;
  await aui.composer().clearAttachments();
  if (!firstFrame) return false;
  useVideoGenerationMode.getState().setFrame("firstFrame", firstFrame);
  return true;
}

async function uploadFrame(file: File): Promise<string> {
  const response = await fetch("/api/workbench/mono/uploads", { method: "POST", headers: { "Content-Type": file.type || "image/png", "x-workbench-filename": encodeURIComponent(file.name) }, body: file });
  const payload = await response.json().catch(() => ({})) as { asset?: { id?: string }; error?: string };
  if (!response.ok || !payload.asset?.id) throw new Error(payload.error ?? "上传输入帧失败");
  return payload.asset.id;
}

async function cleanupUploadedAssets(assetIds: string[]): Promise<void> {
  await Promise.all(assetIds.map((assetId) => fetch(`/api/workbench/mono/assets/${encodeURIComponent(assetId)}`, { method: "DELETE" }).catch(() => undefined)));
}

async function createVideoJob(draft: VideoGenerationDraft, prompt: string): Promise<MonoJob> {
  const uploaded: string[] = [];
  try {
    const firstFrameAssetId = draft.kind === "image-to-video" ? draft.firstFrameAssetId ?? (draft.firstFrame ? await uploadFrame(draft.firstFrame) : undefined) : undefined;
    if (draft.kind === "image-to-video" && draft.firstFrame && firstFrameAssetId) uploaded.push(firstFrameAssetId);
    const lastFrameAssetId = draft.kind === "image-to-video" ? draft.lastFrameAssetId ?? (draft.lastFrame ? await uploadFrame(draft.lastFrame) : undefined) : undefined;
    if (draft.kind === "image-to-video" && draft.lastFrame && lastFrameAssetId) uploaded.push(lastFrameAssetId);
    const input = {
      mode: draft.kind, prompt: prompt.trim(), firstFrameAssetId, lastFrameAssetId,
      ...(draft.kind === "text-to-video" ? { aspectRatio: draft.aspectRatio } : {}),
      durationSeconds: draft.durationSeconds, resolution: draft.resolution, variants: draft.variants,
      model: draft.model, idempotencyKey: idempotencyKey(),
    };
    const response = await fetch("/api/workbench/mono/generate/video", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
    const payload = await response.json().catch(() => ({})) as { job?: MonoJob; error?: string };
    if (!response.ok || !payload.job) throw new Error(payload.error ?? "创建视频任务失败");
    return payload.job;
  } catch (error) {
    await cleanupUploadedAssets(uploaded);
    throw error;
  }
}

/** The only video submit path, shared by the button and the Enter key. */
export async function submitVideoGeneration(aui: Aui, burstTarget?: HTMLElement): Promise<void> {
  const mode = useVideoGenerationMode.getState();
  if (mode.submitting) return;
  const prompt = aui.composer().getState().text;
  const draft = mode.draft;
  const notice = validateVideoGenerationDraft(draft, prompt);
  if (notice) {
    mode.showNotice(notice);
    return;
  }

  mode.clearNotice();
  mode.setSubmitting(true);
  try {
    const capabilityResponse = await fetch("/api/workbench/mono/video-generation/capabilities", { cache: "no-store" });
    const capability = await capabilityResponse.json() as CapabilityResponse;
    if (!capabilityResponse.ok || !capability.capabilities?.configured) {
      throw new Error(capability.capabilities?.message ?? "视频生成未配置");
    }
    const job = await createVideoJob(draft, prompt);
    useVideoGenerationMode.getState().setCurrentJob(capability.workspaceId, job.id);
    aui.composer().setText("");
    if (burstTarget) emitSendBurst(burstTarget);
  } catch (error) {
    useVideoGenerationMode.getState().showNotice(error instanceof Error ? error.message : "创建视频任务失败");
  } finally {
    useVideoGenerationMode.getState().setSubmitting(false);
  }
}

export function VideoGenerationSendButton() {
  const aui = useAui();
  const threadRunning = useAuiState((state) => state.thread.isRunning);
  const submitting = useVideoGenerationMode((state) => state.submitting);
  return <TooltipIconButton tooltip={submitting ? "正在提交视频任务" : "生成视频"} side="bottom" type="button" variant="default" size="icon" className="aui-composer-send size-7 rounded-full" aria-label={submitting ? "正在提交视频任务" : "生成视频"} disabled={submitting || threadRunning} onClick={(event) => void submitVideoGeneration(aui, event.currentTarget)}>{submitting ? <LoaderCircleIcon className="size-3.5 animate-spin" /> : <FilmIcon className="size-3.5" />}</TooltipIconButton>;
}

function VideoJobContent({ job }: { job: MonoJob }) {
  const aui = useAui();
  const restoreFromInput = useVideoGenerationMode((state) => state.restoreFromInput);
  const setCurrentJob = useVideoGenerationMode((state) => state.setCurrentJob);
  const showNotice = useVideoGenerationMode((state) => state.showNotice);
  const [mutating, setMutating] = useState(false);
  const result = monoVideoGenerationResultSchema.safeParse(job.result).success ? monoVideoGenerationResultSchema.parse(job.result) : undefined;
  const slot = result?.slots[0];
  const assetUrl = slot?.assetId ? `/api/workbench/mono/assets/${encodeURIComponent(slot.assetId)}/content` : undefined;
  const active = job.status === "queued" || job.status === "running";
  const reuse = () => { const prompt = restoreFromInput(job.input); if (prompt !== undefined) aui.composer().setText(prompt); };
  const regenerate = async () => {
    setMutating(true);
    try { const generated = await createVideoJob({ ...useVideoGenerationMode.getState().draft, firstFrame: undefined, lastFrame: undefined, firstFrameAssetId: typeof job.input.firstFrameAssetId === "string" ? job.input.firstFrameAssetId : undefined, lastFrameAssetId: typeof job.input.lastFrameAssetId === "string" ? job.input.lastFrameAssetId : undefined }, typeof job.input.prompt === "string" ? job.input.prompt : ""); setCurrentJob(job.workspaceId, generated.id); }
    catch (error) { showNotice(error instanceof Error ? error.message : "重新生成失败"); }
    finally { setMutating(false); }
  };
  const favorite = async () => { setMutating(true); try { await fetch(`/api/workbench/mono/jobs/${encodeURIComponent(job.id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ favorite: !job.favorite }) }); } finally { setMutating(false); } };
  const purge = async () => { setMutating(true); try { const response = await fetch(`/api/workbench/mono/jobs/${encodeURIComponent(job.id)}?purge=true`, { method: "DELETE" }); if (!response.ok) throw new Error("删除失败"); setCurrentJob(job.workspaceId); } catch (error) { showNotice(error instanceof Error ? error.message : "删除失败"); } finally { setMutating(false); } };
  if (active) return <div className="space-y-2"><div className="flex items-center gap-2 text-sm"><LoaderCircleIcon className="size-4 animate-spin" /><span>{job.status === "queued" ? "正在排队" : result?.stage === "downloading" ? "正在归档视频" : "正在生成视频"}</span></div><div className="bg-muted h-1.5 overflow-hidden rounded-full"><div className="bg-foreground h-full w-1/3 animate-pulse rounded-full" /></div><p className="text-muted-foreground text-xs">仅展示 provider 的真实阶段；当前没有可用百分比。</p></div>;
  if (job.status === "succeeded" && assetUrl) return <div className="space-y-3"><div className="bg-muted/50 overflow-hidden rounded-xl border"><video controls preload="metadata" className="mx-auto max-h-80 w-full bg-black object-contain" src={assetUrl}>当前浏览器不支持视频预览。</video></div><div className="text-muted-foreground flex flex-wrap gap-x-2 gap-y-1 text-xs"><span>{result?.provider}</span><span>·</span><span>{result?.model}</span><span>·</span><span>{typeof job.input.durationSeconds === "number" ? `${job.input.durationSeconds} 秒` : ""}</span><span>·</span><span>{job.completedAt ? `耗时 ${Math.max(1, Math.round((job.completedAt - job.createdAt) / 1000))} 秒` : ""}</span></div><div className="flex flex-wrap gap-2"><Button type="button" variant="outline" size="xs" onClick={() => void document.querySelector<HTMLVideoElement>(`video[src='${assetUrl}']`)?.play()}><PlayIcon />播放</Button><Button asChild variant="outline" size="xs"><a href={assetUrl} download="generated-video.mp4"><DownloadIcon />下载</a></Button><Button type="button" variant="outline" size="xs" onClick={reuse}><RefreshCwIcon />复用参数</Button><Button type="button" variant="outline" size="xs" disabled={mutating} onClick={() => void regenerate()}><FilmIcon />重新生成</Button><Button type="button" variant="ghost" size="xs" disabled={mutating} onClick={() => void favorite()}><HeartIcon className={job.favorite ? "fill-current" : undefined} />收藏</Button><Button type="button" variant="ghost" size="xs" className="text-muted-foreground" disabled={mutating} onClick={() => void purge()}><Trash2Icon />删除</Button></div></div>;
  return <div className="space-y-3"><p className="text-sm">{job.error ?? slot?.error ?? (job.status === "cancelled" ? "任务已取消。" : "视频任务未能完成。")}</p><div className="flex flex-wrap gap-2"><Button type="button" variant="outline" size="xs" onClick={reuse}><RefreshCwIcon />复用参数</Button><Button type="button" variant="outline" size="xs" disabled={mutating} onClick={() => void regenerate()}><FilmIcon />重新生成</Button>{job.status !== "queued" && job.status !== "running" ? <Button type="button" variant="ghost" size="xs" disabled={mutating} onClick={() => void purge()}><Trash2Icon />删除</Button> : null}</div></div>;
}

/** Rendered below the conversation, but backed exclusively by a real Mono job. */
export function VideoGenerationJobTurn() {
  const jobId = useVideoGenerationMode((state) => state.currentJobId);
  const [job, setJob] = useState<MonoJob>();
  useEffect(() => {
    if (!jobId) return undefined;
    let cancelled = false;
    void fetch(`/api/workbench/mono/jobs/${encodeURIComponent(jobId)}`, { cache: "no-store" }).then(async (response) => response.ok ? response.json() as Promise<{ job: MonoJob }> : undefined).then((payload) => { if (!cancelled && payload?.job) setJob(payload.job); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [jobId]);
  if (!jobId) return null;
  const currentJob = job?.id === jobId ? job : undefined;
  return <div className="mx-auto w-full max-w-(--thread-max-width)"><JobCard initialJob={currentJob} kind="video_generation">{(current) => <VideoJobContent job={current} />}</JobCard></div>;
}
