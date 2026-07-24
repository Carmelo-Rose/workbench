import { getDb } from "@/lib/server/db";
import { activeWorkspaceId } from "@/lib/server/tenant-context";
import { legacyWorkspaceId } from "@/lib/server/tenant-ids";

/**
 * 运行时可覆盖的 API 配置项。存在 sqlite api_config 表里的值优先于
 * .env.local 里的同名环境变量，方便在设置页里改而不用重启进程。
 * 空字符串视为"清除覆盖"，会回落到环境变量。
 */
export const API_CONFIG_GROUPS = {
  chat: {
    label: "对话（Chat）",
    keys: ["CHAT_BASE_URL", "CHAT_API_KEY", "CHAT_MODEL"] as const,
  },
  vision: {
    label: "图片 / 视频反推（视觉理解）",
    keys: ["VISION_BASE_URL", "VISION_API_KEY", "VISION_MODEL"] as const,
  },
  monoVideo: {
    label: "视频分析服务（Mono）",
    keys: [
      "MONO_VIDEO_ANALYZE_URL",
      "MONO_VIDEO_RESOLVE_URL",
      "MONO_VIDEO_API_KEY",
      "MONO_VIDEO_MODEL",
    ] as const,
  },
  monoImage: {
    label: "生图服务（Mono）",
    keys: ["MONO_IMAGE_BASE_URL", "MONO_IMAGE_API_KEY", "MONO_IMAGE_MODEL"] as const,
  },
  videoStorage: {
    label: "大视频云存储（TOS）",
    keys: ["TOS_AK", "TOS_SK", "TOS_REGION", "TOS_BUCKET"] as const,
  },
} as const;

export type ApiConfigGroupId = keyof typeof API_CONFIG_GROUPS;
export type ApiConfigKey = (typeof API_CONFIG_GROUPS)[ApiConfigGroupId]["keys"][number];

const SECRET_KEYS = new Set<string>([
  "CHAT_API_KEY",
  "VISION_API_KEY",
  "MONO_VIDEO_API_KEY",
  "MONO_IMAGE_API_KEY",
  "TOS_AK",
  "TOS_SK",
]);

/** 读取单个 key 的当前生效值：db 覆盖优先，否则回落到环境变量。 */
function configWorkspaceId(workspaceId?: string): string {
  const resolved = workspaceId ?? activeWorkspaceId();
  if (resolved) return resolved;
  const legacyDevelopment =
    process.env.NODE_ENV === "test" ||
    (process.env.NODE_ENV !== "production" &&
      process.env.MONO_LOCAL_DEVELOPMENT === "true");
  if (legacyDevelopment) return legacyWorkspaceId;
  throw new Error("Workspace context is required for runtime API configuration");
}

export function getConfigValue(
  key: ApiConfigKey,
  workspaceId?: string,
): string | undefined {
  const row = getDb()
    .prepare("SELECT value FROM api_config WHERE workspace_id = ? AND key = ?")
    .get(configWorkspaceId(workspaceId), key) as { value: string } | undefined;
  if (row?.value) return row.value;
  return process.env[key] || undefined;
}

export function setConfigValues(
  values: Partial<Record<ApiConfigKey, string>>,
  workspaceId?: string,
): void {
  const db = getDb();
  const resolvedWorkspaceId = configWorkspaceId(workspaceId);
  const upsert = db.prepare(
    `INSERT INTO api_config (workspace_id, key, value, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(workspace_id, key)
     DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  );
  const del = db.prepare(
    "DELETE FROM api_config WHERE workspace_id = ? AND key = ?",
  );
  const now = Date.now();
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) continue;
    if (value.trim() === "") {
      del.run(resolvedWorkspaceId, key);
    } else {
      upsert.run(resolvedWorkspaceId, key, value, now);
    }
  }
}

function mask(value: string): string {
  if (value.length <= 4) return "••••";
  return `••••${value.slice(-4)}`;
}

export type ConfigFieldView = {
  key: ApiConfigKey;
  secret: boolean;
  value: string; // 非 secret 明文；secret 已脱敏
  source: "custom" | "env" | "unset";
};

/** 供设置页展示：非密钥字段给明文，密钥字段只给脱敏后的尾 4 位。 */
export function getAllConfigForDisplay(
  workspaceId?: string,
): Record<ApiConfigGroupId, ConfigFieldView[]> {
  const db = getDb();
  const overrideRows = db.prepare(
    "SELECT key, value FROM api_config WHERE workspace_id = ?",
  ).all(configWorkspaceId(workspaceId)) as {
    key: string;
    value: string;
  }[];
  const overrides = new Map(overrideRows.map((r) => [r.key, r.value]));

  const result = {} as Record<ApiConfigGroupId, ConfigFieldView[]>;
  for (const [groupId, group] of Object.entries(API_CONFIG_GROUPS)) {
    result[groupId as ApiConfigGroupId] = group.keys.map((key) => {
      const override = overrides.get(key);
      const raw = override ?? process.env[key] ?? "";
      const source: ConfigFieldView["source"] = override
        ? "custom"
        : process.env[key]
          ? "env"
          : "unset";
      const secret = SECRET_KEYS.has(key);
      return {
        key,
        secret,
        value: raw ? (secret ? mask(raw) : raw) : "",
        source,
      };
    });
  }
  return result;
}
