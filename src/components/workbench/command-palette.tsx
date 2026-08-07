"use client";

import { useEffect, useMemo, useState, type FC } from "react";
import {
  CableIcon,
  DatabaseIcon,
  ImagesIcon,
  KeyRoundIcon,
  MessagesSquareIcon,
  PaletteIcon,
  SparklesIcon,
} from "lucide-react";
import { useAssistantRuntime, useAuiState } from "@assistant-ui/react";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { capabilityIconMap } from "@/components/assistant-ui/thread";
import { SLASH_CAPABILITIES, capabilityAllowed, type CapabilityOption } from "@/lib/workbench/capabilities";
import { useWorkbenchSession } from "@/components/workbench/auth-gate";
import { useCapabilityActions } from "@/components/workbench/CapabilityActions";
import { useCommandPalette } from "@/lib/workbench/command-palette-store";
import { useAssetLibrary } from "@/lib/mono/asset-library";
import type { SettingsSection } from "@/components/workbench/settings-dialog";

type ThreadSearchHit = {
  threadId: string;
  title: string | null;
  lastMessageAt: number | null;
  snippet: string | null;
  matchedIn: "title" | "message";
};

const SETTINGS_ENTRIES: { id: SettingsSection; name: string; icon: FC<{ className?: string }> }[] = [
  { id: "connections", name: "连接与模式", icon: CableIcon },
  { id: "capabilities", name: "Agent 能力", icon: SparklesIcon },
  { id: "apiConfig", name: "API 配置", icon: KeyRoundIcon },
  { id: "appearance", name: "外观", icon: PaletteIcon },
  { id: "data", name: "数据", icon: DatabaseIcon },
];

const TOOL_ENTRIES = [{ id: "asset-library", name: "作品库", icon: ImagesIcon }] as const;

const RECENT_LIMIT = 5;
const DEFAULT_CAPABILITY_LIMIT = 6;
const SEARCH_DEBOUNCE_MS = 200;

function includesQuery(text: string | undefined, lowerQuery: string): boolean {
  return !!text && text.toLowerCase().includes(lowerQuery);
}

function toRecentHit(item: { id: string; title?: string; lastMessageAt?: Date }): ThreadSearchHit {
  return {
    threadId: item.id,
    title: item.title ?? null,
    lastMessageAt: item.lastMessageAt?.getTime() ?? null,
    snippet: null,
    matchedIn: "title",
  };
}

/**
 * ⌘K 命令面板：空查询给「最近会话 + 常用能力 + 设置」，有查询时会话走服务端
 * 全文检索（debounce 200ms）、能力/设置本地子串匹配。执行能力复用
 * useCapabilityActions().run，与 chip / `/` 命令同一条路径。
 */
