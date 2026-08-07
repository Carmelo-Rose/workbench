"use client";

import {
  Fragment,
  memo,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type CSSProperties,
  type FC,
} from "react";
import {
  ComposerPrimitive,
  unstable_defaultDirectiveFormatter,
  unstable_useTriggerPopoverScopeContext,
  useAui,
  type Unstable_DirectiveFormatter,
  type Unstable_TriggerItem,
} from "@assistant-ui/react";
import { ChevronLeftIcon, ChevronRightIcon, SparklesIcon } from "lucide-react";
import {
  COMMAND_HEADING_CLASS,
  COMMAND_ITEM_BASE_CLASS,
} from "@/components/ui/command";
import { cn } from "@/lib/utils";

type IconComponent = FC<{ className?: string }>;

type DirectiveBehaviorProps = {
  /** Formatter used to serialize the selected item into composer text. */
  formatter?: Unstable_DirectiveFormatter | undefined;
  /** Called after the directive text has been inserted into the composer. */
  onInserted?: ((item: Unstable_TriggerItem) => void) | undefined;
};

type ActionBehaviorProps = {
  /** Formatter used to serialize the audit-trail chip (when `removeOnExecute` is false). */
  formatter?: Unstable_DirectiveFormatter | undefined;
  /** Invoked with the selected item at the moment of selection. */
  onExecute: (item: Unstable_TriggerItem) => void;
  /** If `true`, strip the trigger text from the composer after executing. @default false */
  removeOnExecute?: boolean | undefined;
};

type ComposerTriggerPopoverBaseProps = Omit<
  ComponentPropsWithoutRef<typeof ComposerPrimitive.Unstable_TriggerPopover>,
  "children"
> & {
  /**
   * Maps icon keys to components. Items look up via `item.metadata?.icon`
   * (string); categories look up via their `id`.
   */
  iconMap?: Record<string, IconComponent>;
  /** Fallback icon when no entry in `iconMap` matches. */
  fallbackIcon?: IconComponent;
  /** Label shown on the back button. @default "Back" */
  backLabel?: string;
  /** Label shown when no categories are available. @default "No items available" */
  emptyCategoriesLabel?: string;
  /** Label shown when no items match. @default "No matching items" */
  emptyItemsLabel?: string;
  /** Label shown while an async adapter is resolving items. @default "Loading…" */
  loadingLabel?: string;
  /**
   * Items with `metadata.actionOnly: true` run this instead of the normal
   * directive-insertion flow (which — via the Lexical `DirectivePlugin` —
   * always inserts a chip and never surfaces `directive.onInserted`). Use
   * this for menu entries that open a side panel rather than referencing
   * something inline (e.g. "create subject").
   */
  onActionItem?: (item: Unstable_TriggerItem) => void;
};

type ComposerTriggerPopoverProps = ComposerTriggerPopoverBaseProps &
  (
    | {
        /** Insert-directive behavior. */
        directive: DirectiveBehaviorProps;
        action?: never;
      }
    | {
        /** Action behavior. */
        action: ActionBehaviorProps;
        directive?: never;
      }
  );

function resolveIcon(
  iconKey: string | undefined,
  iconMap: Record<string, IconComponent> | undefined,
  fallback: IconComponent,
): IconComponent {
  if (iconKey && iconMap?.[iconKey]) return iconMap[iconKey]!;
  return fallback;
}

type CategoriesProps = {
  iconMap: Record<string, IconComponent> | undefined;
  fallbackIcon: IconComponent;
  emptyLabel: string;
};

/**
 * 条目行：复用 ⌘K 命令面板的行样式（`COMMAND_ITEM_BASE_CLASS`），只把选中态的
 * 选择器从 cmdk 的 `data-[selected=true]` 换成本库的 `data-[highlighted]`。
 *
 * 之所以只共享类名而不直接挂 cmdk 组件：`CommandItem` 需要 `Command` 根上下文，
 * 且 cmdk 要自己拥有一个聚焦的 input 来接管方向键——而 `/` 场景下焦点始终在
 * composer 上，没有独立输入框，两套键盘系统会打架。
 */
