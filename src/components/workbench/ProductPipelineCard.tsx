"use client";

import { useAui } from "@assistant-ui/react";
import {
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CopyIcon,
  DownloadIcon,
  ImageIcon,
  LoaderCircleIcon,
  RefreshCwIcon,
  XIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { JobCard } from "@/components/workbench/JobCard";
import type { MonoJob } from "@/lib/mono/contracts";
import { startProductPipelineRun } from "@/lib/product-pipeline-run";

/**
 * Presentation-only mirror of `DETAIL_SLOTS` in product-pipeline.ts (server-only,
 * can't be imported into a client component). Keep in sync with §0.2 of the plan
 * if the template ever adds/removes slots.
 */
const SLOT_META = [
  { id: "01", kind: "model" },
  { id: "02", kind: "fixed" },
  { id: "03", kind: "model" },
  { id: "04", kind: "model" },
  { id: "05", kind: "model" },
  { id: "06", kind: "model" },
  { id: "07", kind: "model" },
  { id: "08", kind: "model" },
  { id: "09", kind: "fixed" },
  { id: "10", kind: "tiled" },
  { id: "11", kind: "detail" },
] as const;
const MODEL_SLOT_COUNT = SLOT_META.filter((slot) => slot.kind === "model").length;

/**
 * Every cell is the same shape, deliberately.
 *
 * The slots' real heights run from 610 to 1243, and giving each cell its own
 * aspect ratio made a row of them sit at wildly different heights — at 60px
 * wide the true proportions carry no information anyway, they just read as a
 * broken grid. The thumbnails are `object-cover`, so each still shows its own
 * image; only the frame is uniform.
 */
const CELL_ASPECT = "3 / 4";

/** Reuses the exact wording already shown in the (now folder-picker-only) launcher dialog. */
const stageLabel: Record<string, string> = {
  main_published: "主图已完成，正在准备详情套图",
  正在生成白底主图: "正在生成白底主图",
  classifying: "正在识别商品颜色和角度",
  classified: "颜色识别完成",
  generating_main: "正在生成主图背景（调用付费生图服务）",
  publishing_main: "正在原子发布主图",
  rendering_sku: "正在渲染 SKU 图",
  publishing_sku: "正在原子发布 SKU 图",
  generating_models: "正在生成模特图（调用付费生图服务）",
  compositing: "正在制作产品拼图",
  qa: "正在进行视觉与尺寸质检",
  publishing_images: "正在原子发布详情套图",
  branch_published: "已发布",
  branch_failed: "未能完成",
  queued: "排队中",
  completed: "详情套图已完成",
};

/** The three deliverable directories, in the order they appear on the share. */
const BRANCH_ORDER = ["prepare", "main", "sku", "images"] as const;
const branchLabel: Record<string, string> = {
  prepare: "白底图与颜色识别",
  main: "主图",
  sku: "SKU 图",
  images: "详情套图",
};

type SlotRecord = { slot: string; attempts?: number; warning?: string; qa?: string };
type FailedSlot = { slot: string; reason: string };
type MainRecord = { stem: string; name: string; warnings?: string[]; assetId?: string };
type FailedMain = { stem: string; name: string; reason: string };
type BranchState = { stage?: string; progress?: number };
type PipelineResult = {
  stage?: string;
  progress?: number;
  relativePath?: string;
  colors?: { rank: number; shots: number }[];
  detailShots?: number;
  mainRecords?: MainRecord[];
  failedMain?: FailedMain[];
  slots?: SlotRecord[];
  failedSlots?: FailedSlot[];
  /** Per-branch stage and percentage, since three of them now advance at once. */
  branches?: Record<string, BranchState>;
  failedBranches?: { branch: string; reason: string; label?: string }[];
  warnings?: string[];
  resumed?: boolean;
  incomplete?: boolean;
};

function pipelineResult(job: MonoJob): PipelineResult {
  return (job.result ?? {}) as PipelineResult;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function imageUrl(jobId: string, slot: string, width?: number): string {
  return `/api/workbench/mono/product-pipeline/jobs/${encodeURIComponent(jobId)}/images/${slot}${width ? `?w=${width}` : ""}`;
}

function elapsedLabel(job: MonoJob): string {
  const start = job.startedAt ?? job.createdAt;
  const end = job.completedAt ?? Date.now();
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

export function ProductPipelineCard({ initialJob, folderName }: { initialJob?: MonoJob; folderName?: string }) {
  return (
    <JobCard initialJob={initialJob} kind="product_pipeline">
      {(job) => <ProductPipelineCardBody job={job} folderNameHint={folderName} />}
    </JobCard>
  );
}

function ProductPipelineCardBody({ job, folderNameHint }: { job: MonoJob; folderNameHint?: string }) {
  const aui = useAui();
  const result = pipelineResult(job);
  const legacyMainFailed = result.failedBranches?.some((item) => item.branch === "main") ?? false;
  const retryTargetLabel = [
    result.failedMain?.length ? `${result.failedMain.length} 张主图` : legacyMainFailed ? "全部主图" : "",
    result.failedSlots?.length ? `${result.failedSlots.length} 张详情图` : "",
  ].filter(Boolean).join("和");
  const retryActionLabel = legacyMainFailed && !result.failedMain?.length && !result.failedSlots?.length
    ? "重新生成全部主图"
    : `只重跑失败的 ${retryTargetLabel}`;
  // The share-relative path is only present on job records that never left the
  // server; everything the browser sees has it stripped, so the caller's own
  // label is the reliable source and the rest are fallbacks.
  const folderName = folderNameHint
    ?? stringValue(job.input.folderRelativePath)
    ?? result.relativePath;
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string>();
  const retryStarted = useRef(false);
  const [viewerSlot, setViewerSlot] = useState<string | null>(null);

  // folderName is a display label ("1234" or "XM2606011 / 普通版" with " / "
  // standing in for path.sep) — pasted into Explorer it doesn't open anything.
  // The one thing worth copying is the real absolute path, which job records
  // deliberately don't carry (see the /path route), so it's fetched on click.
  const copyFolderPath = async () => {
    const folderId = stringValue(job.input.folderId);
    if (!folderId) return;
    setCopyError(false);
    try {
      const response = await fetch(
        `/api/workbench/mono/product-pipeline/folders/${encodeURIComponent(folderId)}/path`,
        { cache: "no-store" },
      );
      const payload = await response.json();
      if (!response.ok || !payload.absolutePath) throw new Error(payload.error ?? "读取路径失败");
      await navigator.clipboard.writeText(payload.absolutePath);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopyError(true);
      window.setTimeout(() => setCopyError(false), 2000);
    }
  };

  const retryFailedImages = () => {
    const folderId = stringValue(job.input.folderId);
    const failedIds = result.failedSlots?.map((item) => item.slot) ?? [];
    const failedStems = result.failedMain?.map((item) => item.stem) ?? [];
    const shouldRetryMain = failedStems.length > 0 || legacyMainFailed;
    if (!folderId || (!failedIds.length && !shouldRetryMain)) return;
    // Each click spends real money on the image service, and this card stays on
    // screen forever once the job is terminal. A latch — not a `disabled` flag
    // cleared in a `finally` — is what stops a second click from buying a
    // second run of the same slots.
    if (retryStarted.current) return;
    retryStarted.current = true;
    setRetrying(true);
    setRetryError(undefined);
    try {
      startProductPipelineRun(
        aui,
        {
          folderId,
          workflowId: stringValue(job.input.workflowId) ?? "hat-62604171-v1",
          modelPairId: stringValue(job.input.modelPairId),
          folderName,
          ...(failedIds.length ? { onlySlots: failedIds } : {}),
          ...(failedStems.length ? { onlyMain: failedStems } : {}),
          ...(shouldRetryMain ? { retryMain: true } : {}),
        },
        `${retryActionLabel}${folderName ? `：${folderName}` : ""}`,
      );
    } catch (error) {
      retryStarted.current = false;
      setRetrying(false);
      setRetryError(error instanceof Error ? error.message : "重跑失败，请重试");
    }
  };

  const isActive = job.status === "queued" || job.status === "running";
  const isTerminal = !isActive;
  const modelDone = result.slots?.filter((slot) => SLOT_META.find((meta) => meta.id === slot.slot)?.kind === "model").length ?? 0;
  const mainDone = result.mainRecords?.length ?? 0;
  const mainFailed = result.failedMain?.length ?? 0;
  const mainTotal = mainDone + mainFailed;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="text-sm font-medium">{folderName ? `文件夹 ${folderName}` : "正在解析商品文件夹…"}</p>
        <p className="text-muted-foreground text-xs">
          {isActive
            ? `${stageLabel[result.stage ?? ""] ?? "正在处理"}${result.progress !== undefined ? `（${result.progress}%）` : ""}`
            : job.status === "succeeded"
              ? (result.failedBranches?.length
                ? `已完成（${result.failedBranches.map((item) => item.label ?? branchLabel[item.branch] ?? item.branch).join("、")}未发布）`
                : result.incomplete ? "已完成（部分图片失败）" : "已完成")
              : job.status === "cancelled"
                ? "已取消"
                : (job.error ?? "未完成")}
        </p>
      </div>

      <div className="grid grid-cols-4 gap-2 sm:grid-cols-6 lg:grid-cols-11">
        {SLOT_META.map((meta) => {
          const record = result.slots?.find((slot) => slot.slot === meta.id);
          const failure = result.failedSlots?.find((slot) => slot.slot === meta.id);
          // Keying on produced/failed (not just meta.id) remounts the cell —
          // and so resets its own "did the thumbnail fail to load" state —
          // the moment a slot transitions from absent to produced or failed,
          // instead of reaching for a setState-in-effect to do the same thing.
          //
          // `job.status` is in the key for the same reason: a slot is recorded
          // as done the moment it is generated, but its file only reaches the
          // published folder when the whole job finishes. Without a remount on
          // that transition, a thumbnail that 404'd mid-run stayed marked as
          // failed forever — which is exactly what left seven finished model
          // slots showing placeholders on a fully successful run.
          const cellKey = `${meta.id}:${record ? "done" : failure ? "failed" : "pending"}:${job.status}`;
          return (
            <SlotCell
              key={cellKey}
              meta={meta}
              job={job}
              record={record}
              failure={failure}
              onOpen={() => setViewerSlot(meta.id)}
            />
          );
        })}
      </div>

      {/* Three directories publish independently now, so a single stage line
          can only ever name one of them. This says where each one actually is. */}
      {isActive && result.branches ? (
        <ul className="text-muted-foreground grid gap-x-4 gap-y-0.5 text-xs sm:grid-cols-2">
          {BRANCH_ORDER.filter((id) => result.branches?.[id]).map((id) => {
            const branch = result.branches![id];
            return (
              <li key={id} className="flex items-baseline justify-between gap-2">
                <span>{branchLabel[id]}</span>
                <span className="tabular-nums">
                  {stageLabel[branch.stage ?? ""] ?? branch.stage ?? "排队中"}
                  {branch.progress !== undefined ? ` ${branch.progress}%` : ""}
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}

      <div className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
        {result.resumed ? <span className="bg-muted rounded-full px-2.5 py-1">已复用现有主图</span> : null}
        {result.colors?.length ? <span className="bg-muted rounded-full px-2.5 py-1">识别到 {result.colors.length} 个颜色</span> : null}
        {result.detailShots ? <span className="bg-muted rounded-full px-2.5 py-1">{result.detailShots} 张细节图</span> : null}
        {mainTotal ? <span className="bg-muted rounded-full px-2.5 py-1">主图 {mainDone} / {mainTotal}</span> : null}
        <span className="bg-muted rounded-full px-2.5 py-1">付费槽位 {modelDone} / {MODEL_SLOT_COUNT}</span>
        <span className="bg-muted rounded-full px-2.5 py-1">已用时长 {elapsedLabel(job)}</span>
      </div>

      {result.warnings?.length ? (
        <ul className="text-muted-foreground space-y-0.5 text-xs">
          {result.warnings.map((warning, index) => <li key={index}>· {warning}</li>)}
        </ul>
      ) : null}

      {isTerminal && job.status === "succeeded" ? (
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Button variant="outline" size="sm" onClick={() => downloadAllSlots(job)}>
            <DownloadIcon />下载全部（打包 zip）
          </Button>
          {stringValue(job.input.folderId) ? (
            <Button variant="outline" size="sm" onClick={() => void copyFolderPath()}>
              {copied ? <CheckIcon /> : <CopyIcon />}
              {copied ? "已复制" : copyError ? "复制失败，请重试" : "复制文件夹路径"}
            </Button>
          ) : null}
          {result.incomplete && (
            result.failedSlots?.length
            || result.failedMain?.length
            || legacyMainFailed
          ) ? (
            <Button variant="destructive" size="sm" disabled={retrying} onClick={retryFailedImages}>
              {retrying ? <LoaderCircleIcon className="animate-spin" /> : <RefreshCwIcon />}
              {retrying ? "已提交，见下方新任务" : retryActionLabel}
            </Button>
          ) : null}
        </div>
      ) : null}
      {retryError ? <p className="text-destructive text-xs">{retryError}</p> : null}

      <SlotLightbox
        job={job}
        result={result}
        openSlot={viewerSlot}
        onOpenChange={setViewerSlot}
      />
    </div>
  );
}

function SlotCell({
  meta,
  job,
  record,
  failure,
  onOpen,
}: {
  meta: (typeof SLOT_META)[number];
  job: MonoJob;
  record: SlotRecord | undefined;
  failure: FailedSlot | undefined;
  onOpen: () => void;
}) {
  const running = job.status === "queued" || job.status === "running";
  // The parent keys this component on produced/failed/job-status (see the slot
  // grid's `.map()`), so a fresh mount — and a fresh `thumbnailFailed` — is
  // what happens when a slot flips from absent to produced or failed, rather
  // than a setState-in-effect doing the same reset.
  const [thumbnailFailed, setThumbnailFailed] = useState(false);

  const retries = record?.attempts && record.attempts > 1 ? record.attempts - 1 : 0;
  // Older jobs finished before `result.slots` existed, so a succeeded job with
  // no record is still worth a request. A cancelled or failed one is not —
  // that just fires eleven guaranteed 404s.
  const canTryThumbnail = Boolean(record) || (job.status === "succeeded" && !failure);

  return (
    <button
      type="button"
      disabled={!canTryThumbnail || thumbnailFailed}
      onClick={onOpen}
      title={failure ? failure.reason : meta.kind === "fixed" ? "固定页" : undefined}
      className={`group relative overflow-hidden rounded-lg border text-left ${
        failure ? "border-destructive/60 bg-destructive/5" :
        record ? "border-border/70 bg-muted/40" :
        running ? "border-dashed border-border/60" : "border-border/40 bg-muted/20"
      }`}
      style={{ aspectRatio: CELL_ASPECT }}
    >
      {canTryThumbnail && !thumbnailFailed ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={imageUrl(job.id, meta.id, 200)}
          alt={`槽位 ${meta.id}`}
          className="size-full object-cover"
          onError={() => setThumbnailFailed(true)}
        />
      ) : (
        <div className="text-muted-foreground flex size-full flex-col items-center justify-center gap-1 p-1 text-center text-[10px]">
          {failure ? <XIcon className="size-3.5" /> :
            running ? <LoaderCircleIcon className="size-3.5 animate-spin" /> :
            <ImageIcon className="size-3.5 opacity-50" />}
          <span>{meta.kind === "fixed" ? "固定页" : meta.id}</span>
        </div>
      )}
      {record && !thumbnailFailed ? (
        <span className="absolute inset-x-0 bottom-0 flex items-center justify-between bg-black/45 px-1 py-0.5 text-[10px] text-white">
          <span>{meta.id}</span>
          {retries > 0 ? <span>重试 {retries}</span> : null}
        </span>
      ) : null}
      {failure ? (
        <span className="absolute right-0.5 top-0.5 flex size-4 items-center justify-center rounded-full bg-destructive text-white">
          <XIcon className="size-3" />
        </span>
      ) : null}
    </button>
  );
}

// Server bundles every produced slot into one zip — eleven separate <a
// download> clicks used to trigger the browser's multi-download block and
// land with no extension or product name, see the /download route's comment.
function downloadAllSlots(job: MonoJob): void {
  const link = document.createElement("a");
  link.href = `/api/workbench/mono/product-pipeline/jobs/${encodeURIComponent(job.id)}/download`;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function SlotLightbox({
  job,
  result,
  openSlot,
  onOpenChange,
}: {
  job: MonoJob;
  result: PipelineResult;
  openSlot: string | null;
  onOpenChange: (slot: string | null) => void;
}) {
  const available = useMemo(
    () => SLOT_META.filter((meta) => result.slots?.some((slot) => slot.slot === meta.id)).map((meta): string => meta.id),
    [result.slots],
  );
  const currentIndex = openSlot ? available.indexOf(openSlot) : -1;
  const step = useCallback((delta: number) => {
    if (currentIndex < 0 || available.length < 2) return;
    onOpenChange(available[(currentIndex + delta + available.length) % available.length]);
  }, [currentIndex, available, onOpenChange]);

  useEffect(() => {
    if (openSlot === null) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "ArrowLeft") step(-1);
      if (event.key === "ArrowRight") step(1);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [openSlot, step]);

  if (openSlot === null) return null;

  return (
    <Dialog open onOpenChange={(open) => (open ? null : onOpenChange(null))}>
      <DialogContent
        showCloseButton={false}
        className="flex max-h-[92vh] w-auto max-w-[min(96vw,1200px)] flex-col gap-3 border-none bg-transparent p-0 shadow-none sm:max-w-[min(96vw,1200px)]"
      >
        <DialogTitle className="sr-only">商品套图 · 槽位 {openSlot}</DialogTitle>
        <div className="relative flex min-h-0 items-center justify-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={imageUrl(job.id, openSlot)}
            alt={`槽位 ${openSlot}`}
            className="max-h-[80vh] w-auto max-w-full rounded-xl object-contain shadow-2xl"
          />
          {available.length > 1 ? (
            <>
              <Button variant="secondary" size="icon" aria-label="上一张" className="absolute start-2 rounded-full opacity-90" onClick={() => step(-1)}>
                <ChevronLeftIcon />
              </Button>
              <Button variant="secondary" size="icon" aria-label="下一张" className="absolute end-2 rounded-full opacity-90" onClick={() => step(1)}>
                <ChevronRightIcon />
              </Button>
            </>
          ) : null}
        </div>
        <div className="bg-background/95 mx-auto flex items-center gap-2 rounded-full border px-2 py-1.5 shadow-lg backdrop-blur">
          {available.length > 1 ? (
            <span className="text-muted-foreground px-2 text-xs tabular-nums">
              {currentIndex + 1} / {available.length}
            </span>
          ) : null}
          <Button variant="ghost" size="sm" onClick={() => {
            const link = document.createElement("a");
            link.href = imageUrl(job.id, openSlot);
            link.download = "";
            document.body.appendChild(link);
            link.click();
            link.remove();
          }}>
            <DownloadIcon />下载
          </Button>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(null)}>
            关闭
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
