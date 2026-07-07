"use client";

import { useMemo, type FC, type PropsWithChildren } from "react";
import {
  RuntimeAdapterProvider,
  useAui,
  type GenericThreadHistoryAdapter,
  type MessageFormatAdapter,
  type MessageFormatItem,
  type MessageStorageEntry,
  type ThreadHistoryAdapter,
} from "@assistant-ui/react";

type AuiApi = ReturnType<typeof useAui>;

type StoredRepo = {
  headId?: string | null;
  entries: MessageStorageEntry<Record<string, unknown>>[];
};

/**
 * localStorage 消息历史，实现 useAISDKRuntime 必需的 withFormat 协议
 * （内置 createLocalStorageAdapter 的 history 只支持 LocalRuntime）。
 * 存储键 `${prefix}messages:<remoteId>`，与线程列表 adapter 的删除逻辑对齐。
 */
class LocalStorageThreadHistoryAdapter implements ThreadHistoryAdapter {
  constructor(
    private readonly aui: AuiApi,
    private readonly prefix: string,
  ) {}

  private key(remoteId: string) {
    return `${this.prefix}messages:${remoteId}`;
  }

  private read(remoteId: string): StoredRepo {
    try {
      const raw = window.localStorage.getItem(this.key(remoteId));
      if (!raw) return { entries: [] };
      const parsed = JSON.parse(raw) as StoredRepo;
      return Array.isArray(parsed.entries) ? parsed : { entries: [] };
    } catch {
      return { entries: [] };
    }
  }

  private write(remoteId: string, repo: StoredRepo) {
    window.localStorage.setItem(this.key(remoteId), JSON.stringify(repo));
  }

  // useAISDKRuntime 只走 withFormat 路径；裸 load/append 仅为满足接口。
  async load() {
    return { messages: [] };
  }

  async append() {
    // no-op：AI SDK runtime 不会调用
  }

  withFormat<TMessage, TStorageFormat extends Record<string, unknown>>(
    formatAdapter: MessageFormatAdapter<TMessage, TStorageFormat>,
  ): GenericThreadHistoryAdapter<TMessage> {
    const upsert = (
      repo: StoredRepo,
      item: MessageFormatItem<TMessage>,
      matchId?: string,
    ) => {
      const id = formatAdapter.getId(item.message);
      const entry: MessageStorageEntry<TStorageFormat> = {
        id,
        parent_id: item.parentId,
        format: formatAdapter.format,
        content: formatAdapter.encode(item),
      };
      const idx = repo.entries.findIndex(
        (e) => e.id === id || (matchId !== undefined && e.id === matchId),
      );
      if (idx >= 0) repo.entries[idx] = entry;
      else repo.entries.push(entry);
      return id;
    };

    return {
      load: async () => {
        const remoteId = this.aui.threadListItem().getState().remoteId;
        if (!remoteId) return { messages: [] };
        const repo = this.read(remoteId);
        return {
          headId: repo.headId ?? null,
          messages: repo.entries
            .filter((e) => e.format === formatAdapter.format)
            .map((e) =>
              formatAdapter.decode(e as MessageStorageEntry<TStorageFormat>),
            ),
        };
      },
      append: async (item) => {
        const { remoteId } = await this.aui.threadListItem().initialize();
        const repo = this.read(remoteId);
        repo.headId = upsert(repo, item);
        this.write(remoteId, repo);
      },
      update: async (item, localMessageId) => {
        const remoteId = this.aui.threadListItem().getState().remoteId;
        if (!remoteId) return;
        const repo = this.read(remoteId);
        const id = upsert(repo, item, localMessageId);
        if (repo.headId === localMessageId) repo.headId = id;
        this.write(remoteId, repo);
      },
      delete: async (items) => {
        const remoteId = this.aui.threadListItem().getState().remoteId;
        if (!remoteId) return;
        const repo = this.read(remoteId);
        const ids = new Set(items.map((i) => formatAdapter.getId(i.message)));
        repo.entries = repo.entries.filter((e) => !ids.has(e.id));
        if (repo.headId && ids.has(repo.headId)) {
          repo.headId = repo.entries.at(-1)?.id ?? null;
        }
        this.write(remoteId, repo);
      },
    };
  }
}

/** 包在每个激活线程外层，向 AI SDK runtime 注入 history adapter。 */
export function createHistoryProvider(prefix: string): FC<PropsWithChildren> {
  return function MonoHistoryProvider({ children }) {
    const aui = useAui();
    const adapters = useMemo(
      () => ({ history: new LocalStorageThreadHistoryAdapter(aui, prefix) }),
      [aui],
    );
    return (
      <RuntimeAdapterProvider adapters={adapters}>
        {children}
      </RuntimeAdapterProvider>
    );
  };
}