const ITEM_ROW_CLASS = cn(
  COMMAND_ITEM_BASE_CLASS,
  // 不加 transition-colors：⌘K 面板（CommandItem）的高亮也是瞬时切换，方向键
  // 连续按时过渡动画会跟不上手速，显得卡顿。
  "hover:bg-accent focus:bg-accent data-[highlighted]:bg-accent w-full cursor-pointer text-start",
);

/** 条目行的内容（图标/预览图 + 标题 + 可选说明）。 */
const ItemContent: FC<{
  item: Unstable_TriggerItem;
  iconMap: Record<string, IconComponent> | undefined;
  fallbackIcon: IconComponent;
}> = ({ item, iconMap, fallbackIcon }) => {
  const iconKey =
    typeof item.metadata?.icon === "string" ? item.metadata.icon : undefined;
  const Icon = resolveIcon(iconKey, iconMap, fallbackIcon);
  const previewUrl =
    typeof item.metadata?.previewUrl === "string"
      ? item.metadata.previewUrl
      : undefined;
  return (
    <>
      {previewUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={previewUrl} alt="" className="size-6 shrink-0 rounded-md object-cover" />
      ) : (
        // 不传 className：由 COMMAND_ITEM_BASE_CLASS 统一给 size-4 + muted，
        // 和 ⌘K 面板里的图标完全一致。
        <Icon />
      )}
      {/* `/` 命令没有 description（单行）；`@` 的主体/参考图仍带说明，两行。 */}
      <span className="flex min-w-0 flex-col">
        <span className="truncate">{item.label}</span>
        {item.description && (
          <span className="text-muted-foreground truncate text-xs">
            {item.description}
          </span>
        )}
      </span>
    </>
  );
};

/**
 * 一级分组列表（单列钻取：分组 → 点进去看条目 → 返回）。
 *
 * `/` 命令菜单不再走这条路——它的 adapter 故意返回空分类，让库恒定处在搜索
 * 模式、一次铺开全部能力（见 `slash-capability-adapter.ts` 的说明），库的
 * `TriggerPopoverCategories` 在 `isSearchMode` 下自己返回 null。这里保留是给
 * `@` 提及菜单用的。
 */
const CategoryList: FC<
  CategoriesProps & { categories: readonly { id: string; label: string }[] }
> = ({ categories, iconMap, fallbackIcon, emptyLabel }) => (
  <div
    data-slot="composer-trigger-popover-categories"
    className="flex flex-col p-1"
  >
    {categories.map((cat) => {
      const Icon = resolveIcon(cat.id, iconMap, fallbackIcon);
      return (
        <ComposerPrimitive.Unstable_TriggerPopoverCategoryItem
          key={cat.id}
          categoryId={cat.id}
          className={cn(ITEM_ROW_CLASS, "justify-between")}
        >
          <span className="flex min-w-0 items-center gap-2">
            <Icon />
            <span className="truncate">{cat.label}</span>
          </span>
          <ChevronRightIcon className="text-muted-foreground shrink-0" />
        </ComposerPrimitive.Unstable_TriggerPopoverCategoryItem>
      );
    })}
    {categories.length === 0 && (
      <div className="text-muted-foreground px-2 py-1.5 text-sm">{emptyLabel}</div>
    )}
  </div>
);

const Categories: FC<CategoriesProps> = (props) => (
  <ComposerPrimitive.Unstable_TriggerPopoverCategories>
    {(categories) => <CategoryList categories={categories} {...props} />}
  </ComposerPrimitive.Unstable_TriggerPopoverCategories>
);

type ItemsProps = {
  triggerChar: string;
  iconMap: Record<string, IconComponent> | undefined;
  fallbackIcon: IconComponent;
  backLabel: string;
  emptyLabel: string;
  loadingLabel: string;
  onActionItem: ((item: Unstable_TriggerItem) => void) | undefined;
};

/** 分组标题取自 `metadata.group`；没有就不分段（`@` 菜单即如此）。 */
function groupOf(item: Unstable_TriggerItem | undefined): string | undefined {
  return typeof item?.metadata?.group === "string" ? item.metadata.group : undefined;
}

