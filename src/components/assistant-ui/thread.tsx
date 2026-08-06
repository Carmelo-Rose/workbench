"use client";

import {
  ComposerAttachments,
  UserMessageAttachments,
} from "@/components/assistant-ui/attachment";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ComposerTriggerPopover } from "@/components/assistant-ui/composer-trigger-popover";
import { VideoMarkerText } from "@/components/workbench/toolbox/video-marker-text";
import { DotMatrix } from "@/components/assistant-ui/dot-matrix";
import { MarkdownText } from "@/components/assistant-ui/markdown-text";
import { MessageTiming } from "@/components/assistant-ui/message-timing";
import {
  BackendPicker,
  MessageBackendBadge,
} from "@/components/workbench/backend-select";
import { useBackendChoice } from "@/lib/agent-status";
import { translateChatError } from "@/lib/chat-error";
import { pickWelcomeCopy } from "@/lib/workbench/welcome-copy";
import {
  ComposerQuotePreview,
  QuoteBlock,
  SelectionToolbar,
} from "@/components/assistant-ui/quote";
import {
  Reasoning,
  ReasoningContent,
  ReasoningRoot,
  ReasoningText,
  ReasoningTrigger,
} from "@/components/assistant-ui/reasoning";
import { ToolFallback } from "@/components/assistant-ui/tool-fallback";
import {
  ToolGroupContent,
  ToolGroupRoot,
  ToolGroupTrigger,
} from "@/components/assistant-ui/tool-group";
import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button";
import { ThreadBackdrop } from "@/components/workbench/thread-backdrop";
import { SubjectLibrarySheet } from "@/components/workbench/SubjectLibrary";
import { AssetLibrarySheet } from "@/components/workbench/AssetLibrarySheet";
import {
  Image2ComposerContext,
  Image2ModeControl,
  Image2StructuredSlots,
  Image2TemplateRail,
  useExitImage2Mode,
  useImage2SendBlocked,
  useImage2StructuredTemplate,
} from "@/components/workbench/Image2ChatMode";
import {
  adoptComposerImageAsVideoFrame,
  submitVideoGeneration,
  useCurrentVideoJobId,
  VideoGenerationJobTurn,
  VideoGenerationModeControl,
  VideoGenerationNotice,
  VideoGenerationSendButton,
  VideoGenerationSlots,
} from "@/components/workbench/VideoGenerationMode";
import { emitSendBurst } from "@/components/workbench/send-burst";
import { useTilt } from "@/components/workbench/use-tilt";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ScrollFadeRow } from "@/components/assistant-ui/scroll-edge-fade";
import { cn } from "@/lib/utils";
import { useImage2Mode } from "@/lib/image2-mode";
import { useAssetLibrary } from "@/lib/mono/asset-library";
import { useVideoGenerationMode } from "@/lib/video-generation-mode";
import {
  ActionBarMorePrimitive,
  ActionBarPrimitive,
  AuiIf,
  type AssistantState,
  BranchPickerPrimitive,
  ComposerPrimitive,
  ErrorPrimitive,
  groupPartByType,
  MessagePrimitive,
  ThreadPrimitive,
  type ToolCallMessagePartComponent,
  unstable_defaultDirectiveFormatter,
  unstable_useMentionAdapter,
  useAui,
  useAuiState,
  type Unstable_TriggerItem,
} from "@assistant-ui/react";
import {
  LexicalComposerInput,
  type DirectiveChipProps,
} from "@assistant-ui/react-lexical";
import {
  ActivityIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  BotIcon,
  ChartColumnIcon,
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CopyIcon,
  DownloadIcon,
  EraserIcon,
  FilmIcon,
  ImageIcon,
  ImagesIcon,
  ScissorsIcon,
  SearchIcon,
  SparklesIcon,
  LightbulbIcon,
  MicIcon,
  MoreHorizontalIcon,
  PaperclipIcon,
  PencilIcon,
  PencilLineIcon,
  PlusIcon,
  RefreshCwIcon,
  SlashIcon,
  SquareIcon,
  TrendingUpIcon,
  UploadIcon,
  VideoIcon,
  Wand2Icon,
  WrenchIcon,
  UsersIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useCapabilityActions } from "@/components/workbench/CapabilityActions";
import {
  allowedCapabilityGroups,
  type CapabilityOption,
} from "@/lib/workbench/capabilities";
import { useWorkbenchSession } from "@/components/workbench/auth-gate";
import { useSlashCapabilityAdapter } from "@/components/assistant-ui/slash-capability-adapter";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type FC,
  type PropsWithChildren,
  type ReactNode,
} from "react";
import { useMonoSubjectCatalog } from "@/lib/mono/subject-client";

export type ThreadGroupPart = MessagePrimitive.GroupedParts.GroupPart;

/**
 * Optional component overrides for the thread. `AssistantMessage` and
 * `Welcome` replace whole sections; the remaining slots override how the
 * assistant message renders tool calls and part groups. Tool UIs registered
 * by name (toolkit `render`, `useAssistantDataUI`) take precedence over
 * `ToolFallback`.
 */
export type ThreadComponents = {
  AssistantMessage?: ComponentType | undefined;
  Welcome?: ComponentType | undefined;
  ToolFallback?: ToolCallMessagePartComponent | undefined;
  ToolGroup?:
    | ComponentType<PropsWithChildren<{ group: ThreadGroupPart }>>
    | undefined;
  ReasoningGroup?:
    | ComponentType<PropsWithChildren<{ group: ThreadGroupPart }>>
    | undefined;
};

export type ThreadProps = {
  components?: ThreadComponents | undefined;
};

const EMPTY_COMPONENTS: ThreadComponents = {};

const ThreadComponentsContext =
  createContext<ThreadComponents>(EMPTY_COMPONENTS);

