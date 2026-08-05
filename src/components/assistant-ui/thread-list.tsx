"use client";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
  AuiIf,
  ThreadListItemMorePrimitive,
  ThreadListItemPrimitive,
  ThreadListPrimitive,
  useAui,
  useAuiState,
} from "@assistant-ui/react";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  ChevronRightIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PinIcon,
  PinOffIcon,
  PlusIcon,
  SearchIcon,
  TrashIcon,
} from "lucide-react";
import {
  forwardRef,
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type FC,
} from "react";
import { useCommandPalette } from "@/lib/workbench/command-palette-store";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";

/** 超过这个会话数才值得给一个本地过滤框——太少时它只会占地方。 */
const SEARCH_BOX_MIN_THREADS = 12;

export const ThreadList: FC<{ onNewThread?: () => void }> = ({ onNewThread }) => {
  const [query, setQuery] = useState("");
  return (
    <ThreadListRoot>
      <ThreadListNew onClick={onNewThread} />
      <ThreadListSearchBox query={query} onQueryChange={setQuery} />
      <ThreadListItems query={query} />
    </ThreadListRoot>
  );
};

/**
 * 本地标题过滤，即时、无请求；会话数不多时完全不渲染（渐进式披露）。
 * 深入全文搜索交给 ⌘K，避免两处重复实现检索逻辑。
 */
const ThreadListSearchBox: FC<{
  query: string;
  onQueryChange: (query: string) => void;
}> = ({ query, onQueryChange }) => {
  const threadCount = useAuiState((s) => s.threads.threadIds.length);
  if (threadCount <= SEARCH_BOX_MIN_THREADS) return null;

  return (
    <div data-slot="aui_thread-list-search" className="relative mb-1">
      <SearchIcon className="text-muted-foreground pointer-events-none absolute start-2.5 top-1/2 size-3.5 -translate-y-1/2" />
      <input
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        placeholder="搜索会话标题"
        aria-label="搜索会话标题"
        className="border-input placeholder:text-muted-foreground focus-visible:ring-ring/50 h-8 w-full rounded-md border bg-transparent ps-8 pe-2 text-sm outline-none focus-visible:ring-2"
      />
    </div>
  );
};

export const ThreadListRoot: FC<
  ComponentPropsWithoutRef<typeof ThreadListPrimitive.Root>
> = ({ className, ...props }) => {
  return (
    <ThreadListPrimitive.Root
      data-slot="aui_thread-list-root"
      className={cn("flex flex-col gap-0.5", className)}
      {...props}
    />
  );
};

export const ThreadListItems: FC<
  ComponentPropsWithoutRef<"div"> & { query?: string }
> = ({ className, query = "", ...props }) => {
  return (
    <div
      data-slot="aui_thread-list-items"
      className={cn("flex flex-col gap-0.5", className)}
      {...props}
    >
      <AuiIf condition={(s) => s.threads.isLoading}>
        <ThreadListSkeleton />
      </AuiIf>
      <AuiIf condition={(s) => !s.threads.isLoading}>
        <ThreadListItemGroups query={query} />
      </AuiIf>
    </div>
  );
};

const DAY_IN_MS = 86_400_000;

const dateGroupLabel = (
  date: Date | undefined,
  startOfToday: number,
): string => {
  if (!date || date.getTime() >= startOfToday) return "今天";
  if (date.getTime() >= startOfToday - DAY_IN_MS) return "昨天";
  return "更早";
};

type ThreadListGroup = { label: string; indices: number[] };

/** `custom` 字段在这之前完全没被用过，置顶是它的第一个消费者。 */
type ThreadCustom = { pinned?: boolean };
const isPinned = (custom: unknown): boolean =>
  !!(custom as ThreadCustom | undefined)?.pinned;

