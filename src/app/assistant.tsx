"use client";

import {
  AssistantRuntimeProvider,
  useAssistantRuntime,
  useAuiState,
  useRemoteThreadListRuntime,
} from "@assistant-ui/react";
import {
  createLocalStorageAdapter,
  createSimpleTitleAdapter,
  type AsyncStorageLike,
} from "@assistant-ui/core/react";
import { useChatRuntime } from "@assistant-ui/react-ai-sdk";
import { CheckIcon, ChevronDownIcon, ShareIcon } from "lucide-react";
import { useEffect, useState, type FC } from "react";
import { ThreadListSidebar } from "@/components/assistant-ui/threadlist-sidebar";
import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button";
import { ImageToPromptToolUI } from "@/components/workbench/ImageToPromptToolUI";
import {
  BackendModelContext,
  HeaderBackendStatus,
} from "@/components/workbench/backend-select";
import {
  SettingsDialog,
  THREADS_STORAGE_PREFIX,
  type SettingsSection,
} from "@/components/workbench/settings-dialog";
import {
  THREAD_STYLES,
  loadThreadStyle,
  saveThreadStyle,
  type ThreadStyleId,
} from "@/components/workbench/thread-styles";
import {
  CompanionLayer,
  CompanionPicker,
  loadCompanion,
  saveCompanion,
  type CompanionId,
} from "@/components/workbench/pets/companion";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import {
  useAgentStatus,
  useAgentStatusPolling,
  useBackendChoice,
} from "@/lib/agent-status";
import { applyThemePref, loadThemePref } from "@/lib/theme";
import { createHistoryProvider } from "@/lib/thread-history";

/** 会话历史落在浏览器 localStorage（mono:threads / mono:messages:*）。 */
const browserStorage: AsyncStorageLike = {
  getItem: async (key) =>
    typeof window === "undefined" ? null : window.localStorage.getItem(key),
  setItem: async (key, value) => {
    if (typeof window !== "undefined") window.localStorage.setItem(key, value);
  },
  removeItem: async (key) => {
    if (typeof window !== "undefined") window.localStorage.removeItem(key);
  },
};

const threadListAdapter = {
  ...createLocalStorageAdapter({
    storage: browserStorage,
    prefix: THREADS_STORAGE_PREFIX,
    titleGenerator: createSimpleTitleAdapter(),
  }),
  // 内置 history Provider 只兼容 LocalRuntime，换成实现 withFormat 的版本
  // 以对接 AI SDK runtime（消息以 ai-sdk/v6 格式落 localStorage）。
  unstable_Provider: createHistoryProvider(THREADS_STORAGE_PREFIX),
};

// useChatRuntime 内部的 RemoteThreadListRuntime 检测到外层实例后透传，
// 由外层的 localStorage adapter 接管线程列表与消息历史。
const useMonoThreadRuntime = () => useChatRuntime();

