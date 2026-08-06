"use client";

import { useEffect, useMemo, useState, type FC, type ReactNode } from "react";
import { useWorkbenchSession } from "@/components/workbench/auth-gate";
import {
  BotIcon,
  CableIcon,
  CheckIcon,
  DatabaseIcon,
  DownloadIcon,
  InfoIcon,
  KeyRoundIcon,
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
import { Input } from "@/components/ui/input";
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
import { type ThemePref } from "@/lib/theme";
import { type DensityPref } from "@/lib/density";
import { cn } from "@/lib/utils";
import {
  ArchivedThreadsSection,
  ThreadListRoot,
} from "@/components/assistant-ui/thread-list";

export type SettingsSection =
  | "connections"
  | "capabilities"
  | "apiConfig"
  | "appearance"
  | "data";

const SECTIONS: { id: SettingsSection; name: string; icon: ReactNode }[] = [
  { id: "connections", name: "连接与模式", icon: <CableIcon /> },
  { id: "capabilities", name: "Agent 能力", icon: <SparklesIcon /> },
  { id: "apiConfig", name: "API 配置", icon: <KeyRoundIcon /> },
  { id: "appearance", name: "外观", icon: <PaletteIcon /> },
  { id: "data", name: "数据", icon: <DatabaseIcon /> },
];

/** 旧版会话数据的 localStorage 前缀，现仅用于一次性迁移（见 server-threads.ts）。 */
export const THREADS_STORAGE_PREFIX = "wb:";

type SettingsDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  section: SettingsSection;
  onSectionChange: (section: SettingsSection) => void;
  styleId: ThreadStyleId;
  onStyleChange: (id: ThreadStyleId) => void;
  companion: CompanionId;
  onCompanionChange: (id: CompanionId) => void;
  themePref: ThemePref;
  onThemeChange: (pref: ThemePref) => void;
  densityPref: DensityPref;
  onDensityChange: (pref: DensityPref) => void;
};

