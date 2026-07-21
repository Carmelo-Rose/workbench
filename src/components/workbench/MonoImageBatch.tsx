"use client";

import {
  ChevronLeftIcon,
  ChevronRightIcon,
  DownloadIcon,
  ImageIcon,
  LoaderCircleIcon,
  MaximizeIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { monoImageGenerationResultSchema, type MonoImageGenerationResult, type MonoJob } from "@/lib/mono/contracts";

const terminalStatuses = new Set<MonoJob["status"]>(["succeeded", "failed", "cancelled"]);

export function useMonoJobPolling(initialJob?: MonoJob) {
  const [polledJob, setPolledJob] = useState(initialJob);
  const [connectionError, setConnectionError] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);

  const job = initialJob && initialJob.id !== polledJob?.id ? initialJob : polledJob ?? initialJob;
  const jobId = job?.id;
  const jobStatus = job?.status;
  useEffect(() => {
    if (!jobId || !jobStatus || terminalStatuses.has(jobStatus)) return;
    let disposed = false;
    const refresh = async () => {
      try {
        const response = await fetch(`/api/workbench/mono/jobs/${encodeURIComponent(jobId)}`, { cache: "no-store" });
        const payload = await response.json() as { job?: MonoJob };
        if (!response.ok || !payload.job) throw new Error("任务状态暂不可用");
        if (!disposed) {
          setConnectionError(false);
          setPolledJob(payload.job);
        }
      } catch {
        if (!disposed) setConnectionError(true);
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
      const response = await fetch(`/api/workbench/mono/jobs/${encodeURIComponent(job.id)}`, { method: "DELETE" });
      const payload = await response.json() as { job?: MonoJob };
      if (!response.ok || !payload.job) throw new Error("取消失败");
      setPolledJob(payload.job);
    } catch {
      setConnectionError(true);
    } finally {
      setIsCancelling(false);
    }
  };

  return { job, setJob: setPolledJob, connectionError, isCancelling, cancel };
}

export function imageBatchResult(job?: MonoJob): MonoImageGenerationResult | null {
  const parsed = monoImageGenerationResultSchema.safeParse(job?.result);
  return parsed.success ? parsed.data : null;
}

/** 缩略图按出图比例排版，最高不超过这个值，竖版详情页才不会挤占整屏。 */
const MAX_TILE_HEIGHT = 380;
const MAX_TILE_WIDTH = 340;

function tileRatio(job: MonoJob): { ratio: number; css: string } {
  const raw = typeof job.input.aspectRatio === "string" ? job.input.aspectRatio : "1:1";
  const [width, height] = raw.split(":").map(Number);
  if (!width || !height) return { ratio: 1, css: "1 / 1" };
  return { ratio: width / height, css: `${width} / ${height}` };
}

/** 结果图存在图片服务的域上，跨域时 <a download> 会被忽略，统一走同源代理下载。 */
function downloadUrl(jobId: string, index: number): string {
  return `/api/workbench/mono/jobs/${encodeURIComponent(jobId)}/image/${index}`;
}

export type MonoGalleryImage = {
  /** 图片服务上的原始地址，用于展示。 */
  displayUrl: string;
  /** 同源代理地址，可直接 fetch 成 Blob（原始地址通常没有 CORS 头）。 */
  fetchUrl: string;
  index: number;
};

export function MonoImageBatchGallery({
  job,
  onUseAsReference,
}: {
  job: MonoJob;
  onUseAsReference?: (image: MonoGalleryImage) => void;
}) {
  const result = imageBatchResult(job);
  const slots = useMemo(() => result?.slots ?? [], [result]);
  const successful = useMemo(
    () => slots.filter((slot) => slot.status === "succeeded" && slot.imageUrl),
    [slots],
  );
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);

  const { ratio, css } = tileRatio(job);
  const columns = slots.length === 1 ? 1 : 2;
  const tileWidth = Math.min(Math.round(MAX_TILE_HEIGHT * ratio), MAX_TILE_WIDTH);
  const galleryWidth = columns * tileWidth + (columns - 1) * 12;

  if (!slots.length) {
    return <p className="text-muted-foreground text-sm">正在建立生成批次…</p>;
  }

  const downloadAll = () => {
    successful.forEach((slot, index) => {
      window.setTimeout(() => triggerDownload(downloadUrl(job.id, slot.index)), index * 300);
    });
  };

  return (
    <div className="space-y-3">
      <div
        className={`grid gap-3 ${columns === 1 ? "grid-cols-1" : "grid-cols-2"}`}
        style={{ maxWidth: galleryWidth }}
      >
        {slots.map((slot) => (
          <article key={slot.index} className="bg-muted/50 overflow-hidden rounded-xl">
            {slot.status === "succeeded" && slot.imageUrl ? (
              <>
                <button
                  type="button"
                  title="查看大图"
                  onClick={() => setViewerIndex(successful.findIndex((item) => item.index === slot.index))}
                  className="group relative block w-full cursor-zoom-in"
                  style={{ aspectRatio: css }}
                >
                  {/* Provider URLs are dynamic and cannot use Next Image's static allowlist. */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={slot.imageUrl} alt={`Mono 生成结果 ${slot.index + 1}`} className="size-full object-contain" />
                  <span className="absolute inset-0 flex items-center justify-center bg-black/35 text-white opacity-0 transition-opacity group-hover:opacity-100">
                    <MaximizeIcon className="size-5" />
                  </span>
                </button>
                <div className="flex flex-wrap gap-1.5 p-2">
                  <Button variant="outline" size="xs" onClick={() => triggerDownload(downloadUrl(job.id, slot.index))}>
                    <DownloadIcon />下载
                  </Button>
                  {onUseAsReference ? (
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={() => onUseAsReference({
                        displayUrl: slot.imageUrl!,
                        fetchUrl: downloadUrl(job.id, slot.index),
                        index: slot.index,
                      })}
                    >
                      <ImageIcon />作为参考图
                    </Button>
                  ) : null}
                </div>
              </>
            ) : (
              <div
                className="text-muted-foreground flex flex-col items-center justify-center gap-2 p-4 text-center text-sm"
                style={{ aspectRatio: css }}
              >
                {slot.status === "failed" ? (
                  <span>{slot.error || `生成失败（已尝试 ${slot.attempt} 次）`}</span>
                ) : (
                  <>
                    <LoaderCircleIcon className="size-5 animate-spin" />
                    <span>{slot.status === "retrying" ? `正在重试 · 第 ${slot.attempt} 次` : "正在生成"}</span>
                  </>
                )}
              </div>
            )}
          </article>
        ))}
      </div>
      <div className="text-muted-foreground flex flex-wrap items-center gap-3 text-xs" style={{ maxWidth: galleryWidth }}>
        <span>已完成 {result ? result.succeeded + result.failed : 0} / {slots.length}</span>
        {successful.length > 1 ? (
          <Button variant="outline" size="xs" className="ml-auto" onClick={downloadAll}>
            <DownloadIcon />下载全部
          </Button>
        ) : null}
      </div>
      <ImageLightbox
        images={successful.map((slot) => ({
          displayUrl: slot.imageUrl!,
          fetchUrl: downloadUrl(job.id, slot.index),
          index: slot.index,
        }))}
        openIndex={viewerIndex}
        onOpenChange={(index) => setViewerIndex(index)}
        onDownload={(image) => triggerDownload(image.fetchUrl)}
        onUseAsReference={onUseAsReference}
      />
    </div>
  );
}

function ImageLightbox({
  images,
  openIndex,
  onOpenChange,
  onDownload,
  onUseAsReference,
}: {
  images: MonoGalleryImage[];
  openIndex: number | null;
  onOpenChange: (index: number | null) => void;
  onDownload: (image: MonoGalleryImage) => void;
  onUseAsReference?: (image: MonoGalleryImage) => void;
}) {
  const current = openIndex !== null ? images[openIndex] : undefined;
  const step = useCallback(
    (delta: number) => {
      if (openIndex === null || images.length < 2) return;
      onOpenChange((openIndex + delta + images.length) % images.length);
    },
    [openIndex, images.length, onOpenChange],
  );

  // 左右方向键翻页；Esc 与点击遮罩关闭由 Radix Dialog 处理。
  useEffect(() => {
    if (openIndex === null) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "ArrowLeft") step(-1);
      if (event.key === "ArrowRight") step(1);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [openIndex, step]);

  if (!current) return null;

  return (
    <Dialog open onOpenChange={(open) => (open ? null : onOpenChange(null))}>
      <DialogContent
        showCloseButton={false}
        className="flex max-h-[92vh] w-auto max-w-[min(96vw,1400px)] flex-col gap-3 border-none bg-transparent p-0 shadow-none sm:max-w-[min(96vw,1400px)]"
      >
        <DialogTitle className="sr-only">生成结果大图</DialogTitle>
        <div className="relative flex min-h-0 items-center justify-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={current.displayUrl}
            alt={`Mono 生成结果 ${current.index + 1}`}
            className="max-h-[80vh] w-auto max-w-full rounded-xl object-contain shadow-2xl"
          />
          {images.length > 1 ? (
            <>
              <Button
                variant="secondary"
                size="icon"
                aria-label="上一张"
                className="absolute start-2 rounded-full opacity-90"
                onClick={() => step(-1)}
              >
                <ChevronLeftIcon />
              </Button>
              <Button
                variant="secondary"
                size="icon"
                aria-label="下一张"
                className="absolute end-2 rounded-full opacity-90"
                onClick={() => step(1)}
              >
                <ChevronRightIcon />
              </Button>
            </>
          ) : null}
        </div>
        <div className="bg-background/95 mx-auto flex items-center gap-2 rounded-full border px-2 py-1.5 shadow-lg backdrop-blur">
          {images.length > 1 ? (
            <span className="text-muted-foreground px-2 text-xs tabular-nums">
              {(openIndex ?? 0) + 1} / {images.length}
            </span>
          ) : null}
          <Button variant="ghost" size="sm" onClick={() => onDownload(current)}>
            <DownloadIcon />下载
          </Button>
          {onUseAsReference ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                onUseAsReference(current);
                onOpenChange(null);
              }}
            >
              <ImageIcon />作为参考图
            </Button>
          ) : null}
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(null)}>
            关闭
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function triggerDownload(url: string) {
  const link = document.createElement("a");
  link.href = url;
  // 同源代理已带 Content-Disposition: attachment，这里只是让点击行为保持一致。
  link.download = "";
  document.body.appendChild(link);
  link.click();
  link.remove();
}