export const Assistant = () => {
  const runtime = useRemoteThreadListRuntime({
    runtimeHook: useMonoThreadRuntime,
    adapter: threadListAdapter,
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ImageToPromptToolUI />
      <BackendModelContext />
      <ThreadTitleSync />
      <AssistantShell />
    </AssistantRuntimeProvider>
  );
};

/** 首轮问答结束后为无标题线程生成标题（取首条用户消息摘要）。 */
const ThreadTitleSync: FC = () => {
  const runtime = useAssistantRuntime();
  const shouldGenerate = useAuiState((s) => {
    const item = s.threads.threadItems.find(
      (t) => t.id === s.threads.mainThreadId,
    );
    return (
      item !== undefined &&
      !item.title &&
      !s.thread.isRunning &&
      s.thread.messages.length >= 2
    );
  });

  useEffect(() => {
    if (!shouldGenerate) return;
    runtime.threads.mainItem.generateTitle().catch(() => {
      // 标题生成失败不影响对话，静默跳过。
    });
  }, [shouldGenerate, runtime]);

  return null;
};

const ThreadTitle: FC = () => {
  const title = useAuiState(
    (s) =>
      s.threads.threadItems.find((t) => t.id === s.threads.mainThreadId)?.title,
  );

  return (
    <span className="text-muted-foreground min-w-0 truncate text-sm">
      {title ?? "新对话"}
    </span>
  );
};

const StylePicker: FC<{
  value: ThreadStyleId;
  onChange: (id: ThreadStyleId) => void;
}> = ({ value, onChange }) => {
  const active = THREAD_STYLES.find((s) => s.id === value) ?? THREAD_STYLES[0];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="text-foreground -mx-1 h-7 gap-1 rounded-full px-2.5 font-normal data-[state=open]:bg-accent"
        >
          {active.name}
          <ChevronDownIcon className="text-muted-foreground size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-36 rounded-xl">
        {THREAD_STYLES.map((style) => (
          <DropdownMenuItem
            key={style.id}
            onSelect={() => onChange(style.id)}
            className="justify-between rounded-lg"
          >
            {style.name}
            {style.id === value && <CheckIcon className="size-4" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

const AssistantShell: FC = () => {
  const [styleId, setStyleId] = useState<ThreadStyleId>(loadThreadStyle);
  const [companion, setCompanion] = useState<CompanionId>(loadCompanion);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] =
    useState<SettingsSection>("connections");
  const active = THREAD_STYLES.find((s) => s.id === styleId) ?? THREAD_STYLES[0];
  const ActiveThread = active.Component;
  const isWorking = useAuiState((s) => s.thread.isRunning);

  // 双后端健康轮询；未手动选过模式时跟随服务端默认。
  useAgentStatusPolling();
  const status = useAgentStatus((s) => s.status);
  const adoptServerDefault = useBackendChoice((s) => s.adoptServerDefault);
  useEffect(() => {
    if (status) adoptServerDefault(status.defaultBackend);
  }, [status, adoptServerDefault]);

  // 应用主题偏好，"跟随系统"时响应系统切换。
  useEffect(() => {
    applyThemePref(loadThemePref());
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      if (loadThemePref() === "system") applyThemePref("system");
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const handleStyleChange = (id: ThreadStyleId) => {
    setStyleId(id);
    saveThreadStyle(id);
  };

  const handleCompanionChange = (id: CompanionId) => {
    setCompanion(id);
    saveCompanion(id);
  };

  const openSettings = (section: SettingsSection) => {
    setSettingsSection(section);
    setSettingsOpen(true);
  };

  return (
    <SidebarProvider className="h-dvh min-h-0 overflow-hidden">
      <ThreadListSidebar
        variant="inset"
        onOpenSettings={() => openSettings("connections")}
      />
      <SidebarInset className="overflow-hidden">
        <header className="flex h-13 shrink-0 items-center gap-1.5 px-3">
          <SidebarTrigger className="size-8 rounded-full" />
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem className="hidden md:block">
                <BreadcrumbPage className="font-medium">Workbench</BreadcrumbPage>
              </BreadcrumbItem>
              <BreadcrumbSeparator className="hidden md:block" />
              <BreadcrumbItem>
                <StylePicker value={styleId} onChange={handleStyleChange} />
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
          <span className="text-border mx-1 hidden select-none md:block">·</span>
          <ThreadTitle />
          <div className="ml-auto flex items-center gap-1.5">
            <HeaderBackendStatus onClick={() => openSettings("connections")} />
            <CompanionPicker
              value={companion}
              onChange={handleCompanionChange}
            />
            <TooltipIconButton
              variant="ghost"
              size="icon"
              tooltip="Share"
              side="bottom"
              disabled
              className="size-8 rounded-full"
            >
              <ShareIcon className="size-4" />
            </TooltipIconButton>
          </div>
        </header>
        <main className="min-h-0 flex-1 overflow-hidden">
          <div
            key={styleId}
            className="fade-in animate-in h-full duration-200"
          >
            <ActiveThread />
          </div>
        </main>
      </SidebarInset>
      <CompanionLayer companion={companion} isWorking={isWorking} />
      <SettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        section={settingsSection}
        onSectionChange={setSettingsSection}
        styleId={styleId}
        onStyleChange={handleStyleChange}
        companion={companion}
        onCompanionChange={handleCompanionChange}
      />
    </SidebarProvider>
  );
};