export const CommandPalette: FC<{ onOpenSettings: (section: SettingsSection) => void }> = ({
  onOpenSettings,
}) => {
  const open = useCommandPalette((s) => s.open);
  const query = useCommandPalette((s) => s.query);
  const setOpen = useCommandPalette((s) => s.setOpen);
  const setQuery = useCommandPalette((s) => s.setQuery);
  const { run: runCapability } = useCapabilityActions();
  const openAssetLibrary = useAssetLibrary((s) => s.openLibrary);
  const { canGrant } = useWorkbenchSession();
  const runtime = useAssistantRuntime();
  const threadIds = useAuiState((s) => s.threads.threadIds);
  const threadItems = useAuiState((s) => s.threads.threadItems);

  const [results, setResults] = useState<ThreadSearchHit[]>([]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "k") return;
      // 已有 Dialog 打开时不抢：只在自己还没开、且 DOM 里没有别的 role=dialog 时响应。
      if (!open && document.querySelector('[role="dialog"]')) return;
      event.preventDefault();
      setOpen(!open);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, setOpen]);

  const trimmedQuery = query.trim();

  useEffect(() => {
    if (!open || !trimmedQuery || !canGrant("sessions.messages.view")) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      fetch(`/api/threads/search?q=${encodeURIComponent(trimmedQuery)}&limit=8`, {
        signal: controller.signal,
      })
        .then((res) => (res.ok ? res.json() : { results: [] }))
        .then((data: { results?: ThreadSearchHit[] }) => setResults(data.results ?? []))
        .catch((error: unknown) => {
          if ((error as Error).name !== "AbortError") setResults([]);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [canGrant, open, trimmedQuery]);

  const recentThreads = useMemo(() => {
    const itemsById = new Map(threadItems.map((item) => [item.id, item]));
    return [...threadIds]
      .map((id) => itemsById.get(id))
      .filter((item): item is NonNullable<typeof item> => !!item)
      .sort((a, b) => (b.lastMessageAt?.getTime() ?? 0) - (a.lastMessageAt?.getTime() ?? 0))
      .slice(0, RECENT_LIMIT)
      .map(toRecentHit);
  }, [threadIds, threadItems]);

  const threadHits = canGrant("sessions.messages.view") ? (trimmedQuery ? results : recentThreads) : [];

  const matchedCapabilities = useMemo<CapabilityOption[]>(() => {
    const allowed = SLASH_CAPABILITIES.filter((option) => capabilityAllowed(option, canGrant));
    if (!trimmedQuery) return allowed.slice(0, DEFAULT_CAPABILITY_LIMIT);
    const lower = trimmedQuery.toLowerCase();
    return allowed.filter(
      (option) => includesQuery(option.label, lower) || includesQuery(option.hint, lower),
    );
  }, [canGrant, trimmedQuery]);

  const matchedSettings = useMemo(() => {
    const allowed = SETTINGS_ENTRIES.filter((entry) => {
      if (entry.id === "apiConfig") return canGrant("system.runtime-config.view");
      if (entry.id === "connections") return canGrant("workbench.backend.direct.use") || canGrant("workbench.backend.hermes.use");
      if (entry.id === "capabilities") return canGrant("workbench.chat.use");
      if (entry.id === "data") return canGrant("sessions.messages.import") || canGrant("sessions.messages.export") || canGrant("sessions.messages.manage");
      return true;
    });
    if (!trimmedQuery) return allowed;
    const lower = trimmedQuery.toLowerCase();
    return allowed.filter((entry) => includesQuery(entry.name, lower));
  }, [canGrant, trimmedQuery]);

  const matchedTools = useMemo(() => {
    const allowed = canGrant("resources.assets.view") ? TOOL_ENTRIES : [];
    if (!trimmedQuery) return allowed;
    const lower = trimmedQuery.toLowerCase();
    return allowed.filter((entry) => includesQuery(entry.name, lower));
  }, [canGrant, trimmedQuery]);

  const close = () => setOpen(false);

  const goToThread = (threadId: string) => {
    runtime.threads.switchToThread(threadId);
    close();
  };

  const runAndClose = (option: CapabilityOption) => {
    runCapability({ id: option.id, action: option.action, prompt: option.prompt, permission: option.permission });
    close();
  };

  const openSettingsAndClose = (section: SettingsSection) => {
    onOpenSettings(section);
    close();
  };

  const openAssetLibraryAndClose = () => {
    openAssetLibrary();
    close();
  };

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      title="命令面板"
      description="搜索会话、能力或设置"
      shouldFilter={false}
    >
      <CommandInput
        placeholder="搜索会话、能力或设置…"
        value={query}
        onValueChange={setQuery}
      />
      <CommandList>
        <CommandEmpty>没有找到匹配结果</CommandEmpty>
        {threadHits.length > 0 && (
          <CommandGroup heading={trimmedQuery ? "会话" : "最近会话"}>
            {threadHits.map((hit) => (
              <CommandItem
                key={hit.threadId}
                value={`thread-${hit.threadId}`}
                onSelect={() => goToThread(hit.threadId)}
              >
                <MessagesSquareIcon />
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">{hit.title || "新会话"}</span>
                  {hit.snippet && (
                    <span className="text-muted-foreground truncate text-xs">
                      {hit.snippet}
                    </span>
                  )}
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {matchedCapabilities.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="能力">
              {matchedCapabilities.map((option) => {
                const Icon = option.iconKey ? capabilityIconMap[option.iconKey] : undefined;
                return (
                  <CommandItem
                    key={option.id}
                    value={`capability-${option.id}`}
                    onSelect={() => runAndClose(option)}
                  >
                    {Icon && <Icon />}
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate">{option.label}</span>
                      {option.hint && (
                        <span className="text-muted-foreground truncate text-xs">
                          {option.hint}
                        </span>
                      )}
                    </span>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </>
        )}
        {matchedTools.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="工具">
              {matchedTools.map((entry) => (
                <CommandItem
                  key={entry.id}
                  value={`tool-${entry.id}`}
                  onSelect={openAssetLibraryAndClose}
                >
                  <entry.icon />
                  {entry.name}
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}
        {matchedSettings.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="设置">
              {matchedSettings.map((entry) => (
                <CommandItem
                  key={entry.id}
                  value={`settings-${entry.id}`}
                  onSelect={() => openSettingsAndClose(entry.id)}
                >
                  <entry.icon />
                  {entry.name}
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}
      </CommandList>
    </CommandDialog>
  );
};
