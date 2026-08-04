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
  DownloadIcon,
  MonitorIcon,
  MoonIcon,
  MoreHorizontalIcon,
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
import { BackendModelContext } from "@/components/workbench/backend-select";
import {
  SettingsDialog,
  type SettingsSection,
} from "@/components/workbench/settings-dialog";
import { CommandPalette } from "@/components/workbench/command-palette";
import { ThreadFindBar } from "@/components/assistant-ui/thread-find";
import { DraftPersistence } from "@/components/workbench/draft-persistence";
import { GlobalShortcuts } from "@/components/workbench/global-shortcuts";
import { JobCenterSheet } from "@/components/workbench/JobCenterSheet";
import { useJobCenterPolling } from "@/lib/mono/job-center";
import { CapabilityActionsProvider } from "@/components/workbench/CapabilityActions";
import {
  THREAD_STYLES,
  loadThreadStyle,
  saveThreadStyle,
  type ThreadStyleId,
} from "@/components/workbench/thread-styles";
import {
  CompanionLayer,
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
import {
  loadDensityPref,
  saveDensityPref,
  type DensityPref,
} from "@/lib/density";
import { serverThreadListAdapter } from "@/lib/server-threads";
import { createHistoryProvider } from "@/lib/thread-history";
import { useImage2Mode } from "@/lib/image2-mode";
import { useVideoGenerationMode } from "@/lib/video-generation-mode";
import { useWorkbenchSession } from "@/components/workbench/auth-gate";
import { adoptComposerImageAsVideoFrame } from "@/components/workbench/VideoGenerationMode";

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
      <VideoGenerationModeSync />
      <ThreadTitleSync />
      {/* 提到这一层而不是 Thread 内部：CommandPalette 与非 base 的样式变体
          (ChatGPT/Grok/Gemini) 都要能拿到同一份 run()，不只是默认样式。 */}
      <CapabilityActionsProvider>
        <AssistantShell />
      </CapabilityActionsProvider>
    </AssistantRuntimeProvider>
  );
};