const ThreadListItemGroups: FC<{ query?: string }> = ({ query = "" }) => {
  const threadIds = useAuiState((s) => s.threads.threadIds);
  const threadItems = useAuiState((s) => s.threads.threadItems);
  const trimmedQuery = query.trim();

  const filteredIndices = useMemo(() => {
    if (!trimmedQuery) return null;
    const itemsById = new Map(threadItems.map((item) => [item.id, item]));
    const lower = trimmedQuery.toLowerCase();
    const time = (id: string) =>
      itemsById.get(id)?.lastMessageAt?.getTime() ?? 0;
    return threadIds
      .map((id, index) => ({ id, index }))
      .filter(({ id }) => (itemsById.get(id)?.title ?? "").toLowerCase().includes(lower))
      .sort((a, b) => time(b.id) - time(a.id))
      .map(({ index }) => index);
  }, [threadIds, threadItems, trimmedQuery]);

  const groups = useMemo<ThreadListGroup[] | null>(() => {
    if (trimmedQuery) return null;
    const itemsById = new Map(threadItems.map((item) => [item.id, item]));
    const dates = threadIds.map((id) => itemsById.get(id)?.lastMessageAt);
    if (!dates.some(Boolean)) return null;

    const now = new Date();
    const startOfToday = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
    ).getTime();
    const time = (index: number) =>
      dates[index]?.getTime() ?? Number.MAX_SAFE_INTEGER;

    const allIndices = threadIds.map((_, index) => index);
    const pinnedIndices = allIndices
      .filter((index) => isPinned(itemsById.get(threadIds[index]!)?.custom))
      .sort((a, b) => time(b) - time(a));
    const pinnedSet = new Set(pinnedIndices);
    const indices = allIndices
      .filter((index) => !pinnedSet.has(index))
      .sort((a, b) => time(b) - time(a));

    const result: ThreadListGroup[] = [];
    if (pinnedIndices.length > 0) {
      result.push({ label: "置顶", indices: pinnedIndices });
    }
    for (const index of indices) {
      const label = dateGroupLabel(dates[index], startOfToday);
      const lastGroup = result[result.length - 1];
      if (lastGroup?.label === label) {
        lastGroup.indices.push(index);
      } else {
        result.push({ label, indices: [index] });
      }
    }
    return result;
  }, [threadIds, threadItems, trimmedQuery]);

  if (filteredIndices) {
    return (
      <>
        {filteredIndices.length === 0 ? (
          <p className="text-muted-foreground px-2.5 py-3 text-sm">
            没有标题匹配的会话
          </p>
        ) : (
          filteredIndices.map((index) => (
            <ThreadListPrimitive.ItemByIndex
              key={threadIds[index]}
              index={index}
              components={{ ThreadListItem }}
            />
          ))
        )}
        <SearchAllMessagesRow query={trimmedQuery} />
      </>
    );
  }

  if (!groups) {
    return (
      <ThreadListPrimitive.Items>
        {() => <ThreadListItem />}
      </ThreadListPrimitive.Items>
    );
  }

  return groups.map((group) => (
    <Fragment key={group.label}>
      <div
        data-slot="aui_thread-list-group-label"
        className="text-muted-foreground px-2.5 pt-3 pb-1 text-xs font-medium"
      >
        {group.label}
      </div>
      {group.indices.map((index) => (
        <ThreadListPrimitive.ItemByIndex
          key={threadIds[index]}
          index={index}
          components={{ ThreadListItem }}
        />
      ))}
    </Fragment>
  ));
};

/** 浅层标题过滤到深层全文检索的递进：带上当前查询词打开 ⌘K。 */
const SearchAllMessagesRow: FC<{ query: string }> = ({ query }) => {
  const openWithQuery = useCommandPalette((s) => s.openWithQuery);
  return (
    <button
      type="button"
      data-slot="aui_thread-list-search-all"
      onClick={() => openWithQuery(query)}
      className="text-muted-foreground hover:text-foreground w-full rounded-md px-2.5 py-2 text-start text-xs transition-colors"
    >
      在全部消息中搜索「{query}」→
    </button>
  );
};

export const ThreadListNew = forwardRef<
  HTMLButtonElement,
  ComponentPropsWithoutRef<typeof Button> & { labelClassName?: string }
