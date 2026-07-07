"use client";

import { useState, type FC, type ReactNode } from "react";
import {
  BotIcon,
  CableIcon,
  CheckIcon,
  DatabaseIcon,
  InfoIcon,
  Link2Icon,
  MonitorIcon,
  MoonIcon,
  PaletteIcon,
  PuzzleIcon,
  RefreshCwIcon,
  SparklesIcon,
  SunIcon,
  Trash2Icon,
  WrenchIcon,
  ZapIcon,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  CONN_STATE_LABEL,
  StatusDot,
} from "@/components/workbench/backend-select";
import {
  CompanionPicker,
  type CompanionId,
} from "@/components/workbench/pets/companion";
import {
  THREAD_STYLES,
  type ThreadStyleId,
} from "@/components/workbench/thread-styles";
import {
  directConnState,
  hermesConnState,
  useAgentStatus,
  useBackendChoice,
  type ConnState,
} from "@/lib/agent-status";
import { BACKENDS, type BackendId } from "@/lib/backends";
import {
  loadThemePref,
  saveThemePref,
  type ThemePref,
} from "@/lib/theme";
import { cn } from "@/lib/utils";

export type SettingsSection =
  | "connections"
  | "capabilities"
  | "appearance"
  | "data";

const SECTIONS: { id: SettingsSection; name: string; icon: ReactNode }[] = [
  { id: "connections", name: "连接与模式", icon: <CableIcon /> },
  { id: "capabilities", name: "Agent 能力", icon: <SparklesIcon /> },
  { id: "appearance", name: "外观", icon: <PaletteIcon /> },
  { id: "data", name: "数据", icon: <DatabaseIcon /> },
];

/** 会话数据的 localStorage 前缀（与 createLocalStorageAdapter 的 prefix 一致）。 */
export const THREADS_STORAGE_PREFIX = "wb:";
const THREADS_KEY = `${THREADS_STORAGE_PREFIX}threads`;
const MESSAGES_KEY_PREFIX = `${THREADS_STORAGE_PREFIX}messages:`;

type SettingsDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  section: SettingsSection;
  onSectionChange: (section: SettingsSection) => void;
  styleId: ThreadStyleId;
  onStyleChange: (id: ThreadStyleId) => void;
  companion: CompanionId;
  onCompanionChange: (id: CompanionId) => void;
};

export const SettingsDialog: FC<SettingsDialogProps> = ({
  open,
  onOpenChange,
  section,
  onSectionChange,
  ...rest
}) => {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[600px] max-h-[85dvh] flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl">
        <DialogHeader className="shrink-0 border-b px-5 py-3.5 text-start">
          <DialogTitle className="text-base">设置</DialogTitle>
          <DialogDescription className="sr-only">
            管理连接、Agent 能力、外观与本地数据
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
          <nav
            aria-label="设置分区"
            className="flex shrink-0 gap-1 overflow-x-auto border-b p-2 sm:w-44 sm:flex-col sm:border-e sm:border-b-0"
          >
            {SECTIONS.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => onSectionChange(s.id)}
                aria-current={section === s.id ? "page" : undefined}
                className={cn(
                  "hover:bg-accent hover:text-accent-foreground focus-visible:ring-ring/50 flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm whitespace-nowrap transition-colors outline-none focus-visible:ring-2 [&_svg]:size-4 [&_svg]:shrink-0",
                  section === s.id
                    ? "bg-accent text-accent-foreground font-medium"
                    : "text-muted-foreground",
                )}
              >
                {s.icon}
                {s.name}
              </button>
            ))}
          </nav>
          <div className="min-h-0 flex-1 overflow-y-auto p-5">
            {section === "connections" && <ConnectionsSection />}
            {section === "capabilities" && <CapabilitiesSection />}
            {section === "appearance" && <AppearanceSection {...rest} />}
            {section === "data" && <DataSection />}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};