// Startup exposes a loading placeholder thread; treat it as a new chat so
// the composer mounts centered. Loads after startup keep the docked layout.
const isNewChatView = (s: AssistantState) =>
  s.thread.messages.length === 0 &&
  (!s.thread.isLoading || s.threads.isLoading);

export const Thread: FC<ThreadProps> = ({ components = EMPTY_COMPONENTS }) => {
  const isEmpty = useAuiState(isNewChatView);

  return (
    <ThreadComponentsContext.Provider value={components}>
      <ThreadRoot isEmpty={isEmpty} />
    </ThreadComponentsContext.Provider>
  );
};

const ThreadRoot: FC<{ isEmpty: boolean }> = ({ isEmpty }) => {
  const { Welcome = ThreadWelcome } = useContext(ThreadComponentsContext);
  const videoGenerationActive = useVideoGenerationMode((state) => state.active);
  const hasVideoTurn = Boolean(useCurrentVideoJobId());

  return (
    // --thread-max-width / --composer-* 以前是内联 style；内联样式盖不过皮肤
    // 选择器，所以默认值搬去了 globals.css 的 .aui-thread-root。
    <ThreadPrimitive.Root
      className="aui-root aui-thread-root bg-background @container relative flex h-full flex-col"
    >
      <ThreadBackdrop active={isEmpty && !hasVideoTurn} />
      <ThreadPrimitive.Viewport
        turnAnchor="top"
        data-slot="aui_thread-viewport"
        className={cn(
          "relative flex flex-1 flex-col overflow-x-auto overflow-y-scroll px-4 pt-4",
          isEmpty && !hasVideoTurn && "justify-center",
        )}
      >
        {isEmpty && !hasVideoTurn ? <Welcome /> : null}

        <div
          data-slot="aui_message-group"
          className="mb-14 flex flex-col gap-y-6 empty:hidden"
        >
          <ThreadPrimitive.Messages>
            {() => <ThreadMessage />}
          </ThreadPrimitive.Messages>
          <VideoGenerationJobTurn />
        </div>

        <ThreadPrimitive.ViewportFooter
          data-thread-find-skip
          className={cn(
            "aui-thread-viewport-footer mx-auto flex w-full max-w-(--thread-max-width) flex-col gap-4 overflow-visible pb-4 md:pb-6",
            (!isEmpty || hasVideoTurn) &&
              "bg-background sticky bottom-0 mt-auto rounded-t-(--composer-radius)",
          )}
        >
          <ThreadScrollToBottom />
          <Composer />
          {isEmpty && !videoGenerationActive && !hasVideoTurn ? (
            // 能力入口曾经在 composer.isEmpty 时才渲染——用户刚打第一个字就
            // 整块消失，恰好是最该发现工具的时刻。与 image2Active 分支保持一致，
            // 只要还在欢迎屏（isEmpty）就一直可达。
            <div className="aui-thread-welcome-suggestions-shell min-h-19">
              <ThreadSuggestions />
            </div>
          ) : null}
        </ThreadPrimitive.ViewportFooter>
      </ThreadPrimitive.Viewport>

      <SelectionToolbar />
    </ThreadPrimitive.Root>
  );
};

const ThreadMessage: FC = () => {
  const { AssistantMessage: AssistantMessageComponent = AssistantMessage } =
    useContext(ThreadComponentsContext);
  const role = useAuiState((s) => s.message.role);
  const isEditing = useAuiState((s) => s.message.composer.isEditing);

  if (isEditing) return <EditComposer />;
  if (role === "user") return <UserMessage />;
  return <AssistantMessageComponent />;
};

const ThreadScrollToBottom: FC = () => {
  return (
    <ThreadPrimitive.ScrollToBottom asChild>
      <TooltipIconButton
        tooltip="滚动到底部"
        variant="outline"
        className="aui-thread-scroll-to-bottom dark:border-border dark:bg-background dark:hover:bg-accent absolute -top-12 z-10 self-center rounded-full p-4 disabled:invisible"
      >
        <ArrowDownIcon />
      </TooltipIconButton>
    </ThreadPrimitive.ScrollToBottom>
  );
};

const ThreadWelcome: FC = () => {
  const [greeting] = useState(pickWelcomeCopy);
  return (
    // The greeting sits only 24px above the composer, so an upward trigger
    // popover would always cover it; this marks it as an obstacle the popover
    // must stay clear of (see composer-trigger-popover).
    <div
      data-composer-popover-avoid
      className="aui-thread-welcome-root mx-auto mb-6 flex w-full max-w-(--thread-max-width) flex-col items-center px-4 text-center"
    >
      <h1 className="aui-thread-welcome-message-inner fade-in slide-in-from-bottom-1 animate-in fill-mode-both text-2xl font-semibold duration-200">
        {greeting}
      </h1>
    </div>
  );
};

// 图标键 → lucide 组件：欢迎页分组 chip、`/` 命令与 ⌘K 面板共用（数据在 capabilities.ts）。
export const capabilityIconMap: Record<string, FC<{ className?: string }>> = {
  sparkles: SparklesIcon,
  chart: ChartColumnIcon,
  bot: BotIcon,
  "pencil-line": PencilLineIcon,
  lightbulb: LightbulbIcon,
  image: ImageIcon,
  video: VideoIcon,
  film: FilmIcon,
  eraser: EraserIcon,
  wand: Wand2Icon,
  scissors: ScissorsIcon,
  activity: ActivityIcon,
  "trending-up": TrendingUpIcon,
  search: SearchIcon,
  upload: UploadIcon,
};

const CapabilityIcon: FC<{ iconKey?: string; className?: string }> = ({
  iconKey,
  className,
}) => {
  const Icon = iconKey ? capabilityIconMap[iconKey] : undefined;
  return Icon ? <Icon className={className} /> : null;
};