>(({ className, labelClassName, children, ...props }, ref) => {
  return (
    <ThreadListPrimitive.New asChild>
      <Button
        ref={ref}
        variant="ghost"
        data-slot="aui_thread-list-new"
        className={cn(
          "hover:bg-muted data-active:bg-muted h-8 justify-start gap-2 rounded-md px-2.5 text-sm font-normal",
          className,
        )}
        {...props}
      >
        {children ?? (
          <>
            <PlusIcon
              data-slot="aui_thread-list-new-icon"
              className="size-4 shrink-0"
            />
            <span
              data-slot="aui_thread-list-new-label"
              className={cn("whitespace-nowrap", labelClassName)}
            >
              新建会话
            </span>
          </>
        )}
      </Button>
    </ThreadListPrimitive.New>
  );
});

ThreadListNew.displayName = "ThreadListNew";

const ThreadListSkeleton: FC = () => {
  return (
    <div className="flex flex-col gap-0.5">
      {Array.from({ length: 5 }, (_, i) => (
        <div
          key={i}
          role="status"
          aria-label="正在加载会话列表"
          data-slot="aui_thread-list-skeleton-wrapper"
          className="flex h-8 items-center px-2.5"
        >
          <Skeleton
            data-slot="aui_thread-list-skeleton"
            className="h-3.5 w-full"
          />
        </div>
      ))}
    </div>
  );
};

/** 重命名时原地替换 Trigger 的输入框；Enter/失焦提交，Esc 放弃。 */
const RenameInput: FC<{ onDone: () => void }> = ({ onDone }) => {
  const aui = useAui();
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(
    () => aui.threadListItem().getState().title ?? "",
  );
  const submittedRef = useRef(false);

  useEffect(() => {
    // rAF：菜单关闭时 Radix 会把焦点还给触发按钮，晚一帧抢回来才不会被冲掉。
    const raf = requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => cancelAnimationFrame(raf);
  }, []);

  const submit = () => {
    if (submittedRef.current) return;
    submittedRef.current = true;
    const title = value.trim();
    if (title) aui.threadListItem().rename(title);
    onDone();
  };

  return (
    <input
      ref={inputRef}
      data-slot="aui_thread-list-item-rename-input"
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onBlur={submit}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          submit();
        } else if (event.key === "Escape") {
          event.preventDefault();
          submittedRef.current = true;
          onDone();
        }
      }}
      className="focus-visible:ring-ring/50 h-full min-w-0 flex-1 rounded-md bg-transparent px-2.5 text-sm outline-none focus-visible:ring-[3px]"
    />
  );
};

export const ThreadListItem: FC = () => {
  const [renaming, setRenaming] = useState(false);

  return (
    <ThreadListItemPrimitive.Root
      data-slot="aui_thread-list-item"
      // 具名 group：侧边栏根节点自己带了一个匿名 `group`，用无名 group-hover
      // 会被它命中——鼠标进侧边栏任何位置，所有会话的「…」一起亮。
      className="group/thread-item hover:bg-muted focus-visible:bg-muted data-active:bg-muted has-focus-visible:bg-muted has-data-[state=open]:bg-muted relative flex h-8 items-center rounded-md transition-colors focus-visible:outline-none"
    >
      {renaming ? (
        <RenameInput onDone={() => setRenaming(false)} />
      ) : (
        <ThreadListItemPrimitive.Trigger
          data-slot="aui_thread-list-item-trigger"
          className="focus-visible:ring-ring/50 flex h-full min-w-0 flex-1 items-center rounded-md px-2.5 text-start text-sm outline-none group-hover/thread-item:pe-9 group-has-focus-visible/thread-item:pe-9 group-has-data-[state=open]/thread-item:pe-9 group-data-active/thread-item:pe-9 focus-visible:ring-[3px]"
        >
          <span
            data-slot="aui_thread-list-item-title"
            className="min-w-0 flex-1 truncate"
          >
            <ThreadListItemPrimitive.Title fallback="新会话" />
          </span>
        </ThreadListItemPrimitive.Trigger>
      )}
      <ThreadListItemMore onRename={() => setRenaming(true)} />
    </ThreadListItemPrimitive.Root>
  );
};

const moreItemClass =
  "hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none select-none";
const destructiveMoreItemClass =
  "text-destructive hover:bg-destructive/10 hover:text-destructive focus:bg-destructive/10 focus:text-destructive flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none select-none";