const SectionTitle: FC<{ children: ReactNode; sub?: ReactNode }> = ({
  children,
  sub,
}) => (
  <div className="mb-4">
    <h3 className="text-sm font-semibold">{children}</h3>
    {sub && <p className="text-muted-foreground mt-1 text-xs">{sub}</p>}
  </div>
);

/* ------------------------------ 连接与模式 ------------------------------ */

const DetailRow: FC<{ label: string; value: ReactNode }> = ({
  label,
  value,
}) => (
  <div className="flex items-baseline justify-between gap-4 text-xs">
    <span className="text-muted-foreground shrink-0">{label}</span>
    <span className="truncate font-mono">{value}</span>
  </div>
);

const BackendPanel: FC<{
  id: BackendId;
  state: ConnState;
  children: ReactNode;
}> = ({ id, state, children }) => {
  const backend = useBackendChoice((s) => s.backend);
  const setBackend = useBackendChoice((s) => s.setBackend);
  const active = backend === id;
  const info = BACKENDS[id];
  const Icon = id === "hermes" ? BotIcon : ZapIcon;

  return (
    <div
      className={cn(
        "rounded-xl border p-4 transition-colors",
        active && "border-ring/60 bg-accent/30",
      )}
    >
      <div className="flex items-center gap-2.5">
        <Icon className="text-muted-foreground size-4.5 shrink-0" />
        <span className="text-sm font-medium">{info.name}</span>
        <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
          <StatusDot state={state} />
          {CONN_STATE_LABEL[state]}
        </span>
        <span className="ms-auto">
          {active ? (
            <span className="text-muted-foreground flex items-center gap-1 text-xs font-medium">
              <CheckIcon className="size-3.5" />
              使用中
            </span>
          ) : (
            <Button
              variant="outline"
              size="sm"
              className="h-7 rounded-full px-3 text-xs"
              onClick={() => setBackend(id)}
            >
              切换到此模式
            </Button>
          )}
        </span>
      </div>
      <p className="text-muted-foreground mt-2 text-xs">{info.description}</p>
      <div className="mt-3 flex flex-col gap-1.5">{children}</div>
    </div>
  );
};

const ConnectionsSection: FC = () => {
  const status = useAgentStatus((s) => s.status);
  const checking = useAgentStatus((s) => s.checking);
  const lastChecked = useAgentStatus((s) => s.lastChecked);
  const refresh = useAgentStatus((s) => s.refresh);

  return (
    <div>
      <SectionTitle sub="双链路常驻，模式对每条消息即时生效，也可在输入框左下角切换。">
        对话模式
      </SectionTitle>
      <div className="flex flex-col gap-3">
        <BackendPanel id="direct" state={directConnState(status)}>
          <DetailRow label="模型" value={status?.direct.model ?? "—"} />
          <DetailRow label="端点" value={status?.direct.host ?? "—"} />
          <DetailRow
            label="密钥"
            value={
              status ? (status.direct.configured ? "已配置" : "未配置") : "—"
            }
          />
        </BackendPanel>
        <BackendPanel id="hermes" state={hermesConnState(status)}>
          <DetailRow label="网关" value={status?.hermes.host ?? "—"} />
          <DetailRow label="版本" value={status?.hermes.version ?? "—"} />
          <DetailRow label="平台" value={status?.hermes.platform ?? "—"} />
          {status?.hermes.error && (
            <p className="text-destructive mt-1 text-xs">
              {status.hermes.error} — 可运行 scripts/run-hermes-gateway.sh 启动
            </p>
          )}
        </BackendPanel>
      </div>
      <div className="text-muted-foreground mt-4 flex items-center gap-3 text-xs">
        <Button
          variant="outline"
          size="sm"
          className="h-7 rounded-full px-3 text-xs"
          disabled={checking}
          onClick={() => void refresh()}
        >
          <RefreshCwIcon
            className={cn("size-3.5", checking && "animate-spin")}
          />
          重新检测
        </Button>
        <span>
          {lastChecked
            ? `上次检测 ${new Date(lastChecked).toLocaleTimeString()}`
            : "尚未检测"}
        </span>
        <span className="ms-auto">
          服务端默认：{status ? BACKENDS[status.defaultBackend as BackendId]?.name ?? status.defaultBackend : "—"}
        </span>
      </div>
    </div>
  );
};

