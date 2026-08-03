"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FC,
} from "react";
import { ChevronDownIcon, ChevronUpIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * ⌘F 覆盖浏览器默认查找：在当前会话 viewport 内高亮匹配、上一个/下一个跳转。
 * 用 CSS Custom Highlight API（不支持时静默降级为只滚动、不描边）——
 * 不像插入 <mark> 那样会被 React 的下一次渲染悄悄冲掉。
 */
const VIEWPORT_SELECTOR = '[data-slot="aui_thread-viewport"]';
const SKIP_SELECTOR = "[data-thread-find-skip]";
const HIGHLIGHT_ALL = "thread-find-all";
const HIGHLIGHT_ACTIVE = "thread-find-active";
const DEBOUNCE_MS = 120;

const supportsHighlightApi =
  typeof CSS !== "undefined" &&
  "highlights" in CSS &&
  typeof Highlight !== "undefined";

function collectRanges(root: HTMLElement, query: string): Range[] {
  const lower = query.toLowerCase();
  const ranges: Range[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.textContent?.trim()) return NodeFilter.FILTER_REJECT;
      if (node.parentElement?.closest(SKIP_SELECTOR)) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const text = (node.textContent ?? "").toLowerCase();
    let from = 0;
    for (;;) {
      const idx = text.indexOf(lower, from);
      if (idx === -1) break;
      const range = document.createRange();
      range.setStart(node, idx);
      range.setEnd(node, idx + query.length);
      ranges.push(range);
      from = idx + query.length;
    }
  }
  return ranges;
}

const scrollRangeIntoView = (range: Range) => {
  range.startContainer.parentElement?.scrollIntoView({
    block: "center",
    behavior: "smooth",
  });
};

export const ThreadFindBar: FC = () => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [matchCount, setMatchCount] = useState(0);
  const [activeIndex, setActiveIndex] = useState(0);
  const rangesRef = useRef<Range[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  const clearHighlights = useCallback(() => {
    if (!supportsHighlightApi) return;
    CSS.highlights.delete(HIGHLIGHT_ALL);
    CSS.highlights.delete(HIGHLIGHT_ACTIVE);
  }, []);

  const applyHighlights = useCallback((ranges: Range[], active: number) => {
    if (!supportsHighlightApi) return;
    CSS.highlights.set(HIGHLIGHT_ALL, new Highlight(...ranges));
    const activeRange = ranges[active];
    CSS.highlights.set(
      HIGHLIGHT_ACTIVE,
      activeRange ? new Highlight(activeRange) : new Highlight(),
    );
  }, []);

  const recompute = useCallback(
    (rawQuery: string, keepIndex: number) => {
      const q = rawQuery.trim();
      const root = document.querySelector<HTMLElement>(VIEWPORT_SELECTOR);
      if (!root || !q) {
        rangesRef.current = [];
        setMatchCount(0);
        setActiveIndex(0);
        clearHighlights();
        return;
      }
      const ranges = collectRanges(root, q);
      rangesRef.current = ranges;
      const nextIndex = ranges.length
        ? Math.min(keepIndex, ranges.length - 1)
        : 0;
      setMatchCount(ranges.length);
      setActiveIndex(nextIndex);
      applyHighlights(ranges, nextIndex);
      const target = ranges[nextIndex];
      if (target) scrollRangeIntoView(target);
    },
    [applyHighlights, clearHighlights],
  );

  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => recompute(query, 0), DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 换 query 时总是从头找起
  }, [open, query]);

  const goTo = useCallback(
    (delta: number) => {
      const ranges = rangesRef.current;
      if (!ranges.length) return;
      const next = (activeIndex + delta + ranges.length) % ranges.length;
      setActiveIndex(next);
      applyHighlights(ranges, next);
      scrollRangeIntoView(ranges[next]!);
    },
    [activeIndex, applyHighlights],
  );

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
    rangesRef.current = [];
    setMatchCount(0);
    setActiveIndex(0);
    clearHighlights();
  }, [clearHighlights]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
        // 已有 Dialog 打开时不抢，与 ⌘K 面板同一约束。
        if (!open && document.querySelector('[role="dialog"]')) return;
        event.preventDefault();
        setOpen(true);
        return;
      }
      if (event.key === "Escape" && open) {
        event.preventDefault();
        close();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, close]);

  useEffect(() => {
    if (open) requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  // 卸载/关闭都要清场：高亮是全局注册表，留着会侵入下一次打开的样式变体。
  useEffect(() => () => clearHighlights(), [clearHighlights]);

  if (!open) return null;

  return (
    <div
      role="search"
      aria-label="会话内查找"
      data-thread-find-skip
      className="bg-popover text-popover-foreground fade-in slide-in-from-top-1 animate-in absolute start-1/2 top-3 z-40 flex -translate-x-1/2 items-center gap-1 rounded-full border py-1 pe-1.5 ps-3 shadow-lg backdrop-blur-sm duration-150"
    >
      <Input
        ref={inputRef}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            goTo(event.shiftKey ? -1 : 1);
          }
        }}
        placeholder="在本会话中查找…"
        className="h-7 w-40 rounded-full border-none bg-transparent px-0 text-sm shadow-none focus-visible:ring-0"
      />
      <span className="text-muted-foreground w-12 shrink-0 text-center text-xs tabular-nums">
        {matchCount ? `${activeIndex + 1}/${matchCount}` : "0/0"}
      </span>
      <Button
        variant="ghost"
        size="icon"
        className="size-6 rounded-full"
        disabled={!matchCount}
        onClick={() => goTo(-1)}
        aria-label="上一个"
      >
        <ChevronUpIcon className="size-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="size-6 rounded-full"
        disabled={!matchCount}
        onClick={() => goTo(1)}
        aria-label="下一个"
      >
        <ChevronDownIcon className="size-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="size-6 rounded-full"
        onClick={close}
        aria-label="关闭查找"
      >
        <XIcon className="size-3.5" />
      </Button>
    </div>
  );
};