const moreContentClass =
  "bg-popover/95 text-popover-foreground data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=closed]:animate-out data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 min-w-32 overflow-hidden rounded-xl border p-1.5 shadow-lg backdrop-blur-sm";

/** 首次点击只把条目变红提示「确认删除」，第二次点击才真正触发删除。 */
const DeleteMenuItem: FC = () => {
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <ThreadListItemMorePrimitive.Item
        data-slot="aui_thread-list-item-more-item"
        onSelect={(event) => {
          event.preventDefault();
          setConfirming(true);
        }}
        className={destructiveMoreItemClass}
      >
        <TrashIcon className="size-4" />
        删除
      </ThreadListItemMorePrimitive.Item>
    );
  }

  return (
    <ThreadListItemPrimitive.Delete asChild>
      <ThreadListItemMorePrimitive.Item
        data-slot="aui_thread-list-item-more-item"
        className={cn(destructiveMoreItemClass, "font-medium")}
      >
        <TrashIcon className="size-4" />
        确认删除
      </ThreadListItemMorePrimitive.Item>
    </ThreadListItemPrimitive.Delete>
  );
};

/** `custom` 之前完全没被用过，置顶是它的第一个消费者——读写都走 threadListItem() 的 scoped 访问器。 */
const PinMenuItem: FC = () => {
  const aui = useAui();
  const pinned = useAuiState((s) => isPinned(s.threadListItem.custom));

  const toggle = () => {
    const current = aui.threadListItem().getState().custom as
      | ThreadCustom
      | undefined;
    aui.threadListItem().updateCustom({ ...current, pinned: !pinned });
  };

  return (
    <ThreadListItemMorePrimitive.Item
      data-slot="aui_thread-list-item-more-item"
      onSelect={toggle}
      className={moreItemClass}
    >
      {pinned ? (
        <>
          <PinOffIcon className="size-4" />
          取消置顶
        </>
      ) : (
        <>
          <PinIcon className="size-4" />
          置顶
        </>
      )}
    </ThreadListItemMorePrimitive.Item>
  );
};

const ThreadListItemMore: FC<{ onRename: () => void }> = ({ onRename }) => {
  return (
    <ThreadListItemMorePrimitive.Root sharedFocusGroup>
      <ThreadListItemMorePrimitive.Trigger asChild>
        <Button
          variant="ghost"
          size="icon"
          data-slot="aui_thread-list-item-more"
          className="data-[state=open]:bg-accent absolute end-1.5 top-1/2 size-6 -translate-y-1/2 p-0 opacity-0 group-hover/thread-item:opacity-100 group-has-focus-visible/thread-item:opacity-100 group-data-active/thread-item:opacity-100 data-[state=open]:opacity-100"
        >
          <MoreHorizontalIcon className="size-3.5" />
          <span className="sr-only">更多操作</span>
        </Button>
      </ThreadListItemMorePrimitive.Trigger>
      <ThreadListItemMorePrimitive.Content
        side="right"
        align="start"
        sideOffset={6}
        data-slot="aui_thread-list-item-more-content"
        className={moreContentClass}
      >
        <ThreadListItemMorePrimitive.Item
          data-slot="aui_thread-list-item-more-item"
          onSelect={onRename}
          className={moreItemClass}
        >
          <PencilIcon className="size-4" />
          重命名
        </ThreadListItemMorePrimitive.Item>
        <PinMenuItem />
        <ThreadListItemPrimitive.Archive asChild>
          <ThreadListItemMorePrimitive.Item
            data-slot="aui_thread-list-item-more-item"
            className={moreItemClass}
          >
            <ArchiveIcon className="size-4" />
            归档
          </ThreadListItemMorePrimitive.Item>
        </ThreadListItemPrimitive.Archive>
        {/* Content 关闭时 Radix 会卸载这棵子树，DeleteMenuItem 的 confirming 天然重置。 */}
        <DeleteMenuItem />
      </ThreadListItemMorePrimitive.Content>
    </ThreadListItemMorePrimitive.Root>
  );
};

