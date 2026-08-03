"use client";

import {
  memo,
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

const Categories: FC<CategoriesProps> = ({
  iconMap,
  fallbackIcon,
  emptyLabel,
}) => (
  <ComposerPrimitive.Unstable_TriggerPopoverCategories>
    {(categories) => (
      <div
        data-slot="composer-trigger-popover-categories"
        className="flex flex-col py-1"
      >
        {categories.map((cat) => {
          const Icon = resolveIcon(cat.id, iconMap, fallbackIcon);
          return (
            <ComposerPrimitive.Unstable_TriggerPopoverCategoryItem
              key={cat.id}
              categoryId={cat.id}
              className="hover:bg-accent focus:bg-accent data-[highlighted]:bg-accent flex cursor-pointer items-center justify-between gap-2 px-3 py-2 text-sm transition-colors outline-none"
            >
              <span className="flex items-center gap-2">
                <Icon className="text-muted-foreground size-4" />
                {cat.label}
              </span>
              <ChevronRightIcon className="text-muted-foreground size-4" />
            </ComposerPrimitive.Unstable_TriggerPopoverCategoryItem>
          );
        })}
        {categories.length === 0 && (
          <div className="text-muted-foreground px-3 py-2 text-sm">
            {emptyLabel}
          </div>
        )}
      </div>
    )}
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
  const { isLoading, query, close } = unstable_useTriggerPopoverScopeContext();

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
        <div
          data-slot="composer-trigger-popover-items"
          className="flex flex-col"
        >
          <ComposerPrimitive.Unstable_TriggerPopoverBack className="text-muted-foreground hover:bg-accent flex cursor-pointer items-center gap-1.5 border-b px-3 py-2 text-xs tracking-wide uppercase transition-colors">
            <ChevronLeftIcon className="size-3.5" />
            {backLabel}
          </ComposerPrimitive.Unstable_TriggerPopoverBack>

          <div className="py-1">
            {items.map((item, index) => {
              const iconKey =
                typeof item.metadata?.icon === "string"
                  ? item.metadata.icon
                  : undefined;
              const Icon = resolveIcon(iconKey, iconMap, fallbackIcon);
              const previewUrl = typeof item.metadata?.previewUrl === "string"
                ? item.metadata.previewUrl
                : undefined;
              const actionOnly = item.metadata?.actionOnly === true;
              return (
                <ComposerPrimitive.Unstable_TriggerPopoverItem
                  key={item.id}
                  item={item}
                  index={index}
                  onClick={actionOnly ? (event) => {
                    // Skip the library's default select handler (which would
                    // otherwise always insert a directive chip — see
                    // `onActionItem` doc comment above).
                    event.preventDefault();
                    runAction(item);
                  } : undefined}
                  className="hover:bg-accent focus:bg-accent data-[highlighted]:bg-accent flex w-full cursor-pointer flex-col items-start gap-0.5 px-3 py-2 text-start transition-colors outline-none"
                >
                  <span className="flex items-center gap-2 text-sm font-medium">
                    {previewUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={previewUrl} alt="" className="size-6 rounded-md object-cover" />
                    ) : <Icon className="text-primary size-3.5" />}
                    {item.label}
                  </span>
                  {item.description && (
                    <span className={cn("text-muted-foreground text-xs leading-tight", previewUrl ? "ms-8" : "ms-5.5")}>
                      {item.description}
                    </span>
                  )}
                </ComposerPrimitive.Unstable_TriggerPopoverItem>
              );
            })}
            {items.length === 0 && (
              <div className="text-muted-foreground px-3 py-2 text-sm">
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
        "aui-composer-trigger-popover bg-popover text-popover-foreground absolute start-0 z-50 w-64 overflow-y-auto rounded-xl border shadow-lg",
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