/* ------------------------------ Agent 能力 ------------------------------ */

const HERMES_CAPABILITY_ICONS = [WrenchIcon, DatabaseIcon, PuzzleIcon, Link2Icon];
const DIRECT_CAPABILITY_ICONS = [ZapIcon, WrenchIcon, DatabaseIcon];

const CapabilityList: FC<{
  items: { label: string; detail: string }[];
  icons: typeof HERMES_CAPABILITY_ICONS;
}> = ({ items, icons }) => (
  <ul className="flex flex-col">
    {items.map((cap, i) => {
      const Icon = icons[i % icons.length]!;
      return (
        <li
          key={cap.label}
          className="flex items-start gap-3 border-b py-3 last:border-b-0"
        >
          <Icon className="text-muted-foreground mt-0.5 size-4 shrink-0" />
          <div className="min-w-0">
            <p className="text-sm font-medium">{cap.label}</p>
            <p className="text-muted-foreground mt-0.5 text-xs">{cap.detail}</p>
          </div>
        </li>
      );
    })}
  </ul>
);

const CapabilitiesSection: FC = () => {
  const status = useAgentStatus((s) => s.status);
  const hermesState = hermesConnState(status);

  return (
    <div>
      <div className="mb-4 flex items-center gap-2">
        <h3 className="text-sm font-semibold">Hermes Agent 内核</h3>
        {status?.hermes.version && (
          <span className="text-muted-foreground rounded-full border px-2 py-0.5 font-mono text-[11px]">
            v{status.hermes.version}
          </span>
        )}
        <span className="text-muted-foreground ms-auto flex items-center gap-1.5 text-xs">
          <StatusDot state={hermesState} />
          {CONN_STATE_LABEL[hermesState]}
        </span>
      </div>
      {hermesState === "down" && (
        <p className="text-destructive bg-destructive/10 border-destructive/30 mb-3 rounded-lg border p-3 text-xs">
          网关当前离线，以下能力暂不可用。运行 scripts/run-hermes-gateway.sh
          后到「连接与模式」里重新检测。
        </p>
      )}
      <CapabilityList
        items={BACKENDS.hermes.capabilities}
        icons={HERMES_CAPABILITY_ICONS}
      />
      <p className="text-muted-foreground mt-3 flex items-start gap-2 text-xs">
        <InfoIcon className="mt-0.5 size-3.5 shrink-0" />
        Hermes 每次请求会注入完整 Agent 系统提示（约 1.2 万 token）。演示与内部使用没有问题，规模化前建议评估推理成本。
      </p>

      <div className="mt-6 mb-4 border-t pt-5">
        <h3 className="text-sm font-semibold">Qwen 直连</h3>
      </div>
      <CapabilityList
        items={BACKENDS.direct.capabilities}
        icons={DIRECT_CAPABILITY_ICONS}
      />
    </div>
  );
};

/* -------------------------------- 外观 -------------------------------- */

const THEME_OPTIONS: { id: ThemePref; name: string; icon: ReactNode }[] = [
  { id: "system", name: "跟随系统", icon: <MonitorIcon /> },
  { id: "light", name: "浅色", icon: <SunIcon /> },
  { id: "dark", name: "深色", icon: <MoonIcon /> },
];