const Image2ModeSync: FC = () => {
  const searchParams = useSearchParams();
  const aui = useAui();
  const activate = useImage2Mode((state) => state.activate);
  const deactivate = useImage2Mode((state) => state.deactivate);
  const pendingComposer = useImage2Mode((state) => state.pendingComposer);
  const consumePendingComposer = useImage2Mode((state) => state.consumePendingComposer);
  const requested = searchParams.get("mode") === "image2";

  // `requested` (the URL) is the only dependency on purpose: exit handlers
  // (useExitImage2Mode) flip `active` off directly for instant feedback, then
  // navigate. If `active` were also a dependency here, that direct flip would
  // re-run this effect before the URL update lands, see stale `requested`
  // still true, and immediately reactivate — the exit never sticks. Reading
  // `active` via getState() (not the subscribed hook) keeps this a one-way
  // URL-to-store sync instead of a second writer fighting the exit handler.
  useEffect(() => {
    if (requested && !useImage2Mode.getState().active) activate();
    if (!requested && useImage2Mode.getState().active) deactivate();
  }, [activate, deactivate, requested]);

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

/** Query-driven entry point for the real Create Video mode. */
const VideoGenerationModeSync: FC = () => {
  const searchParams = useSearchParams();
  const aui = useAui();
  const activate = useVideoGenerationMode((state) => state.activate);
  const deactivate = useVideoGenerationMode((state) => state.deactivate);
  const restoreCurrentJob = useVideoGenerationMode((state) => state.restoreCurrentJob);
  const requested = searchParams.get("mode") === "video";
  const { session } = useWorkbenchSession();
  const threadId = useAuiState((s) => s.threads.mainThreadId);

  // `requested` is the only dependency on purpose — see the matching comment
  // in Image2ModeSync for why `active` can't also be one (it would re-fight
  // useExitVideoGenerationMode's direct deactivate()).
  useEffect(() => {
    if (requested) {
      if (useImage2Mode.getState().active) useImage2Mode.getState().reset();
      if (!useVideoGenerationMode.getState().active) {
        activate();
        void adoptComposerImageAsVideoFrame(aui);
      }
      return;
    }
    if (useVideoGenerationMode.getState().active) deactivate();
  }, [activate, aui, deactivate, requested]);

  // The finished-video card is a per-thread record, not a global one — redo
  // this lookup for whichever thread is open now so a new or different
  // thread can't show another thread's result (independent of `requested`:
  // the card renders even after exiting the video composer, see
  // VideoGenerationJobTurn).
  useEffect(() => {
    restoreCurrentJob(session.workspace.id, threadId);
  }, [restoreCurrentJob, session.workspace.id, threadId]);

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

const MESSAGE_ROLE_LABEL: Record<string, string> = {
  user: "你",
  assistant: "助手",
  system: "系统",
};

function messageMarkdownBlock(message: {
  role: string;
  content: readonly { type: string; text?: string }[];
}): string | null {
  const text = message.content
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("\n\n")
    .trim();
  if (!text) return null;
  return `**${MESSAGE_ROLE_LABEL[message.role] ?? message.role}**\n\n${text}`;
}

function downloadTextFile(filename: string, content: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** 头部原「分享 · 即将上线」占位换成的会话操作菜单；真正的分享链接做完再进这里。 */
const SessionActionsMenu: FC = () => {
  const title = useAuiState(
    (s) => s.threads.threadItems.find((t) => t.id === s.threads.mainThreadId)?.title,
  );
  const messages = useAuiState((s) => s.thread.messages);

  const exportMarkdown = () => {
    const blocks = messages
      .map((message) => messageMarkdownBlock(message))
      .filter((block): block is string => block !== null);
    if (blocks.length === 0) return;
    const heading = title || "新会话";
    const markdown = `# ${heading}\n\n${blocks.join("\n\n---\n\n")}\n`;
    const safeName = heading.replace(/[\\/:*?"<>|]/g, "_").slice(0, 80);
    downloadTextFile(`${safeName}.md`, markdown, "text/markdown;charset=utf-8");
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <TooltipIconButton
          variant="ghost"
          size="icon"
          tooltip="更多"
          side="bottom"
          className="size-8 rounded-full data-[state=open]:bg-accent"
        >
          <MoreHorizontalIcon className="size-4" />
        </TooltipIconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-52 rounded-xl">
        <DropdownMenuItem onSelect={exportMarkdown} className="rounded-lg">
          <DownloadIcon className="size-4" />
          导出当前会话为 Markdown
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

const AssistantShell: FC = () => {
  const [styleId, setStyleId] = useState<ThreadStyleId>(loadThreadStyle);
  const [companion, setCompanion] = useState<CompanionId>(loadCompanion);
  const [themePref, setThemePref] = useState<ThemePref>(loadThemePref);
  const [densityPref, setDensityPref] = useState<DensityPref>(loadDensityPref);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] =
    useState<SettingsSection>("connections");
  const active = THREAD_STYLES.find((s) => s.id === styleId) ?? THREAD_STYLES[0];
  const ActiveThread = active.Component;
  const isWorking = useAuiState((s) => s.thread.isRunning);

  // 双后端健康轮询；未手动选过模式时跟随服务端默认。
  useAgentStatusPolling();
  // 任务中心角标：跨会话持续轮询，切换会话不丢正在跑的任务。
  useJobCenterPolling();
  const status = useAgentStatus((s) => s.status);
  const adoptServerDefault = useBackendChoice((s) => s.adoptServerDefault);
  useEffect(() => {
    if (!status) return;
    // 服务端默认值若不健康（网关未启动等），不采纳它——用户不该被静默丢进一个已知打不通的模式。
    const defaultHealthy =
      status.defaultBackend === "hermes" ? status.hermes.ok : status.direct.configured;
    adoptServerDefault(defaultHealthy ? status.defaultBackend : "direct");
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

  const handleDensityChange = (pref: DensityPref) => {
    setDensityPref(pref);
    saveDensityPref(pref);
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
            <ThemeToggle value={themePref} onChange={handleThemeChange} />
            <SessionActionsMenu />
          </div>
        </header>
        <main className="relative min-h-0 flex-1 overflow-hidden">
          <div
            key={styleId}
            className="fade-in animate-in h-full duration-200"
          >
            <ActiveThread />
          </div>
          <ThreadFindBar />
        </main>
      </SidebarInset>
      <CompanionLayer companion={companion} isWorking={isWorking} />
      <CommandPalette onOpenSettings={openSettings} />
      <DraftPersistence />
      <GlobalShortcuts />
      <JobCenterSheet />
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
        densityPref={densityPref}
        onDensityChange={handleDensityChange}
      />
    </SidebarProvider>
  );
};
