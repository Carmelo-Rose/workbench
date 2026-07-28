"use client";

import {
  AssistantRuntimeProvider,
  useAssistantRuntime,
  useAui,
  useAuiState,
  useRemoteThreadListRuntime,
} from "@assistant-ui/react";
import { useChatRuntime } from "@assistant-ui/react-ai-sdk";
import {
  CheckIcon,
  ChevronDownIcon,
  LogOutIcon,
  MonitorIcon,
  MoonIcon,
  ShareIcon,
  SunIcon,
} from "lucide-react";
import { useEffect, useState, type FC, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import { ThreadListSidebar } from "@/components/assistant-ui/threadlist-sidebar";
import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button";
import { ImageToPromptToolUI } from "@/components/workbench/ImageToPromptToolUI";
import {
  VideoEnhanceToolUI,
  VideoEraseToolUI,
  VideoMattingToolUI,
} from "@/components/workbench/toolbox/JobToolUI";
import { workbenchAttachmentAdapter } from "@/components/workbench/toolbox/attachment-adapter";
import {
  MonoAnalyzeVideoToolUI,
  MonoCancelJobToolUI,
  MonoCreateAssetToolUI,
  MonoGenerateImageToolUI,
  MonoGetJobToolUI,
  MonoMattingToolUI,
  MonoProductPipelineToolUI,
} from "@/components/workbench/MonoToolUI";
import {
  CollectorBatchesToolUI,
  CollectorSearchToolUI,
  LuopanEventsToolUI,
  LuopanRankInsightsToolUI,
  LuopanRoundsToolUI,
  LuopanSnapshotToolUI,
  LuopanTrendToolUI,
} from "@/components/workbench/CollectorToolUI";
import {
  BackendModelContext,
  HeaderBackendStatus,
} from "@/components/workbench/backend-select";
import {
  SettingsDialog,
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
import {
  applyThemePref,
  loadThemePref,
  saveThemePref,
  type ThemePref,
} from "@/lib/theme";
import { serverThreadListAdapter } from "@/lib/server-threads";
import { createHistoryProvider } from "@/lib/thread-history";
import { useImage2Mode } from "@/lib/image2-mode";
import { useWorkbenchSession } from "@/components/workbench/auth-gate";

/** 会话历史落在服务端 SQLite（/api/threads），首次加载自动迁移旧 localStorage。 */
const threadListAdapter = {
  ...serverThreadListAdapter(),
  // 内置 history Provider 只兼容 LocalRuntime，换成实现 withFormat 的版本
  // 以对接 AI SDK runtime（消息以 ai-sdk/v6 格式落 SQLite）。
  unstable_Provider: createHistoryProvider(),
};

// useChatRuntime 内部的 RemoteThreadListRuntime 检测到外层实例后透传，
// 由外层的 localStorage adapter 接管线程列表与消息历史。
// 附件适配器：视频上传到工具箱网关（消息里只留 fileId 标记），其余走默认 data URL。
const useMonoThreadRuntime = () =>
  useChatRuntime({
    adapters: { attachments: workbenchAttachmentAdapter },
  });

export const Assistant = () => {
  const runtime = useRemoteThreadListRuntime({
    runtimeHook: useMonoThreadRuntime,
    adapter: threadListAdapter,
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ImageToPromptToolUI />
      <MonoGenerateImageToolUI />
      <MonoAnalyzeVideoToolUI />
      <MonoCreateAssetToolUI />
      <MonoGetJobToolUI />
      <MonoCancelJobToolUI />
      <MonoMattingToolUI />
      <MonoProductPipelineToolUI />
      <LuopanRoundsToolUI />
      <LuopanSnapshotToolUI />
      <LuopanTrendToolUI />
      <LuopanEventsToolUI />
      <LuopanRankInsightsToolUI />
      <CollectorBatchesToolUI />
      <CollectorSearchToolUI />
      <VideoEraseToolUI />
      <VideoEnhanceToolUI />
      <VideoMattingToolUI />
      <BackendModelContext />
      <Image2ModeSync />
      <ThreadTitleSync />
      <AssistantShell />
    </AssistantRuntimeProvider>
  );
};

const Image2ModeSync: FC = () => {
  const searchParams = useSearchParams();
  const aui = useAui();
  const active = useImage2Mode((state) => state.active);
  const activate = useImage2Mode((state) => state.activate);
  const deactivate = useImage2Mode((state) => state.deactivate);
  const pendingComposer = useImage2Mode((state) => state.pendingComposer);
  const consumePendingComposer = useImage2Mode((state) => state.consumePendingComposer);
  const requested = searchParams.get("mode") === "image2";

  useEffect(() => {
    if (requested && !active) activate();
    if (!requested && active) deactivate();
  }, [active, activate, deactivate, requested]);

  // 消息树深处的卡片（反推结果、生图结果）拿不到 composer 的 ambient scope，
  // 它们只往 store 里落一份待写入内容，由这个顶层组件代为写进真正的 composer。
  useEffect(() => {
    if (!pendingComposer) return;
    consumePendingComposer();
    const { text, files, appendFiles } = pendingComposer;
    if (text !== undefined) aui.composer().setText(text);
    if (files?.length) {
      void (async () => {
        // 覆盖逻辑保留给「再次生成」：它需要用原任务的完整参考图重建输入。
        await aui.composer().clearAttachments();
        for (const file of files) await aui.composer().addAttachment(file);
      })();
    }
    if (appendFiles?.length) {
      void (async () => {
        // 原来这里和 files 共用 clearAttachments，会把用户已选的参考图覆盖掉。
        // await aui.composer().clearAttachments();
        for (const file of appendFiles) await aui.composer().addAttachment(file);
      })();
    }
  }, [pendingComposer, aui, consumePendingComposer]);

  return null;
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

/** 头部主题快切：跟随系统 → 浅色 → 深色 循环，与设置里的选择保持同步。 */
const THEME_TOGGLE_META: Record<
  ThemePref,
  { label: string; icon: ReactNode }
> = {
  system: { label: "主题：跟随系统", icon: <MonitorIcon className="size-4" /> },
  light: { label: "主题：浅色", icon: <SunIcon className="size-4" /> },
  dark: { label: "主题：深色", icon: <MoonIcon className="size-4" /> },
};

const NEXT_THEME: Record<ThemePref, ThemePref> = {
  system: "light",
  light: "dark",
  dark: "system",
};

const ThemeToggle: FC<{
  value: ThemePref;
  onChange: (pref: ThemePref) => void;
}> = ({ value, onChange }) => {
  const meta = THEME_TOGGLE_META[value];
  return (
    <TooltipIconButton
      variant="ghost"
      size="icon"
      tooltip={meta.label}
      side="bottom"
      className="size-8 rounded-full"
      onClick={() => onChange(NEXT_THEME[value])}
    >
      {meta.icon}
    </TooltipIconButton>
  );
};

const WorkspaceMenu: FC<{ onOpenSettings: () => void }> = ({ onOpenSettings }) => {
  const { session, signOut, switchWorkspace } = useWorkbenchSession();

  const selectWorkspace = async (workspaceId: string) => {
    if (workspaceId === session.workspace.id) return;
    await switchWorkspace(workspaceId);
    window.location.reload();
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="text-foreground hidden h-8 max-w-40 gap-1.5 rounded-full px-2.5 font-normal sm:flex"
          title={session.workspace.name}
        >
          <span className="truncate">{session.workspace.name}</span>
          <ChevronDownIcon className="text-muted-foreground size-3.5 shrink-0" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-52 rounded-xl">
        <p className="text-muted-foreground px-2 py-1.5 text-xs">
          {session.actor.displayName}
        </p>
        {session.workspaces.map((workspace) => (
          <DropdownMenuItem
            key={workspace.id}
            onSelect={() => void selectWorkspace(workspace.id)}
            className="justify-between rounded-lg"
          >
            <span className="truncate">{workspace.name}</span>
            {workspace.id === session.workspace.id && <CheckIcon className="size-4" />}
          </DropdownMenuItem>
        ))}
        <DropdownMenuItem onSelect={onOpenSettings} className="rounded-lg">
          员工与工作区
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void signOut()} className="rounded-lg">
          <LogOutIcon className="size-4" />
          退出登录
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

const AssistantShell: FC = () => {
  const [styleId, setStyleId] = useState<ThreadStyleId>(loadThreadStyle);
  const [companion, setCompanion] = useState<CompanionId>(loadCompanion);
  const [themePref, setThemePref] = useState<ThemePref>(loadThemePref);
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

  const handleThemeChange = (pref: ThemePref) => {
    setThemePref(pref);
    saveThemePref(pref);
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
            <WorkspaceMenu onOpenSettings={() => openSettings("workspace")} />
            <HeaderBackendStatus onClick={() => openSettings("connections")} />
            <ThemeToggle value={themePref} onChange={handleThemeChange} />
            <CompanionPicker
              value={companion}
              onChange={handleCompanionChange}
            />
            {/* 原生 disabled 不派发指针事件、tooltip 永不出现，改用 aria-disabled 占位。 */}
            <TooltipIconButton
              variant="ghost"
              size="icon"
              tooltip="分享 · 即将上线"
              side="bottom"
              aria-disabled="true"
              className="size-8 cursor-default rounded-full opacity-50 hover:bg-transparent active:scale-100"
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
        themePref={themePref}
        onThemeChange={handleThemeChange}
      />
    </SidebarProvider>
  );
};
