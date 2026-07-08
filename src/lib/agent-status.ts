"use client";

import { useEffect } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { isBackendId, type AgentStatus, type BackendId } from "@/lib/backends";

type AgentStatusStore = {
  status: AgentStatus | null;
  checking: boolean;
  lastChecked: number | null;
  refresh: () => Promise<void>;
};

/** 双后端连接状态，头部状态徽标与设置弹窗共享同一份轮询结果。 */
export const useAgentStatus = create<AgentStatusStore>((set, get) => ({
  status: null,
  checking: false,
  lastChecked: null,
  refresh: async () => {
    if (get().checking) return;
    set({ checking: true });
    try {
      const res = await fetch("/api/agent/status", { cache: "no-store" });
      if (res.ok) {
        set({ status: (await res.json()) as AgentStatus, lastChecked: Date.now() });
      } else {
        console.warn(`[workbench] 状态探测返回 ${res.status}`);
      }
    } catch (err) {
      // 网络抖动时保留上一次结果，状态点会因 stale 显示为未知。
      console.warn("[workbench] 状态探测失败", err);
    } finally {
      set({ checking: false });
    }
  },
}));

/** 在应用外壳挂一次：进入时探测，之后每 30s 及窗口聚焦时刷新。 */
export function useAgentStatusPolling(intervalMs = 30_000) {
  const refresh = useAgentStatus((s) => s.refresh);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), intervalMs);
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh, intervalMs]);
}

type BackendChoiceStore = {
  backend: BackendId;
  /** 用户是否手动选过；没选过时跟随服务端默认。 */
  chosen: boolean;
  setBackend: (id: BackendId) => void;
  adoptServerDefault: (id: string) => void;
};

/** 当前对话模式（direct / hermes），localStorage 持久化。 */
export const useBackendChoice = create<BackendChoiceStore>()(
  persist(
    (set, get) => ({
      backend: "direct",
      chosen: false,
      setBackend: (backend) => set({ backend, chosen: true }),
      adoptServerDefault: (id) => {
        if (!get().chosen && isBackendId(id)) set({ backend: id });
      },
    }),
    { name: "wb:backend" },
  ),
);

export type ConnState = "ok" | "down" | "unknown";

export function hermesConnState(status: AgentStatus | null): ConnState {
  if (!status) return "unknown";
  return status.hermes.ok ? "ok" : "down";
}

export function directConnState(status: AgentStatus | null): ConnState {
  if (!status) return "unknown";
  return status.direct.configured ? "ok" : "down";
}
