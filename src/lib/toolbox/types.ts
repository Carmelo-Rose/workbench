/** 视频工具箱共享类型：网关 Job 协议的前端镜像（服务端与客户端组件都会用到）。 */

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "canceled";

export type JobArtifact = {
  path: string;
  name: string;
  size: number;
};

export type JobInfo = {
  id: string;
  capability: string;
  params: Record<string, unknown>;
  inputs: Record<string, string>;
  status: JobStatus;
  progress: number;
  stage: string;
  error: string;
  artifacts: JobArtifact[];
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
};

/** 工具箱能力清单（与网关 capabilities.json 对齐；planned 的能力是给后续集成留的口子）。 */
export const TOOLBOX_CAPABILITIES = [
  { id: "smart_erase", name: "智能擦除" },
  { id: "video_enhance", name: "视频修复增强" },
  { id: "matting", name: "人物抠像换背景" },
  { id: "translate_dub", name: "视频翻译配音" },
  { id: "lip_sync", name: "口型重新同步" },
  { id: "motion_transfer", name: "人物动作迁移" },
] as const;

export type CapabilityId = (typeof TOOLBOX_CAPABILITIES)[number]["id"];

export function capabilityName(id: string): string {
  return TOOLBOX_CAPABILITIES.find((c) => c.id === id)?.name ?? id;
}

/** 首帧框选区域：相对视频画面的归一化坐标（0-1）。 */
export type ToolboxRegion = {
  x: number;
  y: number;
  w: number;
  h: number;
};

const TERMINAL_STATUSES: JobStatus[] = ["succeeded", "failed", "canceled"];

export function isTerminalStatus(status: JobStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

const VIDEO_EXTENSIONS = [".mp4", ".webm", ".mov", ".mkv", ".avi"];

/** 从产物列表中挑出主视频（用于卡片内预览），其余作为附件下载展示。 */
export function primaryVideoArtifact(
  artifacts: JobArtifact[],
): JobArtifact | undefined {
  return (
    artifacts.find((a) =>
      VIDEO_EXTENSIONS.some((ext) => a.name.toLowerCase().endsWith(ext)),
    ) ?? artifacts[0]
  );
}
