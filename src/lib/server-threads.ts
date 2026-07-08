"use client";

import type { RemoteThreadListAdapter } from "@assistant-ui/react";
import { createSimpleTitleAdapter } from "@assistant-ui/core/react";
import { createAssistantStream } from "assistant-stream";
import { THREADS_STORAGE_PREFIX } from "@/components/workbench/settings-dialog";

/** 服务端 ThreadRecord 的线格式（时间戳为 epoch ms）。 */
type ThreadDto = {
  remoteId: string;
  externalId: string | null;
  status: "regular" | "archived";
  title: string | null;
  custom: Record<string, unknown> | null;
  createdAt: number;
  updatedAt: number;
  lastMessageAt: number | null;
};

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) {
    throw new Error(
      `threads api ${init?.method ?? "GET"} ${path} failed: ${res.status}`,
    );
  }
  return res.json() as Promise<T>;
}

function patchThread(
  remoteId: string,
  patch: Record<string, unknown>,
): Promise<unknown> {
  return api(`/api/threads/${encodeURIComponent(remoteId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
}

function toMetadata(t: ThreadDto) {
  return {
    status: t.status,
    remoteId: t.remoteId,
    externalId: t.externalId ?? undefined,
    title: t.title ?? undefined,
    lastMessageAt:
      t.lastMessageAt != null ? new Date(t.lastMessageAt) : undefined,
    custom: t.custom ?? undefined,
  };
}

const MIGRATED_KEY = `${THREADS_STORAGE_PREFIX}migrated`;

type LocalThreadMeta = {
  remoteId: string;
  externalId?: string;
  status?: string;
  title?: string;
  custom?: Record<string, unknown>;
};

/**
 * localStorage → SQLite 一次性静默迁移。本地数据保留作冻结备份，不删除。
 * 已迁移 / 本地无数据 / 服务端非空 → 打标记跳过。
 */
async function migrateLocalStorageOnce(): Promise<void> {
  if (typeof window === "undefined") return;
  const ls = window.localStorage;
  if (ls.getItem(MIGRATED_KEY)) return;

  const rawThreads = ls.getItem(`${THREADS_STORAGE_PREFIX}threads`);
  const localThreads: LocalThreadMeta[] = rawThreads
    ? (JSON.parse(rawThreads) as LocalThreadMeta[])
    : [];
  if (!Array.isArray(localThreads) || localThreads.length === 0) {
    ls.setItem(MIGRATED_KEY, "1");
    return;
  }

  const { threads } = await api<{ threads: ThreadDto[] }>("/api/threads");
  if (threads.length > 0) {
    ls.setItem(MIGRATED_KEY, "1");
    return;
  }

  const snapshots = localThreads.map((t) => {
    let repo: { headId?: string | null; entries?: unknown[] } = {};
    try {
      const raw = ls.getItem(`${THREADS_STORAGE_PREFIX}messages:${t.remoteId}`);
      if (raw) repo = JSON.parse(raw) as typeof repo;
    } catch {
      // 单个线程消息损坏时仍迁移其元数据
    }
    return {
      thread: {
        remoteId: t.remoteId,
        externalId: t.externalId ?? null,
        status: t.status === "archived" ? "archived" : "regular",
        title: t.title ?? null,
        custom: t.custom ?? null,
        lastMessageAt: null,
      },
      headId: repo.headId ?? null,
      entries: Array.isArray(repo.entries) ? repo.entries : [],
    };
  });

  await api("/api/threads/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ snapshots }),
  });
  ls.setItem(MIGRATED_KEY, "1");
  console.log(`[workbench] 已迁移 ${snapshots.length} 个本地线程到服务端`);
}

let migration: Promise<void> | undefined;
export function ensureMigrated(): Promise<void> {
  // 失败只告警不打标记，下次整页加载会重试。
  migration ??= migrateLocalStorageOnce().catch((err) => {
    console.warn("[workbench] localStorage 迁移失败", err);
  });
  return migration;
}

/** 把 /api/threads 路由映射为 RemoteThreadListAdapter。 */
export function serverThreadListAdapter(): RemoteThreadListAdapter {
  const titleAdapter = createSimpleTitleAdapter();
  return {
    async list() {
      await ensureMigrated();
      const { threads } = await api<{ threads: ThreadDto[] }>("/api/threads");
      return { threads: threads.map(toMetadata) };
    },
    async initialize(threadId) {
      const res = await api<{ remoteId: string; externalId: string | null }>(
        "/api/threads",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ threadId }),
        },
      );
      return { remoteId: res.remoteId, externalId: res.externalId ?? undefined };
    },
    async rename(remoteId, newTitle) {
      await patchThread(remoteId, { title: newTitle });
    },
    async updateCustom(remoteId, custom) {
      await patchThread(remoteId, { custom: custom ?? null });
    },
    async archive(remoteId) {
      await patchThread(remoteId, { status: "archived" });
    },
    async unarchive(remoteId) {
      await patchThread(remoteId, { status: "regular" });
    },
    async delete(remoteId) {
      await api(`/api/threads/${encodeURIComponent(remoteId)}`, {
        method: "DELETE",
      });
    },
    async fetch(threadId) {
      const t = await api<ThreadDto>(
        `/api/threads/${encodeURIComponent(threadId)}`,
      );
      return toMetadata(t);
    },
    async generateTitle(remoteId, messages) {
      const title = await titleAdapter.generateTitle(messages);
      await patchThread(remoteId, { title });
      return createAssistantStream((controller) => {
        controller.appendText(title);
      });
    },
  };
}
