"use client";

import { DownloadIcon, ImageIcon, LoaderCircleIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
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

export function MonoImageBatchGallery({
  job,
  onUseAsReference,
}: {
  job: MonoJob;
  onUseAsReference?: (imageUrl: string) => void;
}) {
  const result = imageBatchResult(job);
  const slots = useMemo(() => result?.slots ?? [], [result]);
  const successful = slots.filter((slot) => slot.status === "succeeded" && slot.imageUrl);

  if (!slots.length) {
    return <p className="text-muted-foreground text-sm">正在建立生成批次…</p>;
  }

  const downloadAll = () => {
    successful.forEach((slot, index) => {
      window.setTimeout(() => triggerDownload(slot.imageUrl!, `mono-image2-${job.id}-${slot.index + 1}.png`), index * 120);
    });
  };

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {slots.map((slot) => (
          <article key={slot.index} className="bg-muted/50 overflow-hidden rounded-xl">
            {slot.status === "succeeded" && slot.imageUrl ? (
              <>
                <a href={slot.imageUrl} target="_blank" rel="noreferrer" title="查看大图">
                  {/* Provider URLs are dynamic and cannot use Next Image's static allowlist. */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={slot.imageUrl} alt={`Mono 生成结果 ${slot.index + 1}`} className="aspect-square w-full object-contain" />
                </a>
                <div className="flex flex-wrap gap-1.5 p-2">
                  <Button variant="outline" size="xs" onClick={() => triggerDownload(slot.imageUrl!, `mono-image2-${job.id}-${slot.index + 1}.png`)}>
                    <DownloadIcon />下载
                  </Button>
                  {onUseAsReference ? (
                    <Button variant="ghost" size="xs" onClick={() => onUseAsReference(slot.imageUrl!)}>
                      <ImageIcon />作为参考图
                    </Button>
                  ) : null}
                </div>
              </>
            ) : (
              <div className="text-muted-foreground flex aspect-square flex-col items-center justify-center gap-2 p-4 text-center text-sm">
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
      <div className="text-muted-foreground flex flex-wrap items-center justify-between gap-2 text-xs">
        <span>已完成 {result ? result.succeeded + result.failed : 0} / {slots.length}</span>
        {successful.length > 1 ? (
          <Button variant="outline" size="xs" onClick={downloadAll}>
            <DownloadIcon />下载全部
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function triggerDownload(url: string, fileName: string) {
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.target = "_blank";
  link.rel = "noreferrer";
  document.body.appendChild(link);
  link.click();
  link.remove();
}
