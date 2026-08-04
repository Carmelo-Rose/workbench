"use client";

import { useMemo, useRef, type FC } from "react";
import type { Unstable_TriggerItem } from "@assistant-ui/react";
import {
  SLASH_CAPABILITIES,
  SLASH_CAPABILITY_GROUPS,
  type CapabilityOption,
} from "@/lib/workbench/capabilities";

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

function toItem(option: CapabilityOption): Unstable_TriggerItem {
  return {
    id: option.id,
    type: "command",
    label: option.label,
    ...(option.hint !== undefined ? { description: option.hint } : {}),
    ...(option.iconKey !== undefined ? { metadata: { icon: option.iconKey } } : {}),
  };
}

const CATEGORIES = SLASH_CAPABILITY_GROUPS.map(({ id, label }) => ({ id, label }));

const ITEMS_BY_CATEGORY = new Map<string, Unstable_TriggerItem[]>(
  SLASH_CAPABILITY_GROUPS.map((group) => [group.id, group.options.map(toItem)]),
);

/** 搜索池：带上分组名，这样敲 `/视频` 也能把整组能力捞出来。 */
const SEARCH_POOL = SLASH_CAPABILITY_GROUPS.flatMap((group) =>
  group.options.map((option) => ({
    item: toItem(option),
    haystack: [option.id, option.label, option.hint ?? "", group.label]
      .join("\n")
      .toLowerCase(),
  })),
);

type SlashCapabilityAdapterOptions = {
  /** 选中命令时执行；与欢迎页 chip、⌘K 面板同一条 run 路径。 */
  run: (option: CapabilityOption) => void;
  /** 图标键 → 组件；分组一级会额外按 `group.id` 查表，这里自动补上映射。 */
  iconMap: Record<string, IconComponent>;
  fallbackIcon: IconComponent;
};

/**
 * `/` 命令的两级菜单适配器：一级列能力分组，进组后列组内命令，
 * 一旦用户接着敲字就跨组打平搜索（库的 TriggerPopover 自动在
 * 分组视图 / 搜索视图之间切换，并提供「返回」）。
 *
 * 官方的 `unstable_useSlashCommandAdapter` 只支持打平列表，所以这里自己实现
 * 同样的 `{ adapter, action }` 约定。
 */
export function useSlashCapabilityAdapter({
  run,
  iconMap,
  fallbackIcon,
}: SlashCapabilityAdapterOptions) {
  // 和官方 hook 一样把回调放进 ref：adapter/action 的身份保持稳定，
  // 库内部按 adapter 身份做记忆化。
  const runRef = useRef(run);
  runRef.current = run;

  return useMemo(
    () => ({
      adapter: {
        categories: () => CATEGORIES,
        categoryItems: (categoryId: string) => ITEMS_BY_CATEGORY.get(categoryId) ?? [],
        search: (query: string) => {
          const lower = query.toLowerCase();
          return SEARCH_POOL.filter((entry) => entry.haystack.includes(lower)).map(
            (entry) => entry.item,
          );
        },
      } satisfies TriggerAdapter,
      action: {
        onExecute: (item: Unstable_TriggerItem) => {
          const option = SLASH_CAPABILITIES.find((cap) => cap.id === item.id);
          if (option) runRef.current(option);
        },
        removeOnExecute: true,
      },
      iconMap: {
        ...iconMap,
        ...Object.fromEntries(
          SLASH_CAPABILITY_GROUPS.flatMap((group) => {
            const Icon = iconMap[group.iconKey];
            return Icon ? [[group.id, Icon] as const] : [];
          }),
        ),
      },
      fallbackIcon,
    }),
    [iconMap, fallbackIcon],
  );
}
