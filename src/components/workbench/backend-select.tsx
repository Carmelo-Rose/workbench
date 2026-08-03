"use client";

import { useEffect, useMemo, type FC } from "react";
import { BotIcon, SparklesIcon, ZapIcon } from "lucide-react";
import { useAui, useAuiState } from "@assistant-ui/react";
import {
  ModelSelector,
  type ModelOption,
} from "@/components/assistant-ui/model-selector";
import {
  directConnState,
  hermesConnState,
  useAgentStatus,
  useBackendChoice,
  type ConnState,
} from "@/lib/agent-status";
import { BACKENDS, isBackendId, type BackendId } from "@/lib/backends";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { getCurrentImage2ChatConfig } from "@/lib/image2-mode";
import { getCurrentProductPipelineConfig } from "@/lib/product-pipeline-run";

const DOT_CLASS: Record<ConnState, string> = {
  ok: "bg-emerald-500",
  down: "bg-red-500",
  unknown: "bg-muted-foreground/40",
};

export const StatusDot: FC<{ state: ConnState; className?: string }> = ({
  state,
  className,
}) => (
  <span
    aria-hidden
    data-state={state}
    className={cn(
      "inline-block size-1.5 shrink-0 rounded-full",
      DOT_CLASS[state],
      className,
    )}
  />
);

export const CONN_STATE_LABEL: Record<ConnState, string> = {
  ok: "在线",
  down: "离线",
  unknown: "检测中",
};

const BackendIcon: FC<{ backend: BackendId; state: ConnState }> = ({
  backend,
  state,
}) => {
  const Icon = backend === "hermes" ? BotIcon : ZapIcon;
  return (
    <span className="relative flex size-4 items-center justify-center">
      <Icon className="size-4" />
      <StatusDot
        state={state}
        className="ring-background absolute -top-0.5 -right-0.5 ring-2"
      />
    </span>
  );
};

/**
 * 把当前 backend 注册进 ModelContext（config.modelName），
 * AssistantChatTransport 会随每条 /api/chat 请求携带。挂在应用外壳，
 * 保证所有会话样式（含装饰性选择器的变体）都遵循同一模式选择。
 */
export const BackendModelContext: FC = () => {
  const api = useAui();

  useEffect(() => {
    return api.modelContext().register({
      // AssistantChatTransport reads this immediately before submitting the
      // message. Pull the Zustand stores here so a subject just selected for a
      // structured product/reference slot cannot be omitted while a React
      // effect is still updating the previously registered context.
      getModelContext: () => {
        const backend = useBackendChoice.getState().backend;
        const image2 = getCurrentImage2ChatConfig();
        const productPipeline = getCurrentProductPipelineConfig();
        return {
          config: {
            modelName: backend,
            ...(image2 ? { image2 } : {}),
            ...(productPipeline ? { productPipeline } : {}),
          },
        };
      },
    });
  }, [api]);

  return null;
};

function useBackendModelOptions(): ModelOption[] {
  const status = useAgentStatus((s) => s.status);

  return useMemo(() => {
    const hermesState = hermesConnState(status);
    const directState = directConnState(status);
    return [
      {
        id: "direct",
        name: BACKENDS.direct.name,
        description:
          directState === "down"
            ? "未配置 CHAT_API_KEY"
            : BACKENDS.direct.description,
        icon: <BackendIcon backend="direct" state={directState} />,
        keywords: ["qwen", "直连", "direct"],
      },
      {
        id: "hermes",
        name: BACKENDS.hermes.name,
        description:
          hermesState === "down"
            ? "网关离线 — 请启动 run-hermes-gateway.sh"
            : BACKENDS.hermes.description,
        icon: <BackendIcon backend="hermes" state={hermesState} />,
        keywords: ["agent", "hermes", "内核"],
      },
    ];
  }, [status]);
}

/** composer 里的模式切换器（替代原装饰性 ModelPicker）。 */
export const BackendPicker: FC = () => {
  const backend = useBackendChoice((s) => s.backend);
  const setBackend = useBackendChoice((s) => s.setBackend);
  const models = useBackendModelOptions();

  return (
    <ModelSelector
      models={models}
      value={backend}
      onValueChange={(v) => {
        if (isBackendId(v)) setBackend(v);
      }}
      variant="ghost"
      size="sm"
      className="h-7 rounded-full"
    />
  );
};

/** header 右侧的实时模式徽标，点击打开设置的连接页。 */
export const HeaderBackendStatus: FC<{ onClick?: () => void }> = ({
  onClick,
}) => {
  const backend = useBackendChoice((s) => s.backend);
  const status = useAgentStatus((s) => s.status);
  const state =
    backend === "hermes" ? hermesConnState(status) : directConnState(status);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          aria-label={`${BACKENDS[backend].name} · ${CONN_STATE_LABEL[state]} — 点击查看连接详情`}
          className="text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:ring-ring/50 flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs transition-colors outline-none focus-visible:ring-2"
        >
          <StatusDot state={state} />
          <span className="max-w-28 truncate">{BACKENDS[backend].name}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {BACKENDS[backend].name} · {CONN_STATE_LABEL[state]} — 点击查看连接详情
      </TooltipContent>
    </Tooltip>
  );
};

/** 助手消息脚注里的来源徽标：这条回复出自哪条链路。 */
export const MessageBackendBadge: FC = () => {
  const source = useAuiState((s) => {
    const custom = s.message.metadata?.custom as
      | { backend?: unknown; mode?: unknown }
      | undefined;
    if (custom?.mode === "image2") return "image2" as const;
    return isBackendId(custom?.backend) ? custom.backend : null;
  });

  if (!source) return null;
  if (source === "image2") {
    return <span data-slot="message-backend-badge" className="text-muted-foreground flex items-center gap-1 rounded-md p-1 text-xs"><SparklesIcon className="size-3.5" />生成图片</span>;
  }
  const Icon = source === "hermes" ? BotIcon : ZapIcon;

  return (
    <span
      data-slot="message-backend-badge"
      title={BACKENDS[source].description}
      className="text-muted-foreground flex items-center gap-1 rounded-md p-1 text-xs"
    >
      <Icon className="size-3.5" />
      {BACKENDS[source].name}
    </span>
  );
};
