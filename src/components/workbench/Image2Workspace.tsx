"use client";

import {
  ChevronLeftIcon,
  ChevronRightIcon,
  ImagePlusIcon,
  LoaderCircleIcon,
  PlusIcon,
  SparklesIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { MonoImageBatchGallery, useMonoJobPolling } from "@/components/workbench/MonoImageBatch";
import type { MonoAsset, MonoImageGenerationInput, MonoJob } from "@/lib/mono/contracts";
import {
  MONO_IMAGE2_TEMPLATES,
  getMonoImage2Template,
  type MonoImage2StructuredMode,
} from "@/lib/mono/image2-templates";

const LAST_JOB_KEY = "mono:image2:last-job";
const TEMPLATE_REFS_KEY = "mono:image2:template-refs";
const MAX_FILE_BYTES = 20 * 1024 * 1024;

type ReferenceDraft = { id: string; assetId?: string; sourceUrl: string; name: string };

export function Image2Workspace() {
  const router = useRouter();
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>();
  const [prompt, setPrompt] = useState("");
  const [aspectRatio, setAspectRatio] = useState<MonoImageGenerationInput["aspectRatio"]>("9:16");
  const [variants, setVariants] = useState<MonoImageGenerationInput["variants"]>(1);
  const [references, setReferences] = useState<ReferenceDraft[]>([]);
  const [structured, setStructured] = useState<{ product?: ReferenceDraft; scene?: ReferenceDraft }>({});
  const [templateReferencesEnabled, setTemplateReferencesEnabled] = useState(() =>
    typeof window === "undefined" ? true : window.localStorage.getItem(TEMPLATE_REFS_KEY) !== "false",
  );
  const [isUploading, setIsUploading] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState("");
  const { job, setJob, connectionError, isCancelling, cancel } = useMonoJobPolling();
  const templateListRef = useRef<HTMLDivElement>(null);
  const activeTemplate = getMonoImage2Template(selectedTemplateId);

  useEffect(() => {
    const jobId = window.localStorage.getItem(LAST_JOB_KEY);
    if (!jobId) return;
    fetch(`/api/workbench/mono/jobs/${encodeURIComponent(jobId)}`, { cache: "no-store" })
      .then(async (response) => {
        const payload = await response.json() as { job?: MonoJob };
        if (response.ok && payload.job) setJob(payload.job);
      })
      .catch(() => undefined);
  }, [setJob]);

  const selectTemplate = (templateId: string) => {
    const template = getMonoImage2Template(templateId);
    if (!template) return;
    setSelectedTemplateId(template.id);
    setPrompt(template.prompt);
    if (template.aspectRatio) setAspectRatio(template.aspectRatio);
    setReferences([]);
    setStructured({});
    setJob(undefined);
    setError("");
  };

  const setTemplateReferences = (enabled: boolean) => {
    setTemplateReferencesEnabled(enabled);
    window.localStorage.setItem(TEMPLATE_REFS_KEY, String(enabled));
  };

  const uploadFiles = async (files: File[], slot?: "product" | "scene") => {
    const accepted = files.filter((file) => file.type.startsWith("image/") && file.size <= MAX_FILE_BYTES);
    if (!accepted.length) {
      setError("请选择不超过 20MB 的图片文件");
      return;
    }
    const room = slot ? 1 : Math.max(0, 6 - references.length - (activeTemplate?.referenceImageUrl && templateReferencesEnabled ? 1 : 0));
    if (!room) {
      setError("参考图最多 6 张");
      return;
    }
    setIsUploading(true);
    setError("");
    try {
      const uploaded = await Promise.all(accepted.slice(0, room).map(uploadAsset));
      if (slot) setStructured((current) => ({ ...current, [slot]: uploaded[0] }));
      else setReferences((current) => [...current, ...uploaded].slice(0, 6));
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "参考图上传失败");
    } finally {
      setIsUploading(false);
    }
  };

  const submit = async () => {
    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt) return setError("请输入提示词");
    if (activeTemplate?.structuredMode && (!structured.product?.assetId || !structured.scene?.assetId)) {
      return setError("请先上传产品图和参考图");
    }
    setIsSubmitting(true);
    setError("");
    try {
      const input: MonoImageGenerationInput = {
        prompt: trimmedPrompt,
        templateId: activeTemplate?.id,
        templateReferencesEnabled,
        referenceAssetIds: references.flatMap((reference) => reference.assetId ? [reference.assetId] : []),
        referenceImageUrls: references.flatMap((reference) => reference.assetId ? [] : [reference.sourceUrl]),
        structuredReferences: activeTemplate?.structuredMode ? {
          productAssetId: structured.product!.assetId!,
          sceneAssetId: structured.scene!.assetId!,
        } : undefined,
        aspectRatio,
        variants,
        idempotencyKey: crypto.randomUUID(),
      };
      const response = await fetch("/api/workbench/mono/generate/image", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      const payload = await response.json() as { job?: MonoJob; error?: string };
      if (!response.ok || !payload.job) throw new Error(payload.error || "图片生成任务提交失败");
      setJob(payload.job);
      window.localStorage.setItem(LAST_JOB_KEY, payload.job.id);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "图片生成任务提交失败");
    } finally {
      setIsSubmitting(false);
    }
  };

  const useAsReference = (imageUrl: string) => {
    if (activeTemplate?.structuredMode) return;
    setReferences((current) => [
      ...current,
      { id: crypto.randomUUID(), sourceUrl: imageUrl, name: "生成结果" },
    ].slice(0, 6));
    setJob(undefined);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-5 sm:px-6 lg:px-8">
        <div className="border-border flex items-end justify-between gap-4 border-b pb-3">
          <div>
            <p className="text-muted-foreground text-sm">Image2</p>
            <h1 className="text-xl font-semibold tracking-[-0.02em]">图像生成</h1>
          </div>
          <div className="bg-muted flex rounded-lg p-1 text-sm" role="tablist" aria-label="Image2 视图">
            <button className="bg-background rounded-md px-4 py-1.5 font-medium shadow-sm" role="tab" aria-selected="true">创作</button>
            <button className="text-muted-foreground cursor-not-allowed px-4 py-1.5" role="tab" aria-selected="false" disabled title="第二阶段开放">历史</button>
          </div>
        </div>

        <section aria-labelledby="image2-templates-title">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <h2 id="image2-templates-title" className="font-medium">试试这些模板</h2>
              <label className="text-muted-foreground mt-1 flex items-center gap-2 text-xs">
                <input type="checkbox" checked={templateReferencesEnabled} onChange={(event) => setTemplateReferences(event.target.checked)} />
                自动使用模板参考图
              </label>
            </div>
            <div className="flex gap-1">
              <Button variant="outline" size="icon-sm" aria-label="上一组模板" onClick={() => templateListRef.current?.scrollBy({ left: -520, behavior: "smooth" })}><ChevronLeftIcon /></Button>
              <Button variant="outline" size="icon-sm" aria-label="下一组模板" onClick={() => templateListRef.current?.scrollBy({ left: 520, behavior: "smooth" })}><ChevronRightIcon /></Button>
            </div>
          </div>
          <div ref={templateListRef} className="flex snap-x gap-3 overflow-x-auto pb-2">
            {MONO_IMAGE2_TEMPLATES.map((template) => (
              <button
                key={template.id}
                type="button"
                onClick={() => selectTemplate(template.id)}
                className={`bg-card w-48 shrink-0 snap-start overflow-hidden rounded-xl text-left transition-[box-shadow,transform] duration-200 hover:-translate-y-0.5 ${selectedTemplateId === template.id ? "ring-primary ring-2" : "border"}`}
              >
                {/* Static template assets are intentionally rendered without optimization inside a horizontal picker. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={template.thumbnailUrl} alt="" className="aspect-[4/3] w-full object-cover" />
                <span className="block p-3">
                  <strong className="block text-sm font-medium">{template.title}</strong>
                  <span className="text-muted-foreground mt-0.5 block text-xs">{template.description}</span>
                </span>
              </button>
            ))}
          </div>
        </section>

        <section className="bg-card rounded-xl border p-4 sm:p-5" aria-label="Image2 创作输入">
          {activeTemplate?.structuredMode ? (
            <div className="mb-4 grid gap-3 sm:grid-cols-2">
              <StructuredUpload label="产品图" value={structured.product} onFiles={(files) => void uploadFiles(files, "product")} onRemove={() => setStructured((current) => ({ ...current, product: undefined }))} />
              <StructuredUpload label={structuredSceneLabel(activeTemplate.structuredMode)} value={structured.scene} onFiles={(files) => void uploadFiles(files, "scene")} onRemove={() => setStructured((current) => ({ ...current, scene: undefined }))} />
            </div>
          ) : (
            <ReferenceStrip
              templateReference={templateReferencesEnabled ? activeTemplate?.referenceImageUrl : undefined}
              references={references}
              onFiles={(files) => void uploadFiles(files)}
              onRemove={(id) => setReferences((current) => current.filter((reference) => reference.id !== id))}
            />
          )}

          <textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="描述你想生成的画面…"
            className="min-h-32 w-full resize-y bg-transparent py-3 text-base leading-7 outline-none placeholder:text-muted-foreground"
          />
          <div className="border-border flex flex-wrap items-center gap-2 border-t pt-3">
            <span className="bg-muted flex h-9 items-center gap-1.5 rounded-full px-3 text-sm font-medium">
              <SparklesIcon className="size-3.5" />
              生成图片
              <button
                type="button"
                aria-label="退出生成图片模式"
                title="退出生成图片模式"
                onClick={() => router.push("/")}
                className="text-muted-foreground hover:bg-background hover:text-foreground -mr-1 flex size-5 items-center justify-center rounded-full transition-colors"
              >
                <XIcon className="size-3.5" />
              </button>
            </span>
            <SelectControl label="画面比例" value={aspectRatio} onChange={(value) => setAspectRatio(value as MonoImageGenerationInput["aspectRatio"])} options={["1:1", "3:4", "9:16", "4:3", "16:9"]} />
            <SelectControl label="生成张数" value={String(variants)} onChange={(value) => setVariants(Number(value) as MonoImageGenerationInput["variants"])} options={["1", "2", "4", "6"]} suffix=" 张" />
            <div className="ml-auto flex items-center gap-2">
              {isUploading ? <span className="text-muted-foreground flex items-center gap-1.5 text-xs"><LoaderCircleIcon className="size-3.5 animate-spin" />正在上传</span> : null}
              <Button onClick={() => void submit()} disabled={isSubmitting || isUploading || !prompt.trim()} className="rounded-full">
                {isSubmitting ? <LoaderCircleIcon className="animate-spin" /> : <SparklesIcon />}
                生成图片
              </Button>
            </div>
          </div>
        </section>

        {error ? <div className="bg-destructive/8 text-destructive rounded-lg px-4 py-3 text-sm">{error}</div> : null}
        {connectionError ? <div className="bg-muted text-muted-foreground rounded-lg px-4 py-3 text-sm">任务仍在后台执行，正在重新连接…</div> : null}

        {job ? (
          <section className="bg-card rounded-xl border p-4 sm:p-5" aria-labelledby="image2-results-title">
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <h2 id="image2-results-title" className="font-medium">生成结果</h2>
                <p className="text-muted-foreground mt-1 text-xs">{job.status === "succeeded" ? "生成完成" : job.status === "failed" ? job.error || "生成未完成" : job.status === "cancelled" ? "任务已停止" : "正在处理"}</p>
              </div>
              {job.status === "queued" || job.status === "running" ? (
                <Button variant="outline" size="sm" disabled={isCancelling} onClick={() => void cancel()}>{isCancelling ? "正在停止" : "停止"}</Button>
              ) : (
                <Button variant="outline" size="sm" onClick={() => void submit()}>再次生成</Button>
              )}
            </div>
            <MonoImageBatchGallery job={job} onUseAsReference={useAsReference} />
          </section>
        ) : null}
      </div>
    </div>
  );
}

function ReferenceStrip({ templateReference, references, onFiles, onRemove }: {
  templateReference?: string;
  references: ReferenceDraft[];
  onFiles: (files: File[]) => void;
  onRemove: (id: string) => void;
}) {
  return (
    <div className="mb-2 flex gap-2 overflow-x-auto empty:hidden">
      {templateReference ? <ReferenceTile reference={{ id: "template", sourceUrl: templateReference, name: "模板参考图" }} /> : null}
      {references.map((reference) => <ReferenceTile key={reference.id} reference={reference} onRemove={() => onRemove(reference.id)} />)}
      <label className="text-muted-foreground hover:bg-muted flex size-16 shrink-0 cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed text-[11px] transition-colors">
        <PlusIcon className="mb-1 size-4" />添加
        <input type="file" accept="image/*" multiple hidden onChange={(event) => onFiles(Array.from(event.target.files ?? []))} />
      </label>
    </div>
  );
}

function ReferenceTile({ reference, onRemove }: { reference: ReferenceDraft; onRemove?: () => void }) {
  return (
    <div className="relative size-16 shrink-0 overflow-hidden rounded-lg border bg-muted" title={reference.name}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={reference.sourceUrl} alt={reference.name} className="size-full object-cover" />
      {onRemove ? <button type="button" aria-label={`移除 ${reference.name}`} onClick={onRemove} className="absolute right-1 top-1 flex size-5 items-center justify-center rounded-full bg-black/65 text-white"><XIcon className="size-3" /></button> : null}
    </div>
  );
}

function StructuredUpload({ label, value, onFiles, onRemove }: {
  label: string;
  value?: ReferenceDraft;
  onFiles: (files: File[]) => void;
  onRemove: () => void;
}) {
  return value ? (
    <div className="relative overflow-hidden rounded-xl border bg-muted">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={value.sourceUrl} alt={label} className="aspect-[4/3] w-full object-contain" />
      <span className="absolute bottom-2 left-2 rounded-md bg-black/65 px-2 py-1 text-xs text-white">{label}</span>
      <button type="button" aria-label={`移除${label}`} onClick={onRemove} className="absolute right-2 top-2 flex size-7 items-center justify-center rounded-full bg-black/65 text-white"><XIcon className="size-4" /></button>
    </div>
  ) : (
    <label className="text-muted-foreground hover:bg-muted flex min-h-40 cursor-pointer flex-col items-center justify-center rounded-xl border border-dashed transition-colors">
      <ImagePlusIcon className="mb-2 size-6" />
      <span className="text-sm">上传{label}</span>
      <span className="mt-1 text-xs">PNG、JPG，最大 20MB</span>
      <input type="file" accept="image/*" hidden onChange={(event) => onFiles(Array.from(event.target.files ?? []))} />
    </label>
  );
}

function SelectControl({ label, value, options, onChange, suffix = "" }: {
  label: string;
  value: string;
  options: string[];
  onChange: (value: string) => void;
  suffix?: string;
}) {
  return (
    <label className="sr-only">
      {label}
      <select value={value} onChange={(event) => onChange(event.target.value)} className="not-sr-only bg-background h-9 rounded-full border px-3 text-sm outline-none focus:ring-2">
        {options.map((option) => <option key={option} value={option}>{option}{suffix}</option>)}
      </select>
    </label>
  );
}

function structuredSceneLabel(mode: MonoImage2StructuredMode) {
  return mode === "replace-product" ? "场景参考图" : "穿戴参考图";
}

async function uploadAsset(file: File): Promise<ReferenceDraft> {
  const sourceUrl = await fileToDataUrl(file);
  const response = await fetch("/api/workbench/mono/assets", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sourceUrl, mimeType: file.type, name: file.name }),
  });
  const payload = await response.json() as { asset?: MonoAsset; error?: string };
  if (!response.ok || !payload.asset) throw new Error(payload.error || `${file.name} 上传失败`);
  return { id: crypto.randomUUID(), assetId: payload.asset.id, sourceUrl, name: file.name };
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error(`${file.name} 读取失败`));
    reader.readAsDataURL(file);
  });
}