/** 已归档区的会话项：把「归档」换成「恢复」，删除仍是同一套两步确认。 */
const ArchivedThreadListItem: FC = () => {
  return (
    <ThreadListItemPrimitive.Root
      data-slot="aui_thread-list-item"
      className="group/thread-item hover:bg-muted focus-visible:bg-muted has-focus-visible:bg-muted has-data-[state=open]:bg-muted relative flex h-8 items-center rounded-md transition-colors focus-visible:outline-none"
    >
      <ThreadListItemPrimitive.Trigger
        data-slot="aui_thread-list-item-trigger"
        className="focus-visible:ring-ring/50 flex h-full min-w-0 flex-1 items-center rounded-md px-2.5 text-start text-sm outline-none group-hover/thread-item:pe-9 group-has-focus-visible/thread-item:pe-9 group-has-data-[state=open]/thread-item:pe-9 focus-visible:ring-[3px]"
      >
        <span
          data-slot="aui_thread-list-item-title"
          className="text-muted-foreground min-w-0 flex-1 truncate"
        >
          <ThreadListItemPrimitive.Title fallback="新会话" />
        </span>
      </ThreadListItemPrimitive.Trigger>
      <ArchivedThreadListItemMore />
    </ThreadListItemPrimitive.Root>
  );
};

const ArchivedThreadListItemMore: FC = () => {
  return (
    <ThreadListItemMorePrimitive.Root sharedFocusGroup>
      <ThreadListItemMorePrimitive.Trigger asChild>
        <Button
          variant="ghost"
          size="icon"
          data-slot="aui_thread-list-item-more"
          className="data-[state=open]:bg-accent absolute end-1.5 top-1/2 size-6 -translate-y-1/2 p-0 opacity-0 group-hover/thread-item:opacity-100 group-has-focus-visible/thread-item:opacity-100 data-[state=open]:opacity-100"
        >
          <MoreHorizontalIcon className="size-3.5" />
          <span className="sr-only">更多操作</span>
        </Button>
      </ThreadListItemMorePrimitive.Trigger>
      <ThreadListItemMorePrimitive.Content
        side="right"
        align="start"
        sideOffset={6}
        data-slot="aui_thread-list-item-more-content"
        className={moreContentClass}
      >
        <ThreadListItemPrimitive.Unarchive asChild>
          <ThreadListItemMorePrimitive.Item
            data-slot="aui_thread-list-item-more-item"
            className={moreItemClass}
          >
            <ArchiveRestoreIcon className="size-4" />
            恢复
          </ThreadListItemMorePrimitive.Item>
        </ThreadListItemPrimitive.Unarchive>
        <DeleteMenuItem />
      </ThreadListItemMorePrimitive.Content>
    </ThreadListItemMorePrimitive.Root>
  );
};

/**
 * 已归档会话：默认折叠、零归档时默认占 0 像素。设置页可选择显示空状态；归档/恢复
 * 后端早就通了，之前只是界面上没有回去的路——恢复能回到主列表全靠这个入口。
 */
export const ArchivedThreadsSection: FC<{ showEmpty?: boolean }> = ({
  showEmpty = false,
}) => {
  const archivedCount = useAuiState((s) => s.threads.archivedThreadIds.length);
  const [open, setOpen] = useState(false);

  if (archivedCount === 0) {
    return showEmpty ? (
      <p className="text-muted-foreground px-2.5 py-2 text-sm">
        暂无已归档会话
      </p>
    ) : null;
  }

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="mt-2">
      <CollapsibleTrigger
        data-slot="aui_thread-list-archived-trigger"
        className="text-muted-foreground hover:text-foreground flex w-full items-center gap-1 rounded-md px-2.5 py-1.5 text-xs transition-colors"
      >
        <ChevronRightIcon
          className={cn("size-3.5 transition-transform", open && "rotate-90")}
        />
        已归档 · {archivedCount}
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-0.5 pt-0.5">
        <ThreadListPrimitive.Items archived>
          {() => <ArchivedThreadListItem />}
        </ThreadListPrimitive.Items>
      </CollapsibleContent>
    </Collapsible>
  );
};
