"use client";

import { create } from "zustand";
import type { MonoImageGenerationInput } from "@/lib/mono/contracts";
import type { MonoImage2TemplateId } from "@/lib/mono/image2-templates";

type Image2ModeState = {
  active: boolean;
  selectedTemplateId?: MonoImage2TemplateId;
  aspectRatio: MonoImageGenerationInput["aspectRatio"];
  variants: MonoImageGenerationInput["variants"];
  activate: () => void;
  deactivate: () => void;
  reset: () => void;
  selectTemplate: (templateId: MonoImage2TemplateId) => void;
  setAspectRatio: (aspectRatio: MonoImageGenerationInput["aspectRatio"]) => void;
  setVariants: (variants: MonoImageGenerationInput["variants"]) => void;
};

const defaults = {
  active: false,
  selectedTemplateId: undefined,
  aspectRatio: "9:16" as const,
  variants: 1 as const,
};

export const useImage2Mode = create<Image2ModeState>((set) => ({
  ...defaults,
  activate: () => set({ active: true }),
  deactivate: () => set({ active: false }),
  reset: () => set(defaults),
  selectTemplate: (selectedTemplateId) => set({ active: true, selectedTemplateId }),
  setAspectRatio: (aspectRatio) => set({ aspectRatio }),
  setVariants: (variants) => set({ variants }),
}));

export type Image2ChatModeConfig = Pick<
  Image2ModeState,
  "active" | "selectedTemplateId" | "aspectRatio" | "variants"
>;