const suggestionChipClass =
  "aui-thread-welcome-suggestion text-foreground hover:bg-muted bg-background/60 border-border/60 h-auto gap-1.5 rounded-full border px-3.5 py-1.5 text-sm font-normal whitespace-nowrap backdrop-blur-[2px] transition-colors [&_svg]:size-4";

/**
 * 留口子的能力收进一个尾部信息 chip：路线图依然可见（点开 Popover 才展开
 * 具体条目），但常驻界面上只占一个位置，而不是每条都摆一个灰掉的死 chip。
 */
const ComingSoonChip: FC<{ options: CapabilityOption[] }> = ({ options }) => {
  if (options.length === 0) return null;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          className={cn(
            suggestionChipClass,
            "text-muted-foreground border-dashed",
          )}
        >
          即将上线 · {options.length}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56 p-1.5">
        <ul className="flex flex-col">
          {options.map((option) => (
            <li
              key={option.id}
              className="text-muted-foreground flex items-center justify-between rounded-lg px-2 py-1.5 text-sm"
            >
              {option.label}
              {option.badge && (
                <span className="border-border/60 rounded-full border px-1.5 py-px text-[10px] leading-none">
                  {option.badge}
                </span>
              )}
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
};

const ThreadSuggestions: FC = () => {
  const { run } = useCapabilityActions();
  const { canGrant } = useWorkbenchSession();
  const capabilityGroups = useMemo(() => allowedCapabilityGroups(canGrant), [canGrant]);
  const image2Active = useImage2Mode((state) => state.active);
  const tilt = useTilt();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const expandedGroup = capabilityGroups.find(
    (group) => group.id === expandedId,
  );

  if (image2Active) return <Image2TemplateRail />;

  return (
    <div className="aui-thread-welcome-suggestions flex w-full flex-col gap-2 px-4">
      <ScrollFadeRow className="w-full">
        <div className="mx-auto flex w-max items-center gap-2">
          {capabilityGroups.map((group) => (
            <Button
              key={group.id}
              variant="ghost"
              {...tilt}
              className={cn(
                suggestionChipClass,
                group.id === expandedId && "bg-muted",
              )}
              onClick={() =>
                setExpandedId(group.id === expandedId ? null : group.id)
              }
            >
              <CapabilityIcon iconKey={group.iconKey} />
              {group.label}
            </Button>
          ))}
        </div>
      </ScrollFadeRow>
      {expandedGroup && (
        <ScrollFadeRow
          key={expandedGroup.id}
          className="fade-in slide-in-from-top-1 animate-in w-full duration-200"
        >
          <div className="mx-auto flex w-max items-center gap-2">
            {expandedGroup.options
              .filter((option) => !option.disabled)
              .map((option) => {
                // slash 能力真的会调用工具（花钱、写文件、切模式）；没有 slash
                // 的分组（Agent 能力/创作/分析/头脑风暴）只是把示例提示词填进
                // 输入框，交给模型自己判断——同一种 chip 外观会让用户误以为
                // 两者点了都一样，所以给真工具配图标 + hover 提示，示例提示词
                // 加「示例」标记 + 虚线边框区分。
                const chip = (
                  <Button
                    key={option.id}
                    variant="ghost"
                    {...tilt}
                    className={cn(
                      suggestionChipClass,
                      !option.slash && "border-dashed text-muted-foreground",
                    )}
                    onClick={() => run({ action: option.action, prompt: option.prompt, permission: option.permission })}
                  >
                    {option.slash ? <CapabilityIcon iconKey={option.iconKey} /> : null}
                    {option.label}
                    {!option.slash ? (
                      <span className="text-muted-foreground/70 text-[10px] font-normal">
                        示例
                      </span>
                    ) : null}
                  </Button>
                );
                if (!option.hint) return chip;
                return (
                  <Tooltip key={option.id}>
                    <TooltipTrigger asChild>{chip}</TooltipTrigger>
                    <TooltipContent side="bottom">{option.hint}</TooltipContent>
                  </Tooltip>
                );
              })}
            <ComingSoonChip options={expandedGroup.options.filter((o) => o.disabled)} />
          </div>
        </ScrollFadeRow>
      )}
    </div>
  );
};

// 模式切换器：直连 / Hermes Agent，选择随每条请求发送到 /api/chat。
const ModelPicker: FC = () => <BackendPicker />;

function DirectiveChip(props: DirectiveChipProps) {
  const { directiveId, directiveType, label } = props;
  const subject = useMonoSubjectCatalog((state) => state.subjects.find((item) => item.id === directiveId));
  // "创建主体/管理主体库" is an action, not a real reference — it's handled by
  // ComposerTriggerPopover's onActionItem (click) / onDirectiveSelect
  // (keyboard Enter/Tab safety net, see Composer). Render nothing so a stray
  // Enter/Tab selection doesn't leave a dead-looking chip behind.
  if (directiveType === "subject-action") return null;
  const showWrench = directiveType !== "command";
  return (
    <span
      className="aui-directive-chip"
      data-directive-type={directiveType}
      data-directive-id={directiveId}
    >
      {directiveType === "subject" && subject ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={subject.previewUrl} alt="" className="size-4 rounded-sm object-cover" />
      ) : directiveType === "ref" ? (
        <span className="aui-directive-chip-icon">
          <ImageIcon className="size-3" />
        </span>
      ) : showWrench && (
        <span className="aui-directive-chip-icon">
          <WrenchIcon className="size-3" />
        </span>
      )}
      <span className="aui-directive-chip-label">{label}</span>
    </span>
  );
}

const Composer: FC = () => {
  const aui = useAui();
  const threadId = useAuiState((state) => state.threads.mainThreadId);
  const openSubjectLibrary = useImage2Mode((state) => state.openSubjectLibrary);
  const videoGenerationActive = useVideoGenerationMode((state) => state.active);
  const subjects = useMonoSubjectCatalog((state) => state.subjects);
  const loadSubjects = useMonoSubjectCatalog((state) => state.load);
  const structuredTemplate = useImage2StructuredTemplate();
  const { run: runCapability } = useCapabilityActions();
  const { canGrant } = useWorkbenchSession();
  // 主体是全模式通用的「引用」，不再只在生图模式加载，让非生图下 @ 也非空。
  useEffect(() => {
    if (canGrant("resources.subjects.view")) void loadSubjects();
  }, [canGrant, loadSubjects]);
  // 当前已上传的图片附件也进 @ 候选（对齐 Mono 插件的「参考图N」虚拟候选）。
  // 编号即附件顺序，与服务端编译提示词时 referenceImageUrls 的编号一致，
  // 所以 chip 只需序列化成纯文本「参考图N」，无需升格为主体。
  const composerAttachments = useAuiState((state) => state.composer.attachments);
  const imageAttachments = useMemo(
    () => composerAttachments.filter((attachment) => attachment.type === "image"),
    [composerAttachments],
  );
  const [attachmentPreviews, setAttachmentPreviews] = useState<Record<string, string>>({});
  useEffect(() => {
    const previews: Record<string, string> = {};
    for (const attachment of imageAttachments) {
      if (attachment.file) previews[attachment.id] = URL.createObjectURL(attachment.file);
    }
    setAttachmentPreviews(previews);
    return () => Object.values(previews).forEach((url) => URL.revokeObjectURL(url));
  }, [imageAttachments]);
  // Flat list, not a category: mirrors the reference Mono plugin's "@"
  // picker, which shows subjects (+ a pinned create/manage action)
  // immediately — no drill-down step. `@` = 引用，全模式常驻（生图、非生图
  // 都可插主体/参考图）；仅结构化模板用槽位 UI 时让位，不弹 @ 列表。
  const mentionItems = useMemo(() => canGrant("resources.subjects.view") && !structuredTemplate && !videoGenerationActive ? [
    ...subjects.map((subject) => ({
      id: subject.id,
      type: "subject",
      label: subject.name,
      description: subject.visibility === "workspace" ? "工作区主体" : "我的主体",
      icon: "subject",
      metadata: { previewUrl: subject.previewUrl },
    })),
    ...imageAttachments.map((attachment, index) => ({
      id: `ref:${attachment.id}`,
      type: "ref",
      label: `参考图${index + 1}`,
      description: "本次上传的参考图",
      icon: "subject",
      metadata: { previewUrl: attachmentPreviews[attachment.id] },
    })),
    {
      id: "__subject_library",
      type: "subject-action",
      label: subjects.length ? "管理主体库" : "创建主体",
      description: "上传图片或从生成历史创建",
      icon: "subject-library",
      metadata: { actionOnly: true },
    },
  ] : undefined, [canGrant, structuredTemplate, videoGenerationActive, subjects, imageAttachments, attachmentPreviews]);
  const mention = unstable_useMentionAdapter({
    items: mentionItems,
    includeModelContextTools: true,
    fallbackIcon: WrenchIcon,
    iconMap: { subject: UsersIcon, "subject-library": UsersIcon },
    formatter: {
      // Defense in depth: keyboard Enter/Tab still goes through the normal
      // directive-insertion path (see onDirectiveSelect below), so this
      // keeps the action item's chip contributing no text even there.
      // 「参考图N」chip 序列化为纯文本，服务端编译按附件顺序对号入座。
      serialize: (item) => item.type === "subject-action" ? ""
        : item.type === "ref" ? item.label
        : unstable_defaultDirectiveFormatter.serialize(item),
      parse: unstable_defaultDirectiveFormatter.parse,
    },
  });
  const openSubjectLibraryFromDirective = (item: Unstable_TriggerItem) => {
    if (item.type === "subject-action") openSubjectLibrary();
  };
  // `/` = 功能命令：两级菜单（先分组、再命令，敲字则跨组搜索），数据取能力注册表里
  // 标记 slash 的真能力，选中后复用与欢迎 chip 同一套 run（填提示词 / 拉起选择器 /
  // 开视频卡 / 切生图模式）。removeOnExecute 剥掉用户敲的 /xxx；fill 型用 setText
  // 整体替换文本，本就不会残留。
  const runSlashCapability = (option: CapabilityOption) =>
    runCapability({ action: option.action, prompt: option.prompt, permission: option.permission });
  const slash = useSlashCapabilityAdapter({
    run: runSlashCapability,
    iconMap: capabilityIconMap,
    fallbackIcon: SlashIcon,
  });

  return (
    <ComposerPrimitive.Unstable_TriggerPopoverRoot>
      <ComposerPrimitive.Root className="aui-composer-root relative flex w-full flex-col">
        <ComposerPrimitive.AttachmentDropzone asChild>
          <div
            data-slot="aui_composer-shell"
            className="border-border/60 data-[dragging=true]:border-ring focus-within:border-border dark:border-muted-foreground/15 dark:focus-within:border-muted-foreground/30 flex w-full flex-col gap-2 rounded-(--composer-radius) border bg-(--composer-bg) p-(--composer-padding) shadow-[0_4px_16px_-8px_rgba(0,0,0,0.08),0_1px_2px_rgba(0,0,0,0.04)] transition-[border-color,box-shadow] focus-within:shadow-[0_6px_24px_-8px_rgba(0,0,0,0.12),0_1px_2px_rgba(0,0,0,0.05)] data-[dragging=true]:border-dashed data-[dragging=true]:bg-[color-mix(in_oklab,var(--color-accent)_50%,var(--color-background))] dark:shadow-none"
          >
            <ComposerQuotePreview />
            <Image2ComposerContext />
            <VideoGenerationNotice />
            {videoGenerationActive ? (
              <VideoGenerationSlots />
            ) : structuredTemplate ? (
              <Image2StructuredSlots />
            ) : (
              <ComposerAttachments />
            )}
            <LexicalComposerInput
              submitMode={videoGenerationActive ? "none" : "enter"}
              onKeyDownCapture={(event) => {
                if (
                  !videoGenerationActive ||
                  event.key !== "Enter" ||
                  event.shiftKey ||
                  event.ctrlKey ||
                  event.metaKey ||
                  event.nativeEvent.isComposing
                ) return;
                event.preventDefault();
                event.stopPropagation();
                void submitVideoGeneration(aui, threadId);
              }}
              directiveChip={DirectiveChip}
              directivePluginProps={{ onDirectiveSelect: openSubjectLibraryFromDirective }}
              placeholder={videoGenerationActive
                ? "描述画面、动作和镜头语言（图生视频可留空）"
                : "发送消息…（@ 提及，/ 使用命令）"}
              className="aui-composer-input [&_.aui-lexical-placeholder]:text-muted-foreground/80 relative max-h-32 min-h-10 w-full resize-none bg-transparent px-2.5 py-1 text-base outline-none [&_.aui-directive-chip]:inline-flex [&_.aui-directive-chip]:items-baseline [&_.aui-directive-chip]:gap-1 [&_.aui-directive-chip]:rounded-md [&_.aui-directive-chip]:bg-blue-100 [&_.aui-directive-chip]:px-1.5 [&_.aui-directive-chip]:py-0.5 [&_.aui-directive-chip]:text-[13px] [&_.aui-directive-chip]:leading-none [&_.aui-directive-chip]:font-medium [&_.aui-directive-chip]:text-blue-700 dark:[&_.aui-directive-chip]:bg-blue-900/50 dark:[&_.aui-directive-chip]:text-blue-300 [&_.aui-directive-chip-icon]:self-center [&_.aui-lexical-input]:min-h-lh [&_.aui-lexical-input]:outline-none [&_.aui-lexical-placeholder]:pointer-events-none [&_.aui-lexical-placeholder]:absolute [&_.aui-lexical-placeholder]:top-0 [&_.aui-lexical-placeholder]:right-0 [&_.aui-lexical-placeholder]:left-0 [&_.aui-lexical-placeholder]:truncate [&_.aui-lexical-placeholder]:px-2.5 [&_.aui-lexical-placeholder]:py-1"
            />
            <ComposerAction />
          </div>
        </ComposerPrimitive.AttachmentDropzone>

        {canGrant("resources.subjects.view") && <ComposerTriggerPopover char="@" {...mention} onActionItem={openSubjectLibraryFromDirective} />}

        {videoGenerationActive ? null : (
          <ComposerTriggerPopover
            char="/"
            {...slash}
            categoryItems={slash.adapter.categoryItems}
            emptyItemsLabel="没有匹配的命令"
          />
        )}
        {canGrant("resources.subjects.view") && <SubjectLibrarySheet />}
        {canGrant("resources.assets.view") && <AssetLibrarySheet />}
      </ComposerPrimitive.Root>
    </ComposerPrimitive.Unstable_TriggerPopoverRoot>
  );
};

/**
 * Composer 左下角的 + 菜单：聚合上传附件、创建图片等入口，
 * 后续新能力（视频分析、素材库等）继续往这里挂。
 */
const ComposerPlusMenu: FC = () => {
  const aui = useAui();
  const router = useRouter();
  const image2Active = useImage2Mode((state) => state.active);
  const activateImage2 = useImage2Mode((state) => state.activate);
  const exitImage2Mode = useExitImage2Mode();
  const openSubjectLibrary = useImage2Mode((state) => state.openSubjectLibrary);
  const openAssetLibrary = useAssetLibrary((state) => state.openLibrary);
  const videoGenerationActive = useVideoGenerationMode((state) => state.active);
  const activateVideoGeneration = useVideoGenerationMode((state) => state.activate);
  const resetVideoGeneration = useVideoGenerationMode((state) => state.reset);
  const { canGrant } = useWorkbenchSession();

  const enterVideoGeneration = () => {
    void (async () => {
      if (image2Active) await exitImage2Mode();
      await adoptComposerImageAsVideoFrame(aui);
      activateVideoGeneration();
      router.push("/?mode=video");
    })();
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <TooltipIconButton
          tooltip="添加内容与工具"
          side="bottom"
          type="button"
          variant="ghost"
          size="icon"
          className="aui-composer-plus hover:bg-muted-foreground/15 dark:hover:bg-muted-foreground/30 size-7 rounded-full p-1"
          aria-label="添加内容与工具"
        >
          <PlusIcon className="size-4.5 stroke-[1.5px]" />
        </TooltipIconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="min-w-44">
        <ComposerPrimitive.AddAttachment asChild>
          <DropdownMenuItem>
            <PaperclipIcon />
            上传图片或文件
          </DropdownMenuItem>
        </ComposerPrimitive.AddAttachment>
        {canGrant("image.generate.use") && <DropdownMenuItem
          disabled={image2Active}
          onSelect={() => {
            if (videoGenerationActive) resetVideoGeneration();
            activateImage2();
            router.push("/?mode=image2");
          }}
        >
          <SparklesIcon />
          生成图片
          {image2Active ? <CheckIcon className="ml-auto" /> : null}
        </DropdownMenuItem>}
        {canGrant("video.generate.use") && <DropdownMenuItem
          disabled={videoGenerationActive}
          onSelect={enterVideoGeneration}
        >
          <FilmIcon />
          生成视频
          {videoGenerationActive ? <CheckIcon className="ml-auto" /> : null}
        </DropdownMenuItem>}
        {canGrant("resources.subjects.view") && <DropdownMenuItem onSelect={() => openSubjectLibrary()}>
          <UsersIcon />
          主体库
        </DropdownMenuItem>}
        {canGrant("resources.assets.view") && <DropdownMenuItem onSelect={() => openAssetLibrary()}>
          <ImagesIcon />
          作品库
        </DropdownMenuItem>}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

const ComposerCancelAction: FC = () => (
  <ComposerPrimitive.Cancel asChild>
    <Button
      type="button"
      variant="default"
      size="icon"
      className="aui-composer-cancel size-7 rounded-full"
      aria-label="停止生成"
    >
      <SquareIcon className="aui-composer-cancel-icon size-3.5 fill-current" />
    </Button>
  </ComposerPrimitive.Cancel>
);

const ComposerAction: FC = () => {
  const image2Active = useImage2Mode((state) => state.active);
  const videoGenerationActive = useVideoGenerationMode((state) => state.active);
  const image2SendBlocked = useImage2SendBlocked();
  return (
    <div className="aui-composer-action-wrapper relative flex items-center justify-between">
      <div className="flex items-center gap-1">
        <ComposerPlusMenu />
        {videoGenerationActive ? (
          <VideoGenerationModeControl />
        ) : (
          <>
            <ModelPicker />
            {image2Active ? <Image2ModeControl /> : null}
          </>
        )}
      </div>
      <div className="flex items-center gap-1.5">
        <AuiIf condition={(s) => s.thread.capabilities.dictation}>
          <AuiIf condition={(s) => s.composer.dictation == null}>
            <ComposerPrimitive.Dictate asChild>
              <TooltipIconButton
                tooltip="语音输入"
                side="bottom"
                type="button"
                variant="ghost"
                size="icon"
                className="aui-composer-dictate size-7 rounded-full"
                aria-label="开始语音输入"
              >
                <MicIcon className="aui-composer-dictate-icon size-4" />
              </TooltipIconButton>
            </ComposerPrimitive.Dictate>
          </AuiIf>
          <AuiIf condition={(s) => s.composer.dictation != null}>
            <ComposerPrimitive.StopDictation asChild>
              <TooltipIconButton
                tooltip="停止听写"
                side="bottom"
                type="button"
                variant="ghost"
                size="icon"
                className="aui-composer-stop-dictation text-destructive size-7 rounded-full"
                aria-label="停止语音输入"
              >
                <SquareIcon className="aui-composer-stop-dictation-icon size-3.5 animate-pulse fill-current" />
              </TooltipIconButton>
            </ComposerPrimitive.StopDictation>
          </AuiIf>
        </AuiIf>
        {videoGenerationActive ? (
          <>
            <AuiIf condition={(s) => !s.thread.isRunning}>
              <VideoGenerationSendButton />
            </AuiIf>
            <AuiIf condition={(s) => s.thread.isRunning}>
              <ComposerCancelAction />
            </AuiIf>
          </>
        ) : (
          <>
            <AuiIf condition={(s) => !s.thread.isRunning}>
              <ComposerPrimitive.Send asChild>
                <TooltipIconButton
                  tooltip="发送消息"
                  side="bottom"
                  type="button"
                  variant="default"
                  size="icon"
                  className="aui-composer-send size-7 rounded-full"
                  aria-label="发送消息"
                  disabled={image2SendBlocked}
                  onClick={(e) => emitSendBurst(e.currentTarget)}
                >
                  <ArrowUpIcon className="aui-composer-send-icon size-4.5" />
                </TooltipIconButton>
              </ComposerPrimitive.Send>
            </AuiIf>
            <AuiIf condition={(s) => s.thread.isRunning}>
              <ComposerCancelAction />
            </AuiIf>
          </>
        )}
      </div>
    </div>
  );
};

const MessageError: FC = () => {
  const rawError = useAuiState((s) =>
    s.message.status?.type === "incomplete" && s.message.status.reason === "error"
      ? (s.message.status.error ?? "发生未知错误")
      : undefined,
  );
  const aui = useAui();
  const backend = useBackendChoice((s) => s.backend);
  const setBackend = useBackendChoice((s) => s.setBackend);
  const [expanded, setExpanded] = useState(false);

  if (rawError === undefined) return null;
  const { title, detail } = translateChatError(rawError);

  return (
    <MessagePrimitive.Error>
      <ErrorPrimitive.Root className="aui-message-error-root border-destructive bg-destructive/10 text-destructive dark:bg-destructive/5 mt-2 space-y-2 rounded-md border p-3 text-sm dark:text-red-200">
        <div className="aui-message-error-message wrap-break-word">{title}</div>
        {detail !== title && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="text-xs underline opacity-70 hover:opacity-100"
          >
            {expanded ? "收起详情" : "查看详情"}
          </button>
        )}
        {expanded && (
          <div className="wrap-break-word text-xs opacity-70">{detail}</div>
        )}
        <div className="flex gap-2 pt-1">
          {backend === "hermes" && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 rounded-full text-xs"
              onClick={() => {
                setBackend("direct");
                aui.message().reload();
              }}
            >
              切换到直连并重试
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 rounded-full text-xs"
            onClick={() => aui.message().reload()}
          >
            重试
          </Button>
        </div>
      </ErrorPrimitive.Root>
    </MessagePrimitive.Error>
  );
};

const AssistantWorkingIndicator: FC = () => {
  const isEmpty = useAuiState((s) => s.message.content.length === 0);
  if (isEmpty) {
    return (
      <span
        data-slot="aui_assistant-message-indicator"
        className="text-muted-foreground inline-flex items-center gap-2 align-middle"
      >
        <DotMatrix state="connecting" aria-hidden />
        <span className="text-sm">连接中</span>
      </span>
    );
  }
  return (
    <span
      data-slot="aui_assistant-message-indicator"
      className="animate-pulse font-sans"
      aria-label="助手正在处理"
    >
      {"●"}
    </span>
  );
};

const AssistantMessage: FC = () => {
  const {
    ToolFallback: ToolFallbackComponent = ToolFallback,
    ToolGroup,
    ReasoningGroup,
  } = useContext(ThreadComponentsContext);

  // reserves space for action bar and compensates with `-mb` for consistent msg spacing
  // keeps hovered action bar from shifting layout (autohide doesn't support absolute positioning well)
  // for pt-[n] use -mb-[n + 6] & min-h-[n + 6] to preserve compensation
  const ACTION_BAR_PT = "pt-1.5";
  const ACTION_BAR_HEIGHT = `-mb-7.5 min-h-7.5 ${ACTION_BAR_PT}`;

  return (
    <MessagePrimitive.Root
      data-slot="aui_assistant-message-root"
      data-role="assistant"
      className="fade-in slide-in-from-bottom-1 animate-in relative mx-auto w-full max-w-(--thread-max-width) duration-150"
    >
      <div
        data-slot="aui_assistant-message-content"
        // [contain-intrinsic-size:auto_24px] fixes issue #4104, don't change without checking for regressions
        className="text-foreground px-2 leading-relaxed wrap-break-word [contain-intrinsic-size:auto_24px] [content-visibility:auto]"
      >
        <MessagePrimitive.GroupedParts
          groupBy={groupPartByType({
            reasoning: ["group-chainOfThought", "group-reasoning"],
            "tool-call": ["group-chainOfThought", "group-tool"],
            "standalone-tool-call": [],
          })}
        >
          {({ part, children }) => {
            switch (part.type) {
              case "group-chainOfThought":
                return <div data-slot="aui_chain-of-thought">{children}</div>;
              case "group-tool":
                if (ToolGroup) {
                  return <ToolGroup group={part}>{children}</ToolGroup>;
                }
                return (
                  <ToolGroupRoot variant="ghost">
                    <ToolGroupTrigger
                      count={part.indices.length}
                      active={part.status.type === "running"}
                    />
                    <ToolGroupContent>{children}</ToolGroupContent>
                  </ToolGroupRoot>
                );
              case "group-reasoning": {
                if (ReasoningGroup) {
                  return (
                    <ReasoningGroup group={part}>{children}</ReasoningGroup>
                  );
                }
                const running = part.status.type === "running";
                return (
                  <ReasoningRoot streaming={running}>
                    <ReasoningTrigger active={running} />
                    <ReasoningContent aria-busy={running}>
                      <ReasoningText>{children}</ReasoningText>
                    </ReasoningContent>
                  </ReasoningRoot>
                );
              }
              case "text":
                return <MarkdownText />;
              case "reasoning":
                return <Reasoning {...part} />;
              case "tool-call":
                return part.toolUI ?? <ToolFallbackComponent {...part} />;
              case "data":
                return part.dataRendererUI;
              case "indicator":
                return <AssistantWorkingIndicator />;
              default:
                return null;
            }
          }}
        </MessagePrimitive.GroupedParts>
        <MessageError />
      </div>

      <div
        data-slot="aui_assistant-message-footer"
        className={cn("ms-2 flex items-center", ACTION_BAR_HEIGHT)}
      >
        <BranchPicker />
        <AssistantActionBar />
      </div>
    </MessagePrimitive.Root>
  );
};

const AssistantActionBar: FC = () => {
  return (
    <ActionBarPrimitive.Root
      hideWhenRunning
      autohide="not-last"
      className="aui-assistant-action-bar-root text-muted-foreground animate-in fade-in col-start-3 row-start-2 -ms-1 flex gap-1 duration-200"
    >
      <ActionBarPrimitive.Copy asChild>
        <TooltipIconButton tooltip="复制">
          <AuiIf condition={(s) => s.message.isCopied}>
            <CheckIcon className="animate-in zoom-in-50 fade-in duration-200 ease-out" />
          </AuiIf>
          <AuiIf condition={(s) => !s.message.isCopied}>
            <CopyIcon className="animate-in zoom-in-75 fade-in duration-150" />
          </AuiIf>
        </TooltipIconButton>
      </ActionBarPrimitive.Copy>
      <ActionBarPrimitive.Reload asChild>
        <TooltipIconButton tooltip="重试">
          <RefreshCwIcon />
        </TooltipIconButton>
      </ActionBarPrimitive.Reload>
      <ActionBarMorePrimitive.Root>
        <ActionBarMorePrimitive.Trigger asChild>
          <TooltipIconButton
            tooltip="更多"
            className="data-[state=open]:bg-accent"
          >
            <MoreHorizontalIcon />
          </TooltipIconButton>
        </ActionBarMorePrimitive.Trigger>
        <ActionBarMorePrimitive.Content
          side="bottom"
          align="start"
          sideOffset={6}
          className="aui-action-bar-more-content bg-popover/95 text-popover-foreground data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=closed]:animate-out data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 min-w-[8rem] overflow-hidden rounded-xl border p-1.5 shadow-lg backdrop-blur-sm"
        >
          <ActionBarPrimitive.ExportMarkdown asChild>
            <ActionBarMorePrimitive.Item className="aui-action-bar-more-item hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none select-none">
              <DownloadIcon className="size-4" />
              导出为 Markdown
            </ActionBarMorePrimitive.Item>
          </ActionBarPrimitive.ExportMarkdown>
        </ActionBarMorePrimitive.Content>
      </ActionBarMorePrimitive.Root>
      <MessageTiming />
      <MessageBackendBadge />
    </ActionBarPrimitive.Root>
  );
};

const UserMessage: FC = () => {
  return (
    <MessagePrimitive.Root
      data-slot="aui_user-message-root"
      data-role="user"
      className="fade-in slide-in-from-bottom-1 animate-in mx-auto grid w-full max-w-(--thread-max-width) auto-rows-auto grid-cols-[minmax(72px,1fr)_auto] content-start gap-y-2 px-2 duration-150 [contain-intrinsic-size:auto_60px] [content-visibility:auto] [&:where(>*)]:col-start-2"
    >
      <UserMessageAttachments />

      <div className="aui-user-message-content-wrapper relative col-start-2 min-w-0">
        <div className="aui-user-message-content peer bg-muted text-foreground rounded-xl px-4 py-2 wrap-break-word empty:hidden">
          <MessagePrimitive.Quote>
            {(quote) => <QuoteBlock {...quote} />}
          </MessagePrimitive.Quote>
          {/* VideoMarkerText 只多做一件事：把视频附件标记渲染成 chip，其余仍走 DirectiveText。 */}
          <MessagePrimitive.Parts components={{ Text: VideoMarkerText }} />
        </div>
        <div className="aui-user-action-bar-wrapper absolute start-0 top-1/2 -translate-x-full -translate-y-1/2 pe-2 peer-empty:hidden rtl:translate-x-full">
          <UserActionBar />
        </div>
      </div>

      <BranchPicker
        data-slot="aui_user-branch-picker"
        className="col-span-full col-start-1 row-start-3 -me-1 justify-end"
      />
    </MessagePrimitive.Root>
  );
};

const UserActionBar: FC = () => {
  return (
    <ActionBarPrimitive.Root
      hideWhenRunning
      autohide="not-last"
      className="aui-user-action-bar-root flex flex-col items-end"
    >
      <ActionBarPrimitive.Edit asChild>
        <TooltipIconButton tooltip="编辑" className="aui-user-action-edit">
          <PencilIcon />
        </TooltipIconButton>
      </ActionBarPrimitive.Edit>
    </ActionBarPrimitive.Root>
  );
};

const EditComposer: FC = () => {
  return (
    <MessagePrimitive.Root
      data-slot="aui_edit-composer-wrapper"
      className="mx-auto flex w-full max-w-(--thread-max-width) flex-col px-2"
    >
      <ComposerPrimitive.Unstable_TriggerPopoverRoot>
        <ComposerPrimitive.Root className="aui-edit-composer-root border-border/60 dark:border-muted-foreground/15 ms-auto flex w-full max-w-[85%] flex-col rounded-(--composer-radius) border bg-(--composer-bg) shadow-[0_4px_16px_-8px_rgba(0,0,0,0.08),0_1px_2px_rgba(0,0,0,0.04)] dark:shadow-none">
          <LexicalComposerInput
            directiveChip={DirectiveChip}
            autoFocus
            className="aui-edit-composer-input text-foreground min-h-14 w-full resize-none bg-transparent px-4 pt-3 pb-1 text-base outline-none [&_.aui-directive-chip]:inline-flex [&_.aui-directive-chip]:items-baseline [&_.aui-directive-chip]:gap-1 [&_.aui-directive-chip]:rounded-md [&_.aui-directive-chip]:bg-blue-100 [&_.aui-directive-chip]:px-1.5 [&_.aui-directive-chip]:py-0.5 [&_.aui-directive-chip]:text-[13px] [&_.aui-directive-chip]:leading-none [&_.aui-directive-chip]:font-medium [&_.aui-directive-chip]:text-blue-700 dark:[&_.aui-directive-chip]:bg-blue-900/50 dark:[&_.aui-directive-chip]:text-blue-300 [&_.aui-directive-chip-icon]:self-center [&_.aui-lexical-input]:min-h-lh [&_.aui-lexical-input]:outline-none"
          />
          <div className="aui-edit-composer-footer mx-2.5 mb-2.5 flex items-center gap-1.5 self-end">
            <ComposerPrimitive.Cancel asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-8 rounded-full px-3.5"
              >
                取消
              </Button>
            </ComposerPrimitive.Cancel>
            <ComposerPrimitive.Send asChild>
              <Button size="sm" className="h-8 rounded-full px-3.5">
                保存
              </Button>
            </ComposerPrimitive.Send>
          </div>
        </ComposerPrimitive.Root>
      </ComposerPrimitive.Unstable_TriggerPopoverRoot>
    </MessagePrimitive.Root>
  );
};

const BranchPicker: FC<BranchPickerPrimitive.Root.Props> = ({
  className,
  ...rest
}) => {
  return (
    <BranchPickerPrimitive.Root
      hideWhenSingleBranch
      className={cn(
        "aui-branch-picker-root text-muted-foreground -ms-2 me-2 inline-flex items-center text-xs",
        className,
      )}
      {...rest}
    >
      <BranchPickerPrimitive.Previous asChild>
        <TooltipIconButton tooltip="上一条">
          <ChevronLeftIcon />
        </TooltipIconButton>
      </BranchPickerPrimitive.Previous>
      <span className="aui-branch-picker-state font-medium">
        <BranchPickerPrimitive.Number /> / <BranchPickerPrimitive.Count />
      </span>
      <BranchPickerPrimitive.Next asChild>
        <TooltipIconButton tooltip="下一条">
          <ChevronRightIcon />
        </TooltipIconButton>
      </BranchPickerPrimitive.Next>
    </BranchPickerPrimitive.Root>
  );
};
