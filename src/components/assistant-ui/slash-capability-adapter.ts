"use client";

import { useMemo, useRef, type FC } from "react";
import type { Unstable_TriggerItem } from "@assistant-ui/react";
import {
  SLASH_CAPABILITIES,
  SLASH_CAPABILITY_GROUPS,
  capabilityAllowed,
  type CapabilityOption,
} from "@/lib/workbench/capabilities";
import { useRecentCapabilityIds } from "@/lib/workbench/recent-capabilities";
import { useWorkbenchSession } from "@/components/workbench/auth-gate";

type IconComponent = FC<{ className?: string }>;

/**
 * 结构化复刻 core 的 `Unstable_TriggerAdapter`（该类型没从 `@assistant-ui/react`
 * 导出，而 core 不是本项目的直接依赖）。字段和语义与 TriggerPopover 的
 * `adapter` prop 一致。
 */
type TriggerAdapter = {
  categories(): readonly { id: string; label: string }[];
  categoryItems(categoryId: string): readonly Unstable_TriggerItem[];
  search(query: string): readonly Unstable_TriggerItem[];
};

/** 「常用」条目的 id 前缀：同一个能力在常用段和本体段各出现一次，id 必须唯一。 */
const RECENT_PREFIX = "recent:";
const RECENT_GROUP_LABEL = "常用";

/**
 * 返回空分类是**故意的**，也是整个扁平布局的开关。库的
 * `triggerNavigationResource` 里判定视图模式的逻辑是：
 *
 *     if (!query && categories.length > 0) searchResults = null;  // 分类视图
 *     else if (adapter.search)             searchResults = adapter.search(query);
 *
 * 分类为空时，即使 query 为空也会走 `search("")`，`isSearchMode` 恒为 true。
 * 于是 `navigableList` 就是我们返回的这个扁平数组，`highlightedIndex` 直接
 * 索引它——方向键、回车、高亮全部零改造可用，分组标题只是穿插的普通节点。
 * 官方扁平版 `unstable_useSlashCommandAdapter` 也是这个路子。
 */
const NO_CATEGORIES: readonly { id: string; label: string }[] = [];
const NO_ITEMS: readonly Unstable_TriggerItem[] = [];

function toItem(
  option: CapabilityOption,
  groupLabel: string,
): Unstable_TriggerItem {
  return {
    id: option.id,
    type: "command",
    // 不带 description：菜单按单行渲染，说明文字只作为搜索关键词（见 haystack）。
    label: option.label,
    metadata: {
      ...(option.iconKey !== undefined ? { icon: option.iconKey } : {}),
      // 驱动菜单里的分组标题。搜索结果里也照常带着——「抠像换背景」在
      // 创作工具和视频工具箱下各有一条，去掉说明文字后分组标题是**唯一**
      // 的区分手段，不能只在无 query 时渲染。
      group: groupLabel,
    },
  };
}

/**
 * 搜索池：haystack 带上 hint 和分组名。说明文字虽然不再显示，但仍然参与匹配——
 * 敲 `/水印` 能命中「智能擦除」，敲 `/视频` 能把整组捞出来。删 hint 会悄悄
 * 削掉一半可搜性。
 */
const SEARCH_POOL = SLASH_CAPABILITY_GROUPS.flatMap((group) =>
  group.options.map((option) => ({
    item: toItem(option, group.label),
    haystack: [option.id, option.label, option.hint ?? "", group.label]
      .join("\n")
      .toLowerCase(),
  })),
);

type SlashCapabilityAdapterOptions = {
  /** 选中命令时执行；与欢迎页 chip、⌘K 面板同一条 run 路径。 */
  run: (option: CapabilityOption) => void;
  iconMap: Record<string, IconComponent>;
  fallbackIcon: IconComponent;
};

/**
 * `/` 命令的扁平菜单适配器：一次铺开全部能力，按分组标题分段，顶部是
 * 「常用」。敲字即跨组过滤（分组标题保留）。数据取能力注册表里标记 slash 的
 * 真能力，全程按权限过滤。
 *
 * 官方的 `unstable_useSlashCommandAdapter` 不支持分组标记，所以这里自己实现
 * 同样的 `{ adapter, action }` 约定。
 */
export function useSlashCapabilityAdapter({
  run,
  iconMap,
  fallbackIcon,
}: SlashCapabilityAdapterOptions) {
  const { canGrant } = useWorkbenchSession();
  const recentIds = useRecentCapabilityIds();
  // 和官方 hook 一样把回调放进 ref：adapter/action 的身份保持稳定，
  // 库内部按 adapter 身份做记忆化。
  const runRef = useRef(run);
  runRef.current = run;

  return useMemo(() => {
    const allowedIds = new Set(
      SLASH_CAPABILITIES.filter((option) => capabilityAllowed(option, canGrant)).map(
        (option) => option.id,
      ),
    );
    const allowedPool = SEARCH_POOL.filter((entry) => allowedIds.has(entry.item.id));
    const byId = new Map(allowedPool.map((entry) => [entry.item.id, entry.item]));

    // 常用条目是本体的副本：换掉 id 和分组标签，其余（图标、文案）保持一致。
    const recentItems = recentIds.flatMap((id) => {
      const item = byId.get(id);
      if (!item) return [];
      return [
        {
          ...item,
          id: RECENT_PREFIX + item.id,
          metadata: { ...item.metadata, group: RECENT_GROUP_LABEL },
        },
      ];
    });

    return {
      adapter: {
        categories: () => NO_CATEGORIES,
        categoryItems: () => NO_ITEMS,
        search: (query: string) => {
          const lower = query.trim().toLowerCase();
          const matched = allowedPool
            .filter((entry) => !lower || entry.haystack.includes(lower))
            .map((entry) => entry.item);
          // 过滤时不出「常用」：结果本来就短，再置顶一份重复项纯属噪音。
          return lower ? matched : [...recentItems, ...matched];
        },
      } satisfies TriggerAdapter,
      action: {
        onExecute: (item: Unstable_TriggerItem) => {
          const id = item.id.startsWith(RECENT_PREFIX)
            ? item.id.slice(RECENT_PREFIX.length)
            : item.id;
          const option = SLASH_CAPABILITIES.find(
            (cap) => cap.id === id && allowedIds.has(cap.id),
          );
          if (option) runRef.current(option);
        },
        removeOnExecute: true,
      },
      iconMap,
      fallbackIcon,
    };
  }, [iconMap, fallbackIcon, canGrant, recentIds]);
}