const Items: FC<ItemsProps> = ({
  triggerChar,
  iconMap,
  fallbackIcon,
  backLabel,
  emptyLabel,
  loadingLabel,
  onActionItem,
}) => {
  const aui = useAui();
  const { isLoading, query, close, highlightedIndex } =
    unstable_useTriggerPopoverScopeContext();
  const listRef = useRef<HTMLDivElement>(null);

  // 库自己不把高亮项滚进视野。改成扁平列表后这是十几行的滚动列表（容器有
  // max-height），方向键一路按下去会走出可视区，必须补上。
  useEffect(() => {
    listRef.current
      ?.querySelector("[data-highlighted]")
      ?.scrollIntoView({ block: "nearest" });
  }, [highlightedIndex]);

  const runAction = (item: Unstable_TriggerItem) => {
    // Best-effort: strip the still-uncommitted "@query" text left behind
    // once the trigger deactivates. Only applies when the cursor is at the
    // end of that text (the common case while actively typing a mention).
    const composer = aui.composer();
    const text = composer.getState().text;
    const suffix = triggerChar + query;
    if (text.endsWith(suffix)) composer.setText(text.slice(0, -suffix.length));
    close();
    onActionItem?.(item);
  };

  return (
    <ComposerPrimitive.Unstable_TriggerPopoverItems>
      {(items) => (
        <div data-slot="composer-trigger-popover-items" className="flex flex-col">
          <ComposerPrimitive.Unstable_TriggerPopoverBack className="text-muted-foreground hover:bg-accent flex cursor-pointer items-center gap-1.5 border-b px-3 py-2 text-xs tracking-wide uppercase transition-colors">
            <ChevronLeftIcon className="size-3.5" />
            {backLabel}
          </ComposerPrimitive.Unstable_TriggerPopoverBack>

          <div ref={listRef} className="p-1">
            {items.map((item, index) => {
              const actionOnly = item.metadata?.actionOnly === true;
              const group = groupOf(item);
              const startsGroup = group !== undefined && group !== groupOf(items[index - 1]);
              return (
                <Fragment key={item.id}>
                  {startsGroup && (
                    <div className={cn(COMMAND_HEADING_CLASS, index > 0 && "mt-1")}>
                      {group}
                    </div>
                  )}
                  <ComposerPrimitive.Unstable_TriggerPopoverItem
                    item={item}
                    // 必须是扁平数组下标：库用它和 highlightedIndex 比对。
                    // 分组标题只是穿插的普通节点，不占索引。
                    index={index}
                    onClick={actionOnly ? (event) => {
                      // Skip the library's default select handler (which would
                      // otherwise always insert a directive chip — see
                      // `onActionItem` doc comment above).
                      event.preventDefault();
                      runAction(item);
                    } : undefined}
                    className={ITEM_ROW_CLASS}
                  >
                    <ItemContent item={item} iconMap={iconMap} fallbackIcon={fallbackIcon} />
                  </ComposerPrimitive.Unstable_TriggerPopoverItem>
                </Fragment>
              );
            })}
            {items.length === 0 && (
              <div className="text-muted-foreground px-2 py-1.5 text-sm">
                {isLoading ? loadingLabel : emptyLabel}
              </div>
            )}
          </div>
        </div>
      )}
    </ComposerPrimitive.Unstable_TriggerPopoverItems>
  );
};

/** Roomy but never full-screen: a taller list scrolls instead of growing. */
const MAX_POPOVER_HEIGHT = 320;
/** Below this a flipped popover is more annoying than a scrolling one. */
const MIN_POPOVER_HEIGHT = 160;
const POPOVER_GAP = 8;

type Placement = { side: "top" | "bottom"; maxHeight: number };

/**
 * Places the popover above the composer (the default), but flips it below and
 * always bounds its height so it can't run off-screen or bury the content it
 * is standing in front of.
 *
 * "Bounded by the window" alone isn't enough on the centered welcome screen:
 * the greeting sits just above the composer, so anything opening upward covers
 * it. Elements marked `data-composer-popover-avoid` act as a ceiling — the
 * popover fits itself into the gap above the composer and below them, and only
 * when that gap is too small does it drop under the composer instead.
 */
