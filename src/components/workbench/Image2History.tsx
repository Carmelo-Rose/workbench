"use client";

import { useEffect, useState } from "react";
import { ImageOffIcon, LoaderCircleIcon, StarIcon, Trash2Icon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useAui } from "@assistant-ui/react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { useImage2Mode } from "@/lib/image2-mode";
import type { MonoImageGenerationSlot, MonoJob } from "@/lib/mono/contracts";
import { getMonoImage2Template, type MonoImage2TemplateId } from "@/lib/mono/image2-templates";
import { SLOT_PREFIXES } from "@/components/workbench/Image2ChatMode";
import { useMonoSubjectCatalog } from "@/lib/mono/subject-client";

/** 列表接口返回的瘦身任务：referenceImageUrls 被替换为 referenceImageCount。 */
type HistoryJobInput = {
  prompt?: string;
  templateId?: MonoImage2TemplateId;
  aspectRatio?: string;
  variants?: number;
  referenceImageCount?: number;
  subjectSnapshots?: { id: string; name: string; assetId?: string; sourceUrl: string }[];
  referenceAssetIds?: string[];
};

function jobInput(job: MonoJob): HistoryJobInput {
  return job.input as HistoryJobInput;
}

function jobSlots(job: MonoJob): MonoImageGenerationSlot[] {
  const slots = (job.result as { slots?: MonoImageGenerationSlot[] } | null)?.slots;
  return Array.isArray(slots) ? slots : [];
}

const statusLabels: Record<MonoJob["status"], string> = {
  queued: "排队中",
  running: "生成中",
  succeeded: "已完成",
  failed: "生成失败",
  cancelled: "已取消",
};

