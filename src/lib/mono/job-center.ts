"use client";

import { useEffect } from "react";
import { create } from "zustand";
import { monoJobKinds, type MonoJob } from "@/lib/mono/contracts";

const ACTIVE_STATUSES = new Set<MonoJob["status"]>(["queued", "running"]);
const JOB_CENTER_KINDS = monoJobKinds.join(",");

type JobCenterStore = {
  jobs: MonoJob[];
  loading: boolean;
  error: string | null;
  open: boolean;
  openSheet: () => void;
  closeSheet: () => void;
  refresh: () => Promise<void>;
};

/** 任务入口与任务中心 Sheet 共享同一份轮询结果，跨全部任务类型。 */
export const useJobCenter = create<JobCenterStore>((set, get) => ({
  jobs: [],
  loading: false,
  error: null,
  open: false,
  openSheet: () => set({ open: true }),
  closeSheet: () => set({ open: false }),
  refresh: async () => {
    if (get().loading) return;
    set({ loading: true });
    try {
      const res = await fetch(
        `/api/workbench/mono/jobs?kinds=${JOB_CENTER_KINDS}&limit=50`,
        { cache: "no-store" },
      );
      if (res.ok) {
        const payload = (await res.json()) as { jobs?: MonoJob[] };
        set({ jobs: payload.jobs ?? [], error: null });
      } else {
        set({ error: "任务列表加载失败" });
      }
    } catch {
      set({ error: "任务列表加载失败" });
    } finally {
      set({ loading: false });
    }
  },
}));

/** 在应用外壳挂一次：进入时探测，之后每 10s 及窗口聚焦时刷新。 */
export function useJobCenterPolling(intervalMs = 10_000, enabled = true) {
  const refresh = useJobCenter((state) => state.refresh);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
    const timer = setInterval(() => void refresh(), intervalMs);
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [enabled, refresh, intervalMs]);
}

export function useJobCenterActiveCount(): number {
  return useJobCenter((state) =>
    state.jobs.reduce((count, job) => count + (ACTIVE_STATUSES.has(job.status) ? 1 : 0), 0));
}