export const SettingsDialog: FC<SettingsDialogProps> = ({
  open,
  onOpenChange,
  section,
  onSectionChange,
  ...rest
}) => {
  const { canGrant } = useWorkbenchSession();
  const sections = useMemo(() => SECTIONS.filter((item) => {
    if (item.id === "apiConfig") return canGrant("system.runtime-config.view");
    if (item.id === "connections") return canGrant("workbench.backend.direct.use") || canGrant("workbench.backend.hermes.use");
    if (item.id === "capabilities") return canGrant("workbench.chat.use");
    if (item.id === "data") return canGrant("sessions.messages.import") || canGrant("sessions.messages.export") || canGrant("sessions.messages.manage");
    return true;
  }), [canGrant]);
  useEffect(() => {
    if (!sections.some((item) => item.id === section) && sections[0]) onSectionChange(sections[0].id);
  }, [onSectionChange, section, sections]);
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
            {sections.map((s) => (
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
            {section === "apiConfig" && canGrant("system.runtime-config.view") && <ApiConfigSection />}
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

/* -------------------------------- API 配置 -------------------------------- */

type ConfigFieldView = {
  key: string;
  secret: boolean;
  value: string;
  source: "custom" | "env" | "unset";
};

type ConfigGroups = Record<string, ConfigFieldView[]>;

const GROUP_META: Record<string, { label: string; sub: string }> = {
  chat: { label: "对话（Chat）", sub: "驱动主对话的模型。" },
  vision: {
    label: "图片 / 视频反推（视觉理解）",
    sub: "用于「反推图片」与「分析视频」，需要能看图/看视频的模型。",
  },
  monoVideo: {
    label: "视频分析服务（Mono）",
    sub: "第三方视频理解服务地址，与上面的视觉模型是两套独立通道。",
  },
  monoImage: { label: "生图服务（Mono）", sub: "AI 生图服务地址。" },
  videoGeneration: {
    label: "视频生成服务（Mono）",
    sub: "选择 comfyui 或 dashscope-wan；云端请填 Base URL、API Key 和两个 Wan 2.7 模型。",
  },
  videoStorage: {
    label: "大视频云存储（TOS）",
    sub: "本机上传的视频超过约 7.3MB 直传阈值时，先传到这里再把可访问链接交给视频分析模型。",
  },
};

const FIELD_LABEL: Record<string, string> = {
  CHAT_BASE_URL: "Base URL",
  CHAT_API_KEY: "API Key",
  CHAT_MODEL: "模型",
  VISION_BASE_URL: "Base URL",
  VISION_API_KEY: "API Key",
  VISION_MODEL: "模型",
  MONO_VIDEO_ANALYZE_URL: "分析端点 URL",
  MONO_VIDEO_RESOLVE_URL: "分享链接解析 URL（可选）",
  MONO_VIDEO_API_KEY: "API Key",
  MONO_VIDEO_MODEL: "模型",
  MONO_IMAGE_BASE_URL: "Base URL",
  MONO_IMAGE_API_KEY: "API Key",
  MONO_IMAGE_MODEL: "模型",
  VIDEO_GENERATION_PROVIDER: "Provider（comfyui / dashscope-wan）",
  VIDEO_GENERATION_BASE_URL: "Base URL",
  VIDEO_GENERATION_API_KEY: "API Key",
  VIDEO_GENERATION_T2V_MODEL: "文生模型",
  VIDEO_GENERATION_I2V_MODEL: "图生模型",
  TOS_AK: "AccessKeyId",
  TOS_SK: "SecretAccessKey",
  TOS_REGION: "Region",
  TOS_BUCKET: "Bucket",
};

const SOURCE_LABEL: Record<ConfigFieldView["source"], string> = {
  custom: "自定义",
  env: ".env.local",
  unset: "未配置",
};

const ApiConfigGroup: FC<{
  groupId: string;
  fields: ConfigFieldView[];
  onSaved: (groups: ConfigGroups) => void;
  editable: boolean;
}> = ({ groupId, fields, onSaved, editable }) => {
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const meta = GROUP_META[groupId];
  const dirty = Object.keys(draft).length > 0;

  const save = async () => {
    setSaving(true);
    try {
      const res = await fetch("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
      if (res.ok) {
        const data = (await res.json()) as { groups: ConfigGroups };
        onSaved(data.groups);
        setDraft({});
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-xl border p-4">
      <div className="mb-3">
        <p className="text-sm font-medium">{meta?.label ?? groupId}</p>
        {meta?.sub && <p className="text-muted-foreground mt-0.5 text-xs">{meta.sub}</p>}
      </div>
      <div className="flex flex-col gap-3">
        {fields.map((field) => (
          <div key={field.key} className="flex flex-col gap-1">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground text-xs">
                {FIELD_LABEL[field.key] ?? field.key}
              </span>
              <span
                className={cn(
                  "rounded-full px-2 py-0.5 text-[10px] font-medium",
                  field.source === "custom" && "bg-accent text-accent-foreground",
                  field.source === "env" && "text-muted-foreground border",
                  field.source === "unset" && "text-destructive/80 border border-destructive/30",
                )}
              >
                {SOURCE_LABEL[field.source]}
              </span>
            </div>
            <Input
              disabled={!editable}
              type={field.secret ? "password" : "text"}
              value={draft[field.key] ?? (field.secret ? "" : field.value)}
              placeholder={field.secret ? (field.value || "未配置，输入以设置") : undefined}
              onChange={(e) =>
                setDraft((d) => ({ ...d, [field.key]: e.target.value }))
              }
              className="h-8 font-mono text-xs"
            />
          </div>
        ))}
      </div>
      {editable && <div className="mt-3 flex items-center gap-2">
        <Button
          size="sm"
          className="h-7 rounded-full px-3 text-xs"
          disabled={!dirty || saving}
          onClick={() => void save()}
        >
          保存
        </Button>
        {dirty && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 rounded-full px-3 text-xs"
            onClick={() => setDraft({})}
          >
            取消修改
          </Button>
        )}
      </div>}
    </div>
  );
};

const ApiConfigSection: FC = () => {
  const { canGrant } = useWorkbenchSession();
  const [groups, setGroups] = useState<ConfigGroups | null>(null);

  const load = () => {
    fetch("/api/config")
      .then((res) => res.json())
      .then((data: { groups: ConfigGroups }) => setGroups(data.groups));
  };

  useEffect(() => {
    load();
  }, []);

  return (
    <div>
      <SectionTitle sub="改这里立即生效，不用重启进程；留空保存会清除覆盖并回落到 .env.local。密钥保存后仅展示末 4 位。">
        API 配置
      </SectionTitle>
      {!groups ? (
        <p className="text-muted-foreground text-xs">加载中…</p>
      ) : (
        <div className="flex flex-col gap-3">
          {Object.entries(groups).map(([groupId, fields]) => (
            <ApiConfigGroup
              key={groupId}
              groupId={groupId}
              fields={fields}
              onSaved={setGroups}
              editable={canGrant("system.runtime-config.manage")}
            />
          ))}
        </div>
      )}
    </div>
  );
};

/* -------------------------------- 外观 -------------------------------- */

const THEME_OPTIONS: { id: ThemePref; name: string; icon: ReactNode }[] = [
  { id: "system", name: "跟随系统", icon: <MonitorIcon /> },
  { id: "light", name: "浅色", icon: <SunIcon /> },
  { id: "dark", name: "深色", icon: <MoonIcon /> },
];

const DENSITY_OPTIONS: { id: DensityPref; name: string }[] = [
  { id: "compact", name: "紧凑" },
  { id: "standard", name: "标准" },
  { id: "comfortable", name: "宽松" },
];

const AppearanceSection: FC<{
  styleId: ThreadStyleId;
  onStyleChange: (id: ThreadStyleId) => void;
  companion: CompanionId;
  onCompanionChange: (id: CompanionId) => void;
  themePref: ThemePref;
  onThemeChange: (pref: ThemePref) => void;
  densityPref: DensityPref;
  onDensityChange: (pref: DensityPref) => void;
}> = ({
  styleId,
  onStyleChange,
  companion,
  onCompanionChange,
  themePref,
  onThemeChange,
  densityPref,
  onDensityChange,
}) => {
  // 主题状态提升到 AssistantShell，与头部快切按钮共用一份。
  return (
    <div className="flex flex-col gap-6">
      <div>
        <SectionTitle>主题</SectionTitle>
        <div className="flex gap-2">
          {THEME_OPTIONS.map((opt) => (
            <button
              key={opt.id}
              type="button"
              onClick={() => onThemeChange(opt.id)}
              aria-pressed={themePref === opt.id}
              className={cn(
                "hover:bg-accent hover:text-accent-foreground focus-visible:ring-ring/50 flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-sm transition-colors outline-none focus-visible:ring-2 [&_svg]:size-4",
                themePref === opt.id
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
        <SectionTitle sub="调整全站间距与字号，选择即时生效。">密度</SectionTitle>
        <div className="flex gap-2">
          {DENSITY_OPTIONS.map((opt) => (
            <button
              key={opt.id}
              type="button"
              onClick={() => onDensityChange(opt.id)}
              aria-pressed={densityPref === opt.id}
              className={cn(
                "hover:bg-accent hover:text-accent-foreground focus-visible:ring-ring/50 rounded-full border px-3.5 py-1.5 text-sm transition-colors outline-none focus-visible:ring-2",
                densityPref === opt.id
                  ? "bg-accent text-accent-foreground border-ring/60 font-medium"
                  : "text-muted-foreground",
              )}
            >
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

const DataSection: FC = () => {
  // Dialog 关闭即卸载内容，重开时重新挂载并拉取最新计数。
  const [threadCount, setThreadCount] = useState<number | null>(null);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/threads")
      .then((res) => (res.ok ? res.json() : Promise.reject(res.status)))
      .then((data: { threads: unknown[] }) => {
        if (!cancelled) setThreadCount(data.threads.length);
      })
      .catch(() => {
        if (!cancelled) setThreadCount(0);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const clearAll = async () => {
    await fetch("/api/threads", { method: "DELETE" });
    window.location.reload();
  };

  return (
    <div>
      <SectionTitle sub="会话历史保存在服务端 SQLite（data/workbench.db），重启不丢，同一员工跨浏览器可见。">
        会话数据
      </SectionTitle>
      <div className="rounded-xl border p-4">
        <DetailRow
          label="已保存会话"
          value={threadCount === null ? "—" : `${threadCount} 条`}
        />
        <DetailRow label="存储位置" value="服务端 SQLite" />
      </div>
      <div className="mt-4 flex items-center gap-3">
        <Button
          variant="outline"
          size="sm"
          className="h-8 rounded-full px-4 text-xs"
          disabled={!threadCount}
          onClick={() => window.open("/api/threads/export")}
        >
          <DownloadIcon className="size-3.5" />
          导出 JSON 备份
        </Button>
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
      <div className="mt-8 border-t pt-6">
        <SectionTitle sub="归档的会话不会出现在侧边栏主列表中，可在这里恢复或删除。">
          已归档会话
        </SectionTitle>
        <ThreadListRoot className="rounded-xl border p-2">
          <ArchivedThreadsSection showEmpty />
        </ThreadListRoot>
      </div>
    </div>
  );
};
