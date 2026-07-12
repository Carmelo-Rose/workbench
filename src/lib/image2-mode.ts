"use client";

import { create } from "zustand";
import type { MonoImageGenerationInput } from "@/lib/mono/contracts";
import type { MonoImage2TemplateId } from "@/lib/mono/image2-templates";

type Image2ModeState = {
  active: boolean;
  selectedTemplateId?: MonoImage2TemplateId;
  aspectRatio: MonoImageGenerationInput["aspectRatio"];
  variants: MonoImageGenerationInput["variants"];
  /** 从消息树（如反推结果卡）跨组件交给 composer 的待写入文本，见 Image2ModeSync。 */
  pendingPrompt?: string;
  structuredSubjectIds: [string | undefined, string | undefined];
  subjectLibraryOpen: boolean;
  subjectLibrarySlot?: 0 | 1;
  activate: () => void;
  activateWithPrompt: (prompt: string) => void;
  consumePendingPrompt: () => void;
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
  pendingPrompt: undefined,
  structuredSubjectIds: [undefined, undefined] as [string | undefined, string | undefined],
  subjectLibraryOpen: false,
  subjectLibrarySlot: undefined,
};

export const useImage2Mode = create<Image2ModeState>((set) => ({
  ...defaults,
  activate: () => set({ active: true }),
  activateWithPrompt: (pendingPrompt) => set({ active: true, pendingPrompt }),
  consumePendingPrompt: () => set({ pendingPrompt: undefined }),
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
