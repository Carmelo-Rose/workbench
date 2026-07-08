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

type RepoResponse = {
  headId: string | null;
  entries: MessageStorageEntry<Record<string, unknown>>[];
};

async function messagesApi(
  remoteId: string,
  init?: RequestInit & { query?: string },
): Promise<Response> {
  const res = await fetch(
    `/api/threads/${encodeURIComponent(remoteId)}/messages${init?.query ?? ""}`,
    init,
  );
  if (!res.ok) {
    throw new Error(
      `messages api ${init?.method ?? "GET"} failed: ${res.status}`,
    );
  }
  return res;
}

/**
 * 服务端消息历史（SQLite），实现 useAISDKRuntime 必需的 withFormat 协议
 * （内置 createLocalStorageAdapter 的 history 只支持 LocalRuntime）。
 * 消息以 ai-sdk/v6 格式经 /api/threads/[id]/messages 落库。
 */
class ServerThreadHistoryAdapter implements ThreadHistoryAdapter {
  constructor(private readonly aui: AuiApi) {}

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
    const encode = (
      item: MessageFormatItem<TMessage>,
    ): MessageStorageEntry<TStorageFormat> => ({
      id: formatAdapter.getId(item.message),
      parent_id: item.parentId,
      format: formatAdapter.format,
      content: formatAdapter.encode(item),
    });

    return {
      load: async () => {
        const remoteId = this.aui.threadListItem().getState().remoteId;
        if (!remoteId) return { messages: [] };
        const res = await messagesApi(remoteId, {
          query: `?format=${encodeURIComponent(formatAdapter.format)}`,
        });
        const repo = (await res.json()) as RepoResponse;
        return {
          headId: repo.headId,
          messages: repo.entries.map((e) =>
            formatAdapter.decode(e as MessageStorageEntry<TStorageFormat>),
          ),
        };
      },
      append: async (item) => {
        const { remoteId } = await this.aui.threadListItem().initialize();
        await messagesApi(remoteId, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ entry: encode(item) }),
        });
      },
      update: async (item, localMessageId) => {
        const remoteId = this.aui.threadListItem().getState().remoteId;
        if (!remoteId) return;
        // 重新生成时按旧 localMessageId 匹配、存到新 id 下（服务端复刻）。
        await messagesApi(remoteId, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ entry: encode(item), matchId: localMessageId }),
        });
      },
      delete: async (items) => {
        const remoteId = this.aui.threadListItem().getState().remoteId;
        if (!remoteId) return;
        await messagesApi(remoteId, {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ids: items.map((i) => formatAdapter.getId(i.message)),
          }),
        });
      },
    };
  }
}

/** 包在每个激活线程外层，向 AI SDK runtime 注入 history adapter。 */
export function createHistoryProvider(): FC<PropsWithChildren> {
  return function WorkbenchHistoryProvider({ children }) {
    const aui = useAui();
    const adapters = useMemo(
      () => ({ history: new ServerThreadHistoryAdapter(aui) }),
      [aui],
    );
    return (
      <RuntimeAdapterProvider adapters={adapters}>
        {children}
      </RuntimeAdapterProvider>
    );
  };
}
