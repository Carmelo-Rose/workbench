"use client";

import { create } from "zustand";
import type { MonoSubject, MonoSubjectVisibility } from "./contracts";

export type ProductModelCardView = {
  id: string;
  displayName: string;
  groupId: "female" | "male";
  sourceCandidateId: string;
  faceAssetId: string;
  bodyAssetId?: string;
  facePreviewUrl: string;
  bodyPreviewUrl?: string;
  /** @deprecated Compatibility alias for faceAssetId. */
  anchorAssetId: string;
  needsFaceRecrop: boolean;
  subjectId: string;
};

export type ProductModelPairView = {
  id: string;
  displayName: string;
  female: ProductModelCardView;
  male: ProductModelCardView;
};

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
  const file = await downloadImageSource(
    input.sourceUrl,
    `${input.name}.jpg`,
    input.mimeType,
  );
  const assetId = await uploadImageFile(file);
  const response = await fetch("/api/workbench/mono/subjects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: input.name, assetId, visibility: input.visibility }),
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

export async function loadProductModelLibrary(): Promise<{
  models: ProductModelCardView[];
  pairs: ProductModelPairView[];
}> {
  const response = await fetch("/api/workbench/mono/subjects/model-library", { cache: "no-store" });
  const payload = await response.json() as {
    models?: ProductModelCardView[];
    pairs?: ProductModelPairView[];
    error?: string;
  };
  if (!response.ok || !payload.models || !payload.pairs) {
    throw new Error(payload.error || "模特库加载失败");
  }
  return { models: payload.models, pairs: payload.pairs };
}

export async function createProductModelCardFromSource(input: {
  displayName: string;
  groupId: "female" | "male";
  faceFile?: File;
  faceUrl?: string;
  bodyFile?: File;
  bodyUrl?: string;
}): Promise<ProductModelCardView> {
  const faceFile = input.faceFile
    ?? await downloadImageSource(input.faceUrl, `${input.displayName}-face.jpg`);
  const faceAssetId = await uploadImageFile(faceFile);
  const bodyFile = input.bodyFile
    ?? (input.bodyUrl
      ? await downloadImageSource(input.bodyUrl, `${input.displayName}-body.jpg`)
      : undefined);
  const bodyAssetId = bodyFile ? await uploadImageFile(bodyFile) : undefined;

  const response = await fetch("/api/workbench/mono/subjects/model-library", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      displayName: input.displayName,
      groupId: input.groupId,
      faceAssetId,
      bodyAssetId,
      visibility: "workspace",
    }),
  });
  const payload = await response.json() as { model?: ProductModelCardView; error?: string };
  if (!response.ok || !payload.model) throw new Error(payload.error || "模特卡创建失败");
  return payload.model;
}

export async function updateProductModelCardClient(
  id: string,
  input: {
    displayName?: string;
    groupId?: "female" | "male";
    faceFile?: File;
    bodyFile?: File | null;
    removeBody?: boolean;
  },
): Promise<ProductModelCardView> {
  const faceAssetId = input.faceFile ? await uploadImageFile(input.faceFile) : undefined;
  const bodyAssetId = input.removeBody
    ? null
    : input.bodyFile
      ? await uploadImageFile(input.bodyFile)
      : undefined;
  const response = await fetch(
    `/api/workbench/mono/subjects/model-library/${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        displayName: input.displayName,
        groupId: input.groupId,
        faceAssetId,
        bodyAssetId,
      }),
    },
  );
  const payload = await response.json() as { model?: ProductModelCardView; error?: string };
  if (!response.ok || !payload.model) throw new Error(payload.error || "模特卡更新失败");
  return payload.model;
}

export async function deleteProductModelCardClient(id: string): Promise<void> {
  const response = await fetch(
    `/api/workbench/mono/subjects/model-library/${encodeURIComponent(id)}`,
    { method: "DELETE" },
  );
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(payload?.error || "模特卡删除失败");
  }
}

export async function downloadImageSource(
  sourceUrl: string | undefined,
  fallbackName = "image.jpg",
  fallbackMime = "image/jpeg",
): Promise<File> {
  if (!sourceUrl) throw new Error("请选择图片");
  const response = await fetch(sourceUrl);
  if (!response.ok) throw new Error(`无法读取所选图片（HTTP ${response.status}）`);
  const blob = await response.blob();
  const mimeType = blob.type || fallbackMime;
  const pathname = new URL(response.url || sourceUrl, window.location.href).pathname;
  const filename = decodeURIComponent(pathname.split("/").pop() || fallbackName);
  return new File([blob], filename, { type: mimeType });
}

async function uploadImageFile(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) throw new Error("请选择图片文件");
  if (file.size > 20 * 1024 * 1024) throw new Error("图片不能超过 20MB");
  const response = await fetch("/api/workbench/mono/uploads", {
    method: "POST",
    headers: {
      "Content-Type": file.type,
      "x-workbench-filename": encodeURIComponent(file.name || "image.jpg"),
    },
    body: file,
  });
  const payload = await response.json() as { asset?: { id: string }; error?: string };
  if (!response.ok || !payload.asset) throw new Error(payload.error || "图片保存失败");
  return payload.asset.id;
}

export async function createProductModelPairClient(input: {
  displayName: string;
  femaleSubjectId: string;
  maleSubjectId: string;
}): Promise<ProductModelPairView> {
  const response = await fetch("/api/workbench/mono/subjects/model-pairs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const payload = await response.json() as { pair?: ProductModelPairView; error?: string };
  if (!response.ok || !payload.pair) throw new Error(payload.error || "模特组合创建失败");
  return payload.pair;
}

export async function updateProductModelPairClient(
  id: string,
  input: {
    displayName?: string;
    femaleSubjectId?: string;
    maleSubjectId?: string;
  },
): Promise<ProductModelPairView> {
  const response = await fetch(
    `/api/workbench/mono/subjects/model-pairs/${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  const payload = await response.json() as { pair?: ProductModelPairView; error?: string };
  if (!response.ok || !payload.pair) throw new Error(payload.error || "模特组合更新失败");
  return payload.pair;
}

export async function deleteProductModelPairClient(id: string): Promise<void> {
  const response = await fetch(
    `/api/workbench/mono/subjects/model-pairs/${encodeURIComponent(id)}`,
    { method: "DELETE" },
  );
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(payload?.error || "模特组合删除失败");
  }
}
