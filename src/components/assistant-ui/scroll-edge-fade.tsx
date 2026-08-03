"use client";

import { useCallback, useEffect, useRef, useState, type FC, type ReactNode } from "react";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * 横向滚动行的边缘状态：溢出侧渐隐 + 箭头按钮都从这里读。用 scroll 事件
 * （被动）+ ResizeObserver 跟踪 scrollLeft/scrollWidth/clientWidth，
 * 不溢出时 atStart/atEnd 都为 true（不渲染渐隐/箭头）。
 */
const EDGE_THRESHOLD = 2;

export function useScrollEdgeFade<T extends HTMLElement = HTMLDivElement>() {
  const ref = useRef<T | null>(null);
  const [atStart, setAtStart] = useState(true);
  const [atEnd, setAtEnd] = useState(true);

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const { scrollLeft, scrollWidth, clientWidth } = el;
    setAtStart(scrollLeft <= EDGE_THRESHOLD);
    setAtEnd(scrollLeft + clientWidth >= scrollWidth - EDGE_THRESHOLD);
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => {
      el.removeEventListener("scroll", measure);
      observer.disconnect();
    };
  }, [measure]);

  const scrollBy = useCallback((delta: number) => {
    ref.current?.scrollBy({ left: delta, behavior: "smooth" });
  }, []);

  return { ref, atStart, atEnd, scrollBy };
}

const FADE_WIDTH = 28;
const ARROW_SCROLL_DISTANCE = 160;

function edgeMask(atStart: boolean, atEnd: boolean): string | undefined {
  if (atStart && atEnd) return undefined;
  const left = atStart ? "black 0" : `transparent 0, black ${FADE_WIDTH}px`;
  const right = atEnd ? "black 100%" : `black calc(100% - ${FADE_WIDTH}px), transparent 100%`;
  return `linear-gradient(to right, ${left}, ${right})`;
}

/**
 * 横向滚动 chip 行的壳：溢出侧渐隐（mask-image）+ 桌面 hover 时浮出箭头
 * （`[@media(hover:hover)]:flex` 只在真正支持 hover 的设备渲染，触屏不显示）。
 * 不溢出时两侧都不渲染，零视觉开销。
 */
export const ScrollFadeRow: FC<{
  children: ReactNode;
  className?: string;
  innerClassName?: string;
}> = ({ children, className, innerClassName }) => {
  const { ref, atStart, atEnd, scrollBy } = useScrollEdgeFade<HTMLDivElement>();
  const mask = edgeMask(atStart, atEnd);

  return (
    <div className={cn("group/scrollfade relative", className)}>
      <div
        ref={ref}
        className={cn("scrollbar-none overflow-x-auto", innerClassName)}
        style={mask ? { maskImage: mask, WebkitMaskImage: mask } : undefined}
      >
        {children}
      </div>
      {!atStart && (
        <button
          type="button"
          aria-label="向左滚动"
          onClick={() => scrollBy(-ARROW_SCROLL_DISTANCE)}
          className="text-foreground absolute inset-y-0 start-0 hidden w-8 items-center justify-start opacity-0 transition-opacity group-hover/scrollfade:opacity-100 [@media(hover:hover)]:flex"
        >
          <ChevronLeftIcon className="bg-background/90 size-5 rounded-full border p-0.5 shadow-sm" />
        </button>
      )}
      {!atEnd && (
        <button
          type="button"
          aria-label="向右滚动"
          onClick={() => scrollBy(ARROW_SCROLL_DISTANCE)}
          className="text-foreground absolute inset-y-0 end-0 hidden w-8 items-center justify-end opacity-0 transition-opacity group-hover/scrollfade:opacity-100 [@media(hover:hover)]:flex"
        >
          <ChevronRightIcon className="bg-background/90 size-5 rounded-full border p-0.5 shadow-sm" />
        </button>
      )}
    </div>
  );
};
