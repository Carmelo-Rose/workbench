"use client";

import { CheckIcon, LoaderCircleIcon, XIcon } from "lucide-react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { JOB_TITLES, jobMeta } from "@/components/workbench/JobCard";
import { useJobCenter } from "@/lib/mono/job-center";
import type { MonoJob } from "@/lib/mono/contracts";

const terminalStatuses = new Set<MonoJob["status"]>(["succeeded", "failed", "cancelled"]);

export function JobCenterSheet() {
  const open = useJobCenter((state) => state.open);
  const close = useJobCenter((state) => state.closeSheet);
  const jobs = useJobCenter((state) => state.jobs);
  const loading = useJobCenter((state) => state.loading);
  const error = useJobCenter((state) => state.error);

  return (
    <Sheet open={open} onOpenChange={(next) => { if (!next) close(); }}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 sm:max-w-md">
        <SheetHeader className="pb-2">
          <SheetTitle>任务中心</SheetTitle>
          <SheetDescription>最近的生图、视频、抠像与商品套图任务，切换会话不会丢失。</SheetDescription>
        </SheetHeader>
        <div className="flex-1 overflow-y-auto px-4 py-3">
          {loading && jobs.length === 0 ? (
            <p className="text-muted-foreground flex items-center gap-2 py-8 text-sm">
              <LoaderCircleIcon className="size-4 animate-spin" />正在加载任务…
            </p>
          ) : error && jobs.length === 0 ? (
            <p className="text-destructive py-8 text-sm">{error}</p>
          ) : jobs.length === 0 ? (
            <p className="text-muted-foreground py-8 text-sm">还没有任务。</p>
          ) : (
            <div className="space-y-2">
              {jobs.map((job) => <JobRow key={job.id} job={job} />)}
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function JobRow({ job }: { job: MonoJob }) {
  const meta = jobMeta[job.status];
  const isActive = !terminalStatuses.has(job.status);
  return (
    <div className="rounded-xl border p-2.5">
      <div className="flex items-center justify-between gap-3">
        <span className="min-w-0 truncate text-sm font-medium">{JOB_TITLES[job.kind]}</span>
        <span className={`flex shrink-0 items-center gap-1 text-xs ${meta.tone}`}>
          {isActive ? <LoaderCircleIcon className="size-3.5 animate-spin" /> : job.status === "succeeded" ? <CheckIcon className="size-3.5" /> : <XIcon className="size-3.5" />}
          {meta.label}
        </span>
      </div>
      <p className="text-muted-foreground mt-1 text-xs">{formatRelativeTime(job.updatedAt)}</p>
      {job.status === "failed" && job.error ? (
        <p className="text-destructive mt-1.5 truncate text-xs" title={job.error}>{job.error}</p>
      ) : null}
    </div>
  );
}

function formatRelativeTime(timestampMs: number): string {
  const deltaSeconds = Math.max(0, Math.round((Date.now() - timestampMs) / 1000));
  if (deltaSeconds < 60) return "刚刚";
  const deltaMinutes = Math.round(deltaSeconds / 60);
  if (deltaMinutes < 60) return `${deltaMinutes} 分钟前`;
  const deltaHours = Math.round(deltaMinutes / 60);
  if (deltaHours < 24) return `${deltaHours} 小时前`;
  const deltaDays = Math.round(deltaHours / 24);
  return `${deltaDays} 天前`;
}