function usePopoverPlacement(): {
  ref: (node: HTMLDivElement | null) => void;
  placement: Placement;
} {
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const [placement, setPlacement] = useState<Placement>({
    side: "top",
    maxHeight: MAX_POPOVER_HEIGHT,
  });

  useLayoutEffect(() => {
    if (!node) return undefined;
    const anchor = (node.offsetParent ?? node.parentElement) as HTMLElement | null;
    if (!anchor) return undefined;

    const measure = () => {
      const anchorRect = anchor.getBoundingClientRect();
      const obstacle = document
        .querySelector<HTMLElement>("[data-composer-popover-avoid]")
        ?.getBoundingClientRect();
      // Only obstacles actually sitting above the composer constrain us.
      const ceiling =
        obstacle && obstacle.top < anchorRect.top
          ? obstacle.top - POPOVER_GAP
          : POPOVER_GAP;

      const above = anchorRect.top - POPOVER_GAP - ceiling;
      const below =
        window.innerHeight - anchorRect.bottom - POPOVER_GAP * 2;
      // scrollHeight is the unclipped content height, so it stays stable no
      // matter what max-height we applied on the previous pass.
      const needed = node.scrollHeight;
      const side: Placement["side"] =
        above >= Math.min(needed, MIN_POPOVER_HEIGHT) || above >= below
          ? "top"
          : "bottom";
      const maxHeight = Math.max(
        MIN_POPOVER_HEIGHT,
        Math.min(MAX_POPOVER_HEIGHT, side === "top" ? above : below),
      );

      setPlacement((current) =>
        current.side === side && current.maxHeight === maxHeight
          ? current
          : { side, maxHeight },
      );
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    observer.observe(anchor);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [node]);

  return { ref: setNode, placement };
}

/**
 * Pre-built popover UI for a trigger-driven picker (mentions, slash commands, etc).
 * Pass exactly one of `directive` (inserts a chip) or `action` (fires a handler).
 */
const ComposerTriggerPopoverImpl: FC<ComposerTriggerPopoverProps> = ({
  iconMap,
  fallbackIcon = SparklesIcon,
  backLabel = "返回",
  emptyCategoriesLabel = "暂无可用项",
  emptyItemsLabel = "没有匹配项",
  loadingLabel = "加载中…",
  onActionItem,
  className,
  style,
  directive,
  action,
  char,
  ...props
}) => {
  const { ref, placement } = usePopoverPlacement();
  const warnedRef = useRef(false);
  if (
    process.env.NODE_ENV !== "production" &&
    !warnedRef.current &&
    Boolean(directive) === Boolean(action)
  ) {
    warnedRef.current = true;
    console.warn(
      "[assistant-ui] ComposerTriggerPopover requires exactly one of `directive` or `action` props.",
    );
  }

  return (
    <ComposerPrimitive.Unstable_TriggerPopover
      ref={ref}
      data-slot="composer-trigger-popover"
      data-side={placement.side}
      className={cn(
        "aui-composer-trigger-popover bg-popover text-popover-foreground absolute start-0 z-50 w-72 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-xl border shadow-lg",
        placement.side === "top" ? "bottom-full mb-2" : "top-full mt-2",
        className,
      )}
      style={{ maxHeight: placement.maxHeight, ...style } as CSSProperties}
      char={char}
      {...props}
    >
      {directive ? (
        <ComposerPrimitive.Unstable_TriggerPopover.Directive
          formatter={directive.formatter ?? unstable_defaultDirectiveFormatter}
          onInserted={directive.onInserted}
        />
      ) : action ? (
        <ComposerPrimitive.Unstable_TriggerPopover.Action
          formatter={action.formatter ?? unstable_defaultDirectiveFormatter}
          onExecute={action.onExecute}
          removeOnExecute={action.removeOnExecute}
        />
      ) : null}
      <Categories
        iconMap={iconMap}
        fallbackIcon={fallbackIcon}
        emptyLabel={emptyCategoriesLabel}
      />
      <Items
        triggerChar={char}
        iconMap={iconMap}
        fallbackIcon={fallbackIcon}
        backLabel={backLabel}
        emptyLabel={emptyItemsLabel}
        loadingLabel={loadingLabel}
        onActionItem={onActionItem}
      />
    </ComposerPrimitive.Unstable_TriggerPopover>
  );
};
ComposerTriggerPopoverImpl.displayName = "ComposerTriggerPopover";

export const ComposerTriggerPopover = memo(
  ComposerTriggerPopoverImpl,
) as FC<ComposerTriggerPopoverProps>;
