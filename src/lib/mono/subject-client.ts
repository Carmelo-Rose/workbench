"use client";

import { create } from "zustand";
import type { MonoSubject, MonoSubjectVisibility } from "./contracts";

export type MonoSubjectView = MonoSubject & {
  editable: boolean;
  previewUrl: string;
};

type SubjectCatalogState = {
  subjects: MonoSubjectView[];
  loading: boolean;
  loaded: boolean;
  error?: string;
  load: (force?: boolean) => Promise<void>;
  upsert: (subject: MonoSubjectView) => void;
  remove: (subjectId: string) => void;
};

export const useMonoSubjectCatalog = create<SubjectCatalogState>((set, get) => ({
  subjects: [],
  loading: false,
  loaded: false,
  load: async (force = false) => {
    if (get().loading || (get().loaded && !force)) return;
    set({ loading: true, error: undefined });
    try {
      const response = await fetch("/api/workbench/mono/subjects", { cache: "no-store" });
      const payload = await response.json() as { subjects?: MonoSubjectView[]; error?: string };
      if (!response.ok || !payload.subjects) throw new Error(payload.error || "主体库加载失败");
      set({ subjects: payload.subjects, loaded: true, loading: false });
    } catch (error) {
      set({ loading: false, error: error instanceof Error ? error.message : "主体库加载失败" });
    }
  },
  upsert: (subject) => set((state) => ({
    subjects: [subject, ...state.subjects.filter((item) => item.id !== subject.id)],
  })),
  remove: (subjectId) => set((state) => ({
    subjects: state.subjects.filter((item) => item.id !== subjectId),
  })),
}));

export async function createSubjectFromSource(input: {
  name: string;
  sourceUrl: string;
  mimeType?: string;
  visibility: MonoSubjectVisibility;
}): Promise<MonoSubjectView> {
  const assetResponse = await fetch("/api/workbench/mono/assets", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sourceUrl: input.sourceUrl, mimeType: input.mimeType, name: input.name }),
  });
  const assetPayload = await assetResponse.json() as { asset?: { id: string }; error?: string };
  if (!assetResponse.ok || !assetPayload.asset) throw new Error(assetPayload.error || "主体图片保存失败");
  const response = await fetch("/api/workbench/mono/subjects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: input.name, assetId: assetPayload.asset.id, visibility: input.visibility }),
  });
  const payload = await response.json() as { subject?: MonoSubjectView; error?: string };
  if (!response.ok || !payload.subject) throw new Error(payload.error || "主体创建失败");
  return payload.subject;
}

export async function updateSubjectClient(
  subjectId: string,
  patch: { name?: string; visibility?: MonoSubjectVisibility },
): Promise<MonoSubjectView> {
  const response = await fetch(`/api/workbench/mono/subjects/${encodeURIComponent(subjectId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  const payload = await response.json() as { subject?: MonoSubjectView; error?: string };
  if (!response.ok || !payload.subject) throw new Error(payload.error || "主体更新失败");
  return payload.subject;
}

export async function deleteSubjectClient(subjectId: string): Promise<void> {
  const response = await fetch(`/api/workbench/mono/subjects/${encodeURIComponent(subjectId)}`, { method: "DELETE" });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(payload?.error || "主体删除失败");
  }
}
