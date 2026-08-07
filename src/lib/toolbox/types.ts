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

export type ToolboxCapability = {
  id: string;
  name: string;
  /** ready=可提交任务；planned=留口子未上线（UI 上灰显）。 */
  status: "ready" | "planned";
  /** true 表示提交前需要用户在卡片里操作（如首帧框选），因此不能被自动串联。 */
  interactive: boolean;
  /** 无交互能力的默认参数，串联提交时直接用。 */
  defaultParams?: Record<string, unknown>;
  description: string;
};

/**
 * 工具箱能力清单。
 *
 * 真源是网关侧的 gateway/capabilities.json，这张表是它在前端的镜像——加能力时
 * 两边都要改。（后续可以让前端改为经 /api/toolbox/capabilities 动态拉取、
 * 这张表退化成网关离线时的兜底，届时这条注释一并去掉。）
 */
export const TOOLBOX_CAPABILITIES: ToolboxCapability[] = [
  {
    id: "smart_erase",
    name: "智能擦除",
    status: "ready",
    interactive: true,
    description: "去除字幕、水印、台标、贴纸等固定区域内容",
  },
  {
    id: "video_enhance",
    name: "视频修复增强",
    status: "ready",
    interactive: false,
    defaultParams: { outscale: 4 },
    description: "分辨率放大、去噪、压缩伪影修复",
  },
  {
    id: "matting",
    name: "抠像换背景",
    status: "ready",
    interactive: false,
    // mode 留 auto：串联提交时没人来说这段视频里是人还是别的，交给适配器自己探。
    defaultParams: { background: "white", mode: "auto" },
    description: "视频抠像、替换背景（人物或任意主体）",
  },
  {
    id: "translate_dub",
    name: "视频翻译配音",
    status: "planned",
    interactive: false,
    description: "识别 → 翻译/改文案 → 配音 → 合成",
  },
  {
    id: "lip_sync",
    name: "口型重新同步",
    status: "planned",
    interactive: true,
    description: "按新配音重新生成口型",
  },
  {
    id: "motion_transfer",
    name: "人物动作迁移",
    status: "planned",
    interactive: true,
    description: "保留动作替换人物",
  },
];

export function capabilityName(id: string): string {
  return TOOLBOX_CAPABILITIES.find((c) => c.id === id)?.name ?? id;
}

/**
 * 能成为「串联下一步」候选的能力：已上线、无需卡片内交互（否则拿不到首帧
 * 底图去框选——网关的 poster 接口只对上传文件开放，任务产物没有），且不是
 * 当前这个能力自己。新能力上线后自动进入这个菜单，无需改这里。
 */
export function chainTargets(currentId: string): ToolboxCapability[] {
  return TOOLBOX_CAPABILITIES.filter(
    (c) => c.status === "ready" && !c.interactive && c.id !== currentId,
  );
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