const AppearanceSection: FC<{
  styleId: ThreadStyleId;
  onStyleChange: (id: ThreadStyleId) => void;
  companion: CompanionId;
  onCompanionChange: (id: CompanionId) => void;
}> = ({ styleId, onStyleChange, companion, onCompanionChange }) => {
  // Dialog 内容仅在客户端挂载，惰性读取本地偏好即可。
  const [theme, setTheme] = useState<ThemePref>(loadThemePref);

  const pickTheme = (pref: ThemePref) => {
    setTheme(pref);
    saveThemePref(pref);
  };

  return (
    <div className="flex flex-col gap-6">
      <div>
        <SectionTitle>主题</SectionTitle>
        <div className="flex gap-2">
          {THEME_OPTIONS.map((opt) => (
            <button
              key={opt.id}
              type="button"
              onClick={() => pickTheme(opt.id)}
              aria-pressed={theme === opt.id}
              className={cn(
                "hover:bg-accent hover:text-accent-foreground focus-visible:ring-ring/50 flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-sm transition-colors outline-none focus-visible:ring-2 [&_svg]:size-4",
                theme === opt.id
                  ? "bg-accent text-accent-foreground border-ring/60 font-medium"
                  : "text-muted-foreground",
              )}
            >
              {opt.icon}
              {opt.name}
            </button>
          ))}
        </div>
      </div>

      <div>
        <SectionTitle sub="切换整套会话界面风格，选择即时生效。">
          会话样式
        </SectionTitle>
        <div className="flex flex-wrap gap-2">
          {THREAD_STYLES.map((style) => (
            <button
              key={style.id}
              type="button"
              onClick={() => onStyleChange(style.id)}
              aria-pressed={styleId === style.id}
              className={cn(
                "hover:bg-accent hover:text-accent-foreground focus-visible:ring-ring/50 rounded-full border px-3.5 py-1.5 text-sm transition-colors outline-none focus-visible:ring-2",
                styleId === style.id
                  ? "bg-accent text-accent-foreground border-ring/60 font-medium"
                  : "text-muted-foreground",
              )}
            >
              {style.name}
            </button>
          ))}
        </div>
      </div>

      <div>
        <SectionTitle sub="响应指针和输入，但不阻断页面操作。">伴宠</SectionTitle>
        <CompanionPicker value={companion} onChange={onCompanionChange} />
      </div>
    </div>
  );
};

/* -------------------------------- 数据 -------------------------------- */

// Dialog 关闭即卸载内容，重开时本组件重新挂载，惰性初始化天然拿到最新计数。
const readThreadCount = (): number => {
  try {
    const raw = window.localStorage.getItem(THREADS_KEY);
    const threads: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(threads) ? threads.length : 0;
  } catch {
    return 0;
  }
};

const DataSection: FC = () => {
  const [threadCount] = useState<number>(readThreadCount);
  const [confirming, setConfirming] = useState(false);

  const clearAll = () => {
    const keys: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (key === THREADS_KEY || key?.startsWith(MESSAGES_KEY_PREFIX)) {
        keys.push(key);
      }
    }
    keys.forEach((key) => window.localStorage.removeItem(key));
    window.location.reload();
  };

  return (
    <div>
      <SectionTitle sub="会话历史保存在本机浏览器 localStorage，不上传服务器；换浏览器或清缓存会丢失。">
        本地数据
      </SectionTitle>
      <div className="rounded-xl border p-4">
        <DetailRow
          label="已保存会话"
          value={threadCount === null ? "—" : `${threadCount} 条`}
        />
        <DetailRow label="存储位置" value="localStorage（wb:*）" />
      </div>
      <div className="mt-4 flex items-center gap-3">
        {confirming ? (
          <>
            <Button
              variant="destructive"
              size="sm"
              className="h-8 rounded-full px-4 text-xs"
              onClick={clearAll}
            >
              <Trash2Icon className="size-3.5" />
              确认清空并刷新
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 rounded-full px-3 text-xs"
              onClick={() => setConfirming(false)}
            >
              取消
            </Button>
          </>
        ) : (
          <Button
            variant="outline"
            size="sm"
            className="text-destructive hover:text-destructive h-8 rounded-full px-4 text-xs"
            disabled={!threadCount}
            onClick={() => setConfirming(true)}
          >
            <Trash2Icon className="size-3.5" />
            清空全部会话
          </Button>
        )}
      </div>
    </div>
  );
};