export function Image2HistorySheet({ open, onOpenChange }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [favoriteOnly, setFavoriteOnly] = useState(false);
  const [jobs, setJobs] = useState<MonoJob[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [reusingId, setReusingId] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const router = useRouter();
  const aui = useAui();

  // 打开面板或切换筛选时拉取列表；切换筛选期间短暂展示旧列表，本地接口足够快。
  useEffect(() => {
    if (!open) return;
    let disposed = false;
    const load = async () => {
      try {
        const query = favoriteOnly ? "?favorite=1" : "";
        const response = await fetch(`/api/workbench/mono/jobs${query}`, { cache: "no-store" });
        const payload = (await response.json()) as { jobs?: MonoJob[] };
        if (!response.ok || !payload.jobs) throw new Error("历史加载失败");
        if (!disposed) {
          setJobs(payload.jobs);
          setLoadError(false);
        }
      } catch {
        if (!disposed) {
          setJobs([]);
          setLoadError(true);
        }
      }
    };
    void load();
    return () => {
      disposed = true;
    };
  }, [open, favoriteOnly]);

  const toggleFavorite = async (job: MonoJob) => {
    const next = !job.favorite;
    setJobs((current) =>
      current?.map((item) => (item.id === job.id ? { ...item, favorite: next } : item)) ?? current,
    );
    try {
      const response = await fetch(`/api/workbench/mono/jobs/${encodeURIComponent(job.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ favorite: next }),
      });
      if (!response.ok) throw new Error();
    } catch {
      setJobs((current) =>
        current?.map((item) => (item.id === job.id ? { ...item, favorite: job.favorite } : item)) ?? current,
      );
    }
  };

  /** 复用参数：单条拉全量（含参考图 data URL），回填模式状态、提示词和附件。 */
  const reuse = async (job: MonoJob) => {
    setReusingId(job.id);
    try {
      const response = await fetch(`/api/workbench/mono/jobs/${encodeURIComponent(job.id)}`, {
        cache: "no-store",
      });
      const payload = (await response.json()) as { job?: MonoJob };
      if (!response.ok || !payload.job) throw new Error("任务详情加载失败");
      const input = payload.job.input as HistoryJobInput & { referenceImageUrls?: string[] };
      const template = getMonoImage2Template(input.templateId);

      useImage2Mode.setState({
        active: true,
        selectedTemplateId: template?.id,
        aspectRatio: (input.aspectRatio as never) ?? "9:16",
        variants: (input.variants as never) ?? 1,
        structuredSubjectIds: [undefined, undefined],
      });
      await useMonoSubjectCatalog.getState().load(true);
      const visibleIds = new Set(useMonoSubjectCatalog.getState().subjects.map((subject) => subject.id));
      let restoredPrompt = input.prompt ?? "";
      for (const snapshot of input.subjectSnapshots ?? []) {
        if (!visibleIds.has(snapshot.id)) {
          restoredPrompt = restoredPrompt.replace(
            new RegExp(`:subject\\[[^\\]]+\\]\\{name=${escapeRegExp(snapshot.id)}\\}`, "gu"),
            `@${snapshot.name}`,
          );
        }
      }
      aui.composer().setText(restoredPrompt);
      await aui.composer().clearAttachments();
      const subjectAssetIds = new Set(
        (input.subjectSnapshots ?? []).filter((subject) => visibleIds.has(subject.id)).map((subject) => subject.assetId),
      );
      const durableReferences = (input.referenceAssetIds ?? [])
        .filter((assetId) => !subjectAssetIds.has(assetId))
        .map((assetId) => `/api/workbench/mono/assets/${encodeURIComponent(assetId)}/content`);
      const references = durableReferences.length
        ? durableReferences
        : Array.isArray(input.referenceImageUrls) ? input.referenceImageUrls : [];
      const subjectSources = new Set((input.subjectSnapshots ?? []).filter((subject) => visibleIds.has(subject.id)).map((subject) => subject.sourceUrl));
      await Promise.all(references.filter((url) => !subjectSources.has(url)).slice(0, 6).map(async (url, index) => {
        try {
          const blob = await (await fetch(url)).blob();
          const name = template?.structuredMode
            ? `${SLOT_PREFIXES[index] ?? `参考图${index + 1}-`}历史.png`
            : `历史参考图-${index + 1}.png`;
          await aui.composer().addAttachment(new File([blob], name, { type: blob.type || "image/png" }));
        } catch {
          // 单张参考图恢复失败不阻断复用。
        }
      }));
      onOpenChange(false);
      router.push("/?mode=image2");
    } catch {
      setLoadError(true);
    } finally {
      setReusingId(null);
    }
  };

  const deleteJob = async (jobId: string) => {
    const response = await fetch(`/api/workbench/mono/jobs/${encodeURIComponent(jobId)}?purge=true`, { method: "DELETE" });
    if (!response.ok) throw new Error("历史删除失败");
    setJobs((current) => current?.filter((job) => job.id !== jobId) ?? current);
  };

  const clearUnfavorite = async () => {
    if (!confirmClear) { setConfirmClear(true); return; }
    const response = await fetch("/api/workbench/mono/jobs", { method: "DELETE" });
    if (!response.ok) { setLoadError(true); return; }
    setJobs((current) => current?.filter((job) => job.favorite || !["succeeded", "failed", "cancelled"].includes(job.status)) ?? current);
    setConfirmClear(false);
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 sm:max-w-md">
        <SheetHeader className="pb-2">
          <SheetTitle>生成历史</SheetTitle>
          <SheetDescription>Image2 的历史任务，可收藏或复用参数继续创作。</SheetDescription>
        </SheetHeader>
        <div className="flex gap-1 px-4 pb-3">
          <Button variant={favoriteOnly ? "ghost" : "secondary"} size="xs" onClick={() => setFavoriteOnly(false)}>
            全部
          </Button>
          <Button variant={favoriteOnly ? "secondary" : "ghost"} size="xs" onClick={() => setFavoriteOnly(true)}>
            收藏
          </Button>
          <Button variant={confirmClear ? "destructive" : "ghost"} size="xs" className="ml-auto" onClick={() => void clearUnfavorite()}>
            <Trash2Icon />{confirmClear ? "确认清空未收藏" : "清空未收藏"}
          </Button>
        </div>
        <div className="flex-1 space-y-2 overflow-y-auto px-4 pb-6">
          {jobs === null ? (
            <p className="text-muted-foreground flex items-center gap-2 py-8 text-sm">
              <LoaderCircleIcon className="size-4 animate-spin" />
              正在加载历史…
            </p>
          ) : loadError ? (
            <p className="text-muted-foreground py-8 text-sm">历史加载失败，请稍后重试。</p>
          ) : jobs.length === 0 ? (
            <p className="text-muted-foreground py-8 text-sm">
              {favoriteOnly ? "还没有收藏的生成任务。点击任务右上角的星标即可收藏。" : "还没有生成记录。在对话里用「创建图片」生成的任务会出现在这里。"}
            </p>
          ) : (
            jobs.map((job) => (
              <HistoryItem
                key={job.id}
                job={job}
                reusing={reusingId === job.id}
                onToggleFavorite={() => void toggleFavorite(job)}
                onReuse={() => void reuse(job)}
                onDelete={() => void deleteJob(job.id)}
              />
            ))
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function HistoryItem({ job, reusing, onToggleFavorite, onReuse, onDelete }: {
  job: MonoJob;
  reusing: boolean;
  onToggleFavorite: () => void;
  onReuse: () => void;
  onDelete: () => void;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const input = jobInput(job);
  const template = getMonoImage2Template(input.templateId);
  const images = jobSlots(job)
    .filter((slot) => slot.status === "succeeded" && (slot.assetId || slot.imageUrl))
    .slice(0, 4);
  const failed = job.status === "failed" || job.status === "cancelled";
  const time = new Date(job.createdAt).toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <div className="border-border/70 rounded-xl border p-3">
      <div className="flex items-start justify-between gap-2">
        <p className="line-clamp-2 flex-1 text-sm">{input.prompt || template?.prompt || "（无提示词）"}</p>
        <button
          type="button"
          onClick={onToggleFavorite}
          aria-label={job.favorite ? "取消收藏" : "收藏"}
          className={cn(
            "hover:text-foreground shrink-0 rounded-md p-1 transition-colors",
            job.favorite ? "text-amber-500 hover:text-amber-500" : "text-muted-foreground",
          )}
        >
          <StarIcon className={cn("size-4", job.favorite && "fill-current")} />
        </button>
      </div>
      {images.length > 0 ? (
        <div className="mt-2 flex gap-1.5">
          {images.map((slot) => (
            <HistoryThumbnail key={slot.index} jobId={job.id} index={slot.index} />
          ))}
        </div>
      ) : (
        <p className={cn("mt-2 flex items-center gap-1.5 text-xs", failed ? "text-destructive" : "text-muted-foreground")}>
          <ImageOffIcon className="size-3.5" />
          {failed ? job.error ?? statusLabels[job.status] : statusLabels[job.status]}
        </p>
      )}
      <div className="text-muted-foreground mt-2 flex items-center justify-between gap-2 text-xs">
        <span className="truncate">
          {[template?.title, input.aspectRatio, input.variants ? `${input.variants} 张` : null, time]
            .filter(Boolean)
            .join(" · ")}
        </span>
        <Button variant="outline" size="xs" onClick={onReuse} disabled={reusing}>
          {reusing ? "正在恢复…" : "复用参数"}
        </Button>
        {["succeeded", "failed", "cancelled"].includes(job.status) ? (
          <Button
            variant={confirmDelete ? "destructive" : "ghost"}
            size={confirmDelete ? "xs" : "icon-xs"}
            title="删除历史"
            onClick={() => {
              if (!confirmDelete) { setConfirmDelete(true); return; }
              onDelete();
            }}
          ><Trash2Icon />{confirmDelete ? "确认" : null}</Button>
        ) : null}
      </div>
    </div>
  );
}

function HistoryThumbnail({ jobId, index }: { jobId: string; index: number }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <span className="text-muted-foreground flex size-14 items-center justify-center rounded-lg border p-1 text-center text-[10px] leading-tight">
        历史图片已失效
      </span>
    );
  }
  return (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={`/api/workbench/mono/jobs/${encodeURIComponent(jobId)}/image/${index}`}
        alt=""
        className="size-14 rounded-lg border object-cover"
        onError={() => setFailed(true)}
      />
    </>
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
