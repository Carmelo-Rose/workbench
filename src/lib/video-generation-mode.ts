"use client";

import { create } from "zustand";

export const videoGenerationKinds = ["text-to-video", "image-to-video"] as const;
export const videoAspectRatios = ["16:9", "9:16", "1:1", "4:3", "3:4"] as const;
export const videoDurations = [5, 10] as const;
export const videoResolutions = ["480p", "720p"] as const;

export type VideoGenerationKind = (typeof videoGenerationKinds)[number];
export type VideoAspectRatio = (typeof videoAspectRatios)[number];
export type VideoDuration = (typeof videoDurations)[number];
export type VideoResolution = (typeof videoResolutions)[number];

export type VideoGenerationDraft = {
  kind: VideoGenerationKind;
  aspectRatio: VideoAspectRatio;
  durationSeconds: VideoDuration;
  resolution: VideoResolution;
  variants: number;
  model: string;
  firstFrame?: File;
  lastFrame?: File;
  /** Existing job assets are reusable without uploading their bytes again. */
  firstFrameAssetId?: string;
  lastFrameAssetId?: string;
};

const initialDraft = (): VideoGenerationDraft => ({
  kind: "image-to-video",
  aspectRatio: "16:9",
  durationSeconds: 5,
  resolution: "720p",
  variants: 1,
  model: "auto",
});

export function createVideoGenerationDraft(): VideoGenerationDraft {
  return initialDraft();
}

export function validateVideoGenerationDraft(draft: VideoGenerationDraft, prompt: string): string | undefined {
  if (draft.kind === "text-to-video" && !prompt.trim()) return "请先描述画面、动作和镜头语言。";
  if (draft.kind === "image-to-video" && !draft.firstFrame && !draft.firstFrameAssetId) return "图生视频需要先添加首帧。";
  return undefined;
}

function storageKey(workspaceId: string): string {
  return `workbench:video-generation:current:${workspaceId}`;
}

type VideoGenerationModeState = {
  active: boolean;
  submitting: boolean;
  draft: VideoGenerationDraft;
  currentJobId?: string;
  notice?: string;
  activate: () => void;
  deactivate: () => void;
  reset: () => void;
  setKind: (kind: VideoGenerationKind) => void;
  setAspectRatio: (aspectRatio: VideoAspectRatio) => void;
  setDurationSeconds: (durationSeconds: number) => void;
  setResolution: (resolution: string) => void;
  setVariants: (variants: number) => void;
  setModel: (model: string) => void;
  setFrame: (slot: "firstFrame" | "lastFrame", file?: File) => void;
  setCurrentJob: (workspaceId: string, jobId?: string) => void;
  restoreCurrentJob: (workspaceId: string) => void;
  restoreFromInput: (input: Record<string, unknown>) => string | undefined;
  showNotice: (notice: string) => void;
  clearNotice: () => void;
  setSubmitting: (submitting: boolean) => void;
};

export const useVideoGenerationMode = create<VideoGenerationModeState>((set) => ({
  active: false,
  submitting: false,
  draft: initialDraft(),
  activate: () => set({ active: true }),
  deactivate: () => set({ active: false }),
  reset: () => set({ active: false, submitting: false, draft: initialDraft(), currentJobId: undefined, notice: undefined }),
  setKind: (kind) => set((state) => ({
    draft: {
      ...state.draft,
      kind,
      ...(kind === "text-to-video" ? { firstFrame: undefined, lastFrame: undefined, firstFrameAssetId: undefined, lastFrameAssetId: undefined } : {}),
    },
  })),
  setAspectRatio: (aspectRatio) => set((state) => ({ draft: { ...state.draft, aspectRatio } })),
  setDurationSeconds: (durationSeconds) => set((state) => ({ draft: { ...state.draft, durationSeconds: durationSeconds as VideoDuration } })),
  setResolution: (resolution) => set((state) => ({ draft: { ...state.draft, resolution: resolution as VideoResolution } })),
  setVariants: (variants) => set((state) => ({ draft: { ...state.draft, variants } })),
  setModel: (model) => set((state) => ({ draft: { ...state.draft, model } })),
  setFrame: (slot, file) => set((state) => ({
    draft: {
      ...state.draft,
      [slot]: file,
      ...(slot === "firstFrame" ? { firstFrameAssetId: undefined } : { lastFrameAssetId: undefined }),
    },
  })),
  setCurrentJob: (workspaceId, jobId) => {
    if (typeof window !== "undefined") {
      if (jobId) window.localStorage.setItem(storageKey(workspaceId), jobId);
      else window.localStorage.removeItem(storageKey(workspaceId));
    }
    set({ currentJobId: jobId });
  },
  restoreCurrentJob: (workspaceId) => {
    if (typeof window === "undefined") return;
    const currentJobId = window.localStorage.getItem(storageKey(workspaceId)) ?? undefined;
    set({ currentJobId });
  },
  restoreFromInput: (input) => {
    const kind = input.mode === "text-to-video" ? "text-to-video" : "image-to-video";
    set({
      active: true,
      notice: undefined,
      draft: {
        kind,
        aspectRatio: typeof input.aspectRatio === "string" && videoAspectRatios.includes(input.aspectRatio as VideoAspectRatio)
          ? input.aspectRatio as VideoAspectRatio : "16:9",
        durationSeconds: Number(input.durationSeconds) as VideoDuration || 5,
        resolution: typeof input.resolution === "string" && videoResolutions.includes(input.resolution as VideoResolution)
          ? input.resolution as VideoResolution : "720p",
        variants: Number(input.variants) || 1,
        model: typeof input.model === "string" ? input.model : "auto",
        firstFrameAssetId: typeof input.firstFrameAssetId === "string" ? input.firstFrameAssetId : undefined,
        lastFrameAssetId: typeof input.lastFrameAssetId === "string" ? input.lastFrameAssetId : undefined,
      },
    });
    return typeof input.prompt === "string" ? input.prompt : undefined;
  },
  showNotice: (notice) => set({ notice }),
  clearNotice: () => set({ notice: undefined }),
  setSubmitting: (submitting) => set({ submitting }),
}));
