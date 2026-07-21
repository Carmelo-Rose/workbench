"use client";

import { create } from "zustand";
import type { MonoImageGenerationInput } from "@/lib/mono/contracts";
import type { MonoImage2TemplateId } from "@/lib/mono/image2-templates";

/** 消息树深处的卡片交给主 composer 的待写入内容，见 assistant.tsx 的 Image2ModeSync。 */
export type PendingComposer = {
  text?: string;
  /** 有值时先清空现有附件再挂上，用于「再次生成」这类整体回填。 */
  files?: File[];
};

type Image2ModeState = {
  active: boolean;
  selectedTemplateId?: MonoImage2TemplateId;
  aspectRatio: MonoImageGenerationInput["aspectRatio"];
  variants: MonoImageGenerationInput["variants"];
  pendingComposer?: PendingComposer;
  structuredSubjectIds: [string | undefined, string | undefined];
  subjectLibraryOpen: boolean;
  subjectLibrarySlot?: 0 | 1;
  activate: () => void;
  activateWithPrompt: (prompt: string) => void;
  /** 工具卡片拿不到主 composer 的 ambient scope，只能经这里转交。 */
  handoffToComposer: (pending: PendingComposer) => void;
  consumePendingComposer: () => void;
  deactivate: () => void;
  reset: () => void;
  selectTemplate: (templateId: MonoImage2TemplateId) => void;
  setAspectRatio: (aspectRatio: MonoImageGenerationInput["aspectRatio"]) => void;
  setVariants: (variants: MonoImageGenerationInput["variants"]) => void;
  openSubjectLibrary: (slot?: 0 | 1) => void;
  closeSubjectLibrary: () => void;
  setStructuredSubject: (slot: 0 | 1, subjectId?: string) => void;
};

const defaults = {
  active: false,
  selectedTemplateId: undefined,
  aspectRatio: "9:16" as const,
  variants: 1 as const,
  pendingComposer: undefined,
  structuredSubjectIds: [undefined, undefined] as [string | undefined, string | undefined],
  subjectLibraryOpen: false,
  subjectLibrarySlot: undefined,
};

export const useImage2Mode = create<Image2ModeState>((set) => ({
  ...defaults,
  activate: () => set({ active: true }),
  activateWithPrompt: (text) => set({ active: true, pendingComposer: { text } }),
  handoffToComposer: (pendingComposer) => set({ pendingComposer }),
  consumePendingComposer: () => set({ pendingComposer: undefined }),
  deactivate: () => set({ active: false }),
  reset: () => set(defaults),
  selectTemplate: (selectedTemplateId) => set({ active: true, selectedTemplateId }),
  setAspectRatio: (aspectRatio) => set({ aspectRatio }),
  setVariants: (variants) => set({ variants }),
  openSubjectLibrary: (subjectLibrarySlot) => set({ subjectLibraryOpen: true, subjectLibrarySlot }),
  closeSubjectLibrary: () => set({ subjectLibraryOpen: false, subjectLibrarySlot: undefined }),
  setStructuredSubject: (slot, subjectId) => set((state) => {
    const structuredSubjectIds = [...state.structuredSubjectIds] as [string | undefined, string | undefined];
    structuredSubjectIds[slot] = subjectId;
    return { structuredSubjectIds };
  }),
}));

export type Image2ChatModeConfig = Pick<
  Image2ModeState,
  "active" | "selectedTemplateId" | "aspectRatio" | "variants" | "structuredSubjectIds"
>;
