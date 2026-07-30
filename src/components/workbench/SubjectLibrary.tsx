"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeftIcon, CheckIcon, ImageIcon, LoaderCircleIcon, PencilIcon, PlusIcon, SearchIcon, Trash2Icon, UploadIcon, UserRoundIcon, UsersIcon, XIcon } from "lucide-react";
import { useAuiState } from "@assistant-ui/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { useImage2Mode, type SubjectLibraryTab } from "@/lib/image2-mode";
import type { MonoSubjectVisibility } from "@/lib/mono/contracts";
import {
  createProductModelCardFromSource,
  createProductModelPairClient,
  createSubjectFromSource,
  deleteProductModelCardClient,
  deleteProductModelPairClient,
  deleteSubjectClient,
  downloadImageSource,
  loadProductModelLibrary,
  updateProductModelCardClient,
  updateProductModelPairClient,
  updateSubjectClient,
  useMonoSubjectCatalog,
  type MonoSubjectView,
  type ProductModelCardView,
  type ProductModelPairView,
} from "@/lib/mono/subject-client";

type ComposerAttachment = { id: string; name: string; file?: File };
type SubjectSource =
  | { key: string; label: string; file: File; url?: never }
  | { key: string; label: string; url: string; transferUrl?: string; file?: never };

export function SubjectLibrarySheet() {
  const open = useImage2Mode((state) => state.subjectLibraryOpen);
  const slot = useImage2Mode((state) => state.subjectLibrarySlot);
  const close = useImage2Mode((state) => state.closeSubjectLibrary);
  const selectedTab = useImage2Mode((state) => state.subjectLibraryTab);
  const setSelectedTab = useImage2Mode((state) => state.setSubjectLibraryTab);
  const setStructuredSubject = useImage2Mode((state) => state.setStructuredSubject);
  const attachments = useAuiState((state) => state.composer.attachments) as readonly ComposerAttachment[];
  const subjects = useMonoSubjectCatalog((state) => state.subjects);
  const loading = useMonoSubjectCatalog((state) => state.loading);
  const error = useMonoSubjectCatalog((state) => state.error);
  const load = useMonoSubjectCatalog((state) => state.load);
  const upsert = useMonoSubjectCatalog((state) => state.upsert);
  const remove = useMonoSubjectCatalog((state) => state.remove);
  const [historySources, setHistorySources] = useState<SubjectSource[]>([]);
  const [name, setName] = useState("");
  const [visibility, setVisibility] = useState<MonoSubjectVisibility>("private");
  const [source, setSource] = useState<SubjectSource>();
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string>();
  const fileInput = useRef<HTMLInputElement>(null);
  const wasOpen = useRef(false);
  const activeTab: SubjectLibraryTab = slot === undefined ? selectedTab : "subjects";

  useEffect(() => {
    if (wasOpen.current && !open) {
      window.dispatchEvent(new Event("workbench:subject-library-closed"));
    }
    wasOpen.current = open;
  }, [open]);

  useEffect(() => {
    if (!open) return;
    void load(true);
    let disposed = false;
    void fetch("/api/workbench/mono/assets?origin=generated&limit=24", { cache: "no-store" })
      .then((response) => response.json())
      .then((payload: { assets?: Array<{ assetId: string; name?: string; previewUrl: string }> }) => {
        if (disposed) return;
        const sources: SubjectSource[] = (payload.assets ?? []).slice(0, 12).map((asset) => ({
          key: asset.assetId,
          label: asset.name || "历史生成图片",
          url: asset.previewUrl,
          transferUrl: asset.previewUrl,
        }));
        setHistorySources(sources);
      })
      .catch(() => setHistorySources([]));
    return () => { disposed = true; };
  }, [open, load]);

  const currentSources = useMemo<SubjectSource[]>(() => attachments
    .filter((attachment): attachment is ComposerAttachment & { file: File } => attachment.file instanceof File)
    .map((attachment) => ({ key: attachment.id, label: attachment.name, file: attachment.file })), [attachments]);

  const create = async () => {
    if (!source || !name.trim()) {
      setFormError("请填写主体名称并选择一张图片");
      return;
    }
    setSaving(true);
    setFormError(undefined);
    try {
      const sourceUrl = source.file ? await fileToDataUrl(source.file) : source.url;
      const subject = await createSubjectFromSource({
        name: name.trim(),
        sourceUrl,
        mimeType: source.file?.type || "image/*",
        visibility,
      });
      upsert(subject);
      setName("");
      setSource(undefined);
      if (slot !== undefined) {
        setStructuredSubject(slot, subject.id);
        close();
      }
    } catch (createError) {
      setFormError(createError instanceof Error ? createError.message : "主体创建失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={(next) => { if (!next) close(); }}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 sm:max-w-md">
        <SheetHeader className="pb-2">
          <SheetTitle>
            {slot === undefined
              ? activeTab === "models" ? "主体库 · 模特卡" : activeTab === "pairs" ? "主体库 · 模特组合" : "主体库"
              : `为${slot === 0 ? "产品图" : "参考图"}选择主体`}
          </SheetTitle>
          <SheetDescription>
            {slot !== undefined
              ? "主体使用一张主图，可在普通模板中通过 @ 引用。"
              : activeTab === "models"
                ? "保存商品套图要复用的模特锚点图；不会触发生图。"
                : activeTab === "pairs"
                  ? "一位女模特加一位男模特，供商品套图在 A/C 与 B 槽位中复用。"
                  : "主体使用一张主图，可在普通模板中通过 @ 引用。"}
          </SheetDescription>
        </SheetHeader>

        {slot === undefined ? (
          <div className="border-b px-4 pb-3">
            <div className="bg-muted inline-flex rounded-lg p-0.5 text-sm">
              {(["subjects", "models", "pairs"] as const).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => setSelectedTab(tab)}
                  className={cn("rounded-md px-3 py-1.5", activeTab === tab && "bg-background shadow-sm")}
                >
                  {tab === "subjects" ? "普通主体" : tab === "models" ? "模特卡" : "模特组合"}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        <div className={cn("border-b px-4 pb-4", activeTab !== "subjects" && "hidden")}>
          <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
            <Input value={name} maxLength={40} onChange={(event) => setName(event.target.value)} placeholder="主体名称" className="min-w-0" />
            <input
              ref={fileInput}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file && !file.type.startsWith("image/")) setFormError("请选择图片文件");
                else if (file && file.size > 20 * 1024 * 1024) setFormError("主体图片不能超过 20MB");
                else if (file) {
                  setFormError(undefined);
                  setSource({ key: `upload:${file.name}:${file.lastModified}`, label: file.name, file });
                }
                event.target.value = "";
              }}
            />
            <Button variant="outline" onClick={() => fileInput.current?.click()}><UploadIcon />上传</Button>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <div className="bg-muted flex rounded-lg p-0.5 text-xs">
              <button type="button" onClick={() => setVisibility("private")} className={cn("rounded-md px-2.5 py-1", visibility === "private" && "bg-background shadow-sm")}>仅自己</button>
              <button type="button" onClick={() => setVisibility("workspace")} className={cn("rounded-md px-2.5 py-1", visibility === "workspace" && "bg-background shadow-sm")}>工作区共享</button>
            </div>
            <Button size="sm" className="ml-auto" onClick={() => void create()} disabled={saving || !source || !name.trim()}>
              {saving ? <LoaderCircleIcon className="animate-spin" /> : <CheckIcon />}
              创建主体
            </Button>
          </div>
          {source ? <p className="text-muted-foreground mt-2 truncate text-xs">已选择：{source.label}</p> : null}
          {formError ? <p className="text-destructive mt-2 text-xs">{formError}</p> : null}

          <SourceStrip title="当前参考图" sources={currentSources} selected={source?.key} onSelect={setSource} />
          <SourceStrip title="最近生成" sources={historySources} selected={source?.key} onSelect={setSource} />
        </div>

        <div className={cn("flex-1 overflow-y-auto px-4 py-3", activeTab !== "subjects" && "hidden")}>
          {loading && subjects.length === 0 ? (
            <p className="text-muted-foreground flex items-center gap-2 py-8 text-sm"><LoaderCircleIcon className="size-4 animate-spin" />正在加载主体库…</p>
          ) : error && subjects.length === 0 ? (
            <p className="text-destructive py-8 text-sm">{error}</p>
          ) : subjects.length === 0 ? (
            <p className="text-muted-foreground py-8 text-sm">还没有主体。上传图片，或者从当前参考图与生成历史中创建。</p>
          ) : (
            <div className="space-y-2">
              {subjects.map((subject) => (
                <SubjectRow
                  key={subject.id}
                  subject={subject}
                  selectable={slot !== undefined}
                  onSelect={() => {
                    if (slot === undefined) return;
                    setStructuredSubject(slot, subject.id);
                    close();
                  }}
                  onUpdated={upsert}
                  onDeleted={() => {
                    remove(subject.id);
                    const mode = useImage2Mode.getState();
                    mode.structuredSubjectIds.forEach((subjectId, index) => {
                      if (subjectId === subject.id) mode.setStructuredSubject(index as 0 | 1, undefined);
                    });
                  }}
                />
              ))}
            </div>
          )}
        </div>
        {activeTab !== "subjects" ? (
          <ProductModelLibraryPanel
            tab={activeTab}
            currentSources={currentSources}
            historySources={historySources}
            onChanged={() => window.dispatchEvent(new Event("workbench:model-library-changed"))}
          />
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

/**
 * Product-set identity management lives in the same sheet as ordinary
 * subjects, but uses its own typed backend contract. This deliberately avoids
 * mixing a model card's gender/pairing rules into generic Image2 subjects.
 */
function ProductModelLibraryPanel({
  tab,
  currentSources,
  historySources,
  onChanged,
}: {
  tab: Exclude<SubjectLibraryTab, "subjects">;
  currentSources: SubjectSource[];
  historySources: SubjectSource[];
  onChanged: () => void;
}) {
  const [models, setModels] = useState<ProductModelCardView[]>([]);
  const [pairs, setPairs] = useState<ProductModelPairView[]>([]);
  const [loadingModels, setLoadingModels] = useState(true);
  const [error, setError] = useState<string>();
  const [editingModel, setEditingModel] = useState<ProductModelCardView | null>();
  const [pairName, setPairName] = useState("");
  const [femaleSubjectId, setFemaleSubjectId] = useState("");
  const [maleSubjectId, setMaleSubjectId] = useState("");
  const [editingPairId, setEditingPairId] = useState<string>();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const catalog = await loadProductModelLibrary();
        if (cancelled) return;
        setModels(catalog.models);
        setPairs(catalog.pairs);
        setFemaleSubjectId((current) => current || catalog.models.find((model) => model.groupId === "female")?.subjectId || "");
        setMaleSubjectId((current) => current || catalog.models.find((model) => model.groupId === "male")?.subjectId || "");
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : "模特库加载失败");
      } finally {
        if (!cancelled) setLoadingModels(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const savePair = async () => {
    if (!pairName.trim() || !femaleSubjectId || !maleSubjectId) {
      setError("请命名组合，并各选择一位女模特和男模特");
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      const input = { displayName: pairName.trim(), femaleSubjectId, maleSubjectId };
      const pair = editingPairId
        ? await updateProductModelPairClient(editingPairId, input)
        : await createProductModelPairClient(input);
      setPairs((current) => [pair, ...current.filter((item) => item.id !== pair.id)]);
      setPairName("");
      setEditingPairId(undefined);
      onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "模特组合创建失败");
    } finally {
      setSaving(false);
    }
  };

  const femaleModels = models.filter((model) => model.groupId === "female");
  const maleModels = models.filter((model) => model.groupId === "male");

  if (tab === "models" && editingModel !== undefined) {
    return (
      <ModelEditor
        model={editingModel}
        currentSources={currentSources}
        historySources={historySources}
        onBack={() => setEditingModel(undefined)}
        onSaved={(model) => {
          setModels((current) => [model, ...current.filter((item) => item.id !== model.id)]);
          setEditingModel(undefined);
          onChanged();
        }}
      />
    );
  }

  return (
    <div className="flex-1 overflow-y-auto px-4 py-4">
      {tab === "models" ? (
        <>
          <div className="mb-3 flex items-center justify-between">
            <span className="text-muted-foreground text-xs">{models.length} 位模特</span>
            <Button size="sm" onClick={() => setEditingModel(null)}><PlusIcon />新增模特</Button>
          </div>
          <section>
            <div className="mb-2 flex items-center justify-between">
              <p className="text-sm font-medium">模特卡</p>
            </div>
            {loadingModels ? <LoadingLine /> : models.length ? (
              <div className="grid grid-cols-2 gap-2">
                {models.map((model) => (
                  <ModelCard
                    key={model.id}
                    model={model}
                    onEdit={() => setEditingModel(model)}
                    onDelete={async () => {
                      setError(undefined);
                      try {
                        await deleteProductModelCardClient(model.id);
                        setModels((current) => current.filter((item) => item.id !== model.id));
                        onChanged();
                      } catch (reason) {
                        setError(reason instanceof Error ? reason.message : "模特卡删除失败");
                      }
                    }}
                  />
                ))}
              </div>
            ) : <EmptyLine text="还没有模特。商品套图仍可使用自动模特。" />}
          </section>
        </>
      ) : (
        <>
          <section className="space-y-3 rounded-xl border p-3">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium">{editingPairId ? "编辑组合" : "新建组合"}</p>
              {editingPairId ? (
                <Button variant="ghost" size="xs" onClick={() => {
                  setEditingPairId(undefined);
                  setPairName("");
                }}><XIcon />取消</Button>
              ) : null}
            </div>
            <Input value={pairName} maxLength={40} onChange={(event) => setPairName(event.target.value)} placeholder="组合名称，例如：通勤组合 01" />
            <ModelSelect label="女模特（用于 A / C）" value={femaleSubjectId} models={femaleModels} onChange={setFemaleSubjectId} />
            <ModelSelect label="男模特（用于 B）" value={maleSubjectId} models={maleModels} onChange={setMaleSubjectId} />
            <Button className="w-full" onClick={() => void savePair()} disabled={saving || !pairName.trim() || !femaleSubjectId || !maleSubjectId}>
              {saving ? <LoaderCircleIcon className="animate-spin" /> : <UsersIcon />}{editingPairId ? "保存修改" : "保存组合"}
            </Button>
          </section>

          <section className="mt-4">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-sm font-medium">商品套图可用组合</p>
              <span className="text-muted-foreground text-xs">{pairs.length} 组</span>
            </div>
            {loadingModels ? <LoadingLine /> : pairs.length ? (
              <div className="space-y-2">
                {pairs.map((pair) => (
                  <ModelPairCard
                    key={pair.id}
                    pair={pair}
                    onEdit={() => {
                      setEditingPairId(pair.id);
                      setPairName(pair.displayName);
                      setFemaleSubjectId(pair.female.subjectId);
                      setMaleSubjectId(pair.male.subjectId);
                    }}
                    onDelete={async () => {
                      setError(undefined);
                      try {
                        await deleteProductModelPairClient(pair.id);
                        setPairs((current) => current.filter((item) => item.id !== pair.id));
                        onChanged();
                      } catch (reason) {
                        setError(reason instanceof Error ? reason.message : "模特组合删除失败");
                      }
                    }}
                  />
                ))}
              </div>
            ) : <EmptyLine text="先在“模特卡”中各创建一位女模特和男模特。" />}
          </section>
        </>
      )}
      {error ? <p className="text-destructive mt-3 text-sm">{error}</p> : null}
    </div>
  );
}

function ModelEditor({
  model,
  currentSources,
  historySources,
  onBack,
  onSaved,
}: {
  model: ProductModelCardView | null;
  currentSources: SubjectSource[];
  historySources: SubjectSource[];
  onBack: () => void;
  onSaved: (model: ProductModelCardView) => void;
}) {
  const [displayName, setDisplayName] = useState(model?.displayName ?? "");
  const [groupId, setGroupId] = useState<"female" | "male">(model?.groupId ?? "female");
  const [faceSource, setFaceSource] = useState<SubjectSource>();
  const [bodyFile, setBodyFile] = useState<File>();
  const [removeBody, setRemoveBody] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const faceInput = useRef<HTMLInputElement>(null);
  const bodyInput = useRef<HTMLInputElement>(null);
  const bodyPreview = useObjectUrl(bodyFile);

  const save = async () => {
    if (!displayName.trim() || (!model && !faceSource)) {
      setError("请填写名称并选择脸部图");
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      const rawFace = faceSource ? await sourceToFile(faceSource, `${displayName}-face.jpg`) : undefined;
      const faceFile = rawFace ? await cropImageToSquare(rawFace) : undefined;
      const saved = model
        ? await updateProductModelCardClient(model.id, {
          displayName: displayName.trim(),
          groupId,
          faceFile,
          bodyFile,
          removeBody,
        })
        : await createProductModelCardFromSource({
          displayName: displayName.trim(),
          groupId,
          faceFile,
          bodyFile,
        });
      onSaved(saved);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "模特保存失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto px-4 py-4">
      <button type="button" onClick={onBack} className="text-muted-foreground mb-4 flex items-center gap-1 text-sm hover:text-foreground">
        <ArrowLeftIcon className="size-4" />返回模特卡
      </button>
      <div className="space-y-4">
        <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
          <Input value={displayName} maxLength={40} onChange={(event) => setDisplayName(event.target.value)} placeholder="模特名称" />
          <select
            value={groupId}
            onChange={(event) => setGroupId(event.target.value as "female" | "male")}
            className="border-input bg-background rounded-md border px-2 text-sm"
          >
            <option value="female">女模特</option>
            <option value="male">男模特</option>
          </select>
        </div>

        <section className="rounded-xl border p-3">
          <div className="flex items-start gap-3">
            <div className="bg-muted size-24 shrink-0 overflow-hidden rounded-xl">
              <FacePreview source={faceSource} fallbackAssetId={model?.faceAssetId || model?.anchorAssetId} />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">脸部图 <span className="text-destructive">*</span></p>
              <p className="text-muted-foreground mt-1 text-xs">只用于身份；保存时自动裁成方形。</p>
              <input
                ref={faceInput}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) setFaceSource({ key: `face:${file.name}:${file.lastModified}`, label: file.name, file });
                  event.target.value = "";
                }}
              />
              <Button variant="outline" size="sm" className="mt-3" onClick={() => faceInput.current?.click()}>
                <UploadIcon />{model ? "替换脸部图" : "上传脸部图"}
              </Button>
            </div>
          </div>
          <SourceStrip title="也可从当前参考图选择" sources={currentSources} selected={faceSource?.key} onSelect={setFaceSource} />
          <SourceStrip title="最近生成" sources={historySources} selected={faceSource?.key} onSelect={setFaceSource} />
        </section>

        <section className="rounded-xl border p-3">
          <div className="flex items-start gap-3">
            <div className="bg-muted size-20 shrink-0 overflow-hidden rounded-xl">
              {bodyPreview || (model?.bodyAssetId && !removeBody)
                ? (
                  <>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={bodyPreview || modelAssetUrl(model!.bodyAssetId!)} alt="" className="size-full object-cover" />
                  </>
                )
                : <UserRoundIcon className="text-muted-foreground m-auto mt-6 size-7" />}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">中性全身图 <span className="text-muted-foreground font-normal">可选</span></p>
              <p className="text-muted-foreground mt-1 text-xs">建议正面站立、背景简单，仅表达体型倾向。</p>
              <input
                ref={bodyInput}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) {
                    setBodyFile(file);
                    setRemoveBody(false);
                  }
                  event.target.value = "";
                }}
              />
              <div className="mt-3 flex gap-2">
                <Button variant="outline" size="sm" onClick={() => bodyInput.current?.click()}>
                  <UploadIcon />{model?.bodyAssetId || bodyFile ? "替换" : "添加"}
                </Button>
                {model?.bodyAssetId || bodyFile ? (
                  <Button variant="ghost" size="sm" onClick={() => {
                    setBodyFile(undefined);
                    setRemoveBody(true);
                  }}><Trash2Icon />移除</Button>
                ) : null}
              </div>
            </div>
          </div>
        </section>

        {model?.needsFaceRecrop && !faceSource ? (
          <p className="text-muted-foreground rounded-lg bg-muted px-3 py-2 text-xs">旧模特建议重新选择脸部图并确认裁剪。</p>
        ) : null}
        {error ? <p className="text-destructive text-sm">{error}</p> : null}
        <Button className="w-full" onClick={() => void save()} disabled={saving || !displayName.trim() || (!model && !faceSource)}>
          {saving ? <LoaderCircleIcon className="animate-spin" /> : <CheckIcon />}保存模特
        </Button>
      </div>
    </div>
  );
}

function FacePreview({ source, fallbackAssetId }: { source?: SubjectSource; fallbackAssetId?: string }) {
  const preview = useOptionalSourcePreview(source);
  if (preview || fallbackAssetId) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={preview || modelAssetUrl(fallbackAssetId!)} alt="" className="size-full object-cover" />;
  }
  return <UserRoundIcon className="text-muted-foreground m-auto mt-8 size-8" />;
}

function ModelSelect({ label, value, models, onChange }: {
  label: string;
  value: string;
  models: ProductModelCardView[];
  onChange: (value: string) => void;
}) {
  const [query, setQuery] = useState("");
  const filtered = models.filter((model) => model.displayName.toLowerCase().includes(query.trim().toLowerCase()));
  return (
    <div className="space-y-1.5">
      <span className="text-muted-foreground text-xs">{label}</span>
      {models.length > 4 ? (
        <div className="relative">
          <SearchIcon className="text-muted-foreground absolute left-2.5 top-2.5 size-4" />
          <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索模特" className="pl-8" />
        </div>
      ) : null}
      <div className="grid grid-cols-2 gap-2">
        {filtered.map((model) => (
          <button
            key={model.subjectId}
            type="button"
            onClick={() => onChange(model.subjectId)}
            className={cn(
              "flex items-center gap-2 rounded-lg border p-1.5 text-left",
              value === model.subjectId && "border-primary bg-primary/5 ring-primary/20 ring-2",
            )}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={modelAssetUrl(model.faceAssetId || model.anchorAssetId)} alt="" className="size-10 rounded-md object-cover" />
            <span className="min-w-0 flex-1 truncate text-sm">{model.displayName}</span>
            {value === model.subjectId ? <CheckIcon className="text-primary size-4 shrink-0" /> : null}
          </button>
        ))}
      </div>
      {!filtered.length ? <p className="text-muted-foreground py-2 text-xs">没有可选模特</p> : null}
    </div>
  );
}

function ModelCard({ model, onEdit, onDelete }: {
  model: ProductModelCardView;
  onEdit: () => void;
  onDelete: () => Promise<void>;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  return (
    <div className="group relative overflow-hidden rounded-xl border">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={modelAssetUrl(model.faceAssetId || model.anchorAssetId)} alt="" className="aspect-square w-full object-cover" />
      <div className="p-2">
        <p className="truncate text-sm font-medium">{model.displayName}</p>
        <div className="mt-1 flex items-center justify-between">
          <p className="text-muted-foreground flex items-center gap-1 text-xs">
            <UserRoundIcon className="size-3" />{model.groupId === "female" ? "女模特" : "男模特"}
            {model.bodyAssetId ? " · 有全身参考" : " · 仅脸部"}
          </p>
          <span className="flex">
            <Button variant="ghost" size="icon-xs" title="编辑模特" onClick={onEdit}><PencilIcon /></Button>
            <Button
              variant={confirmDelete ? "destructive" : "ghost"}
              size={confirmDelete ? "xs" : "icon-xs"}
              title="删除模特"
              onClick={() => {
                if (!confirmDelete) {
                  setConfirmDelete(true);
                  return;
                }
                void onDelete();
              }}
            ><Trash2Icon />{confirmDelete ? "确认" : null}</Button>
          </span>
        </div>
      </div>
    </div>
  );
}

function ModelPairCard({ pair, onEdit, onDelete }: {
  pair: ProductModelPairView;
  onEdit: () => void;
  onDelete: () => Promise<void>;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  return (
    <div className="flex items-center gap-3 rounded-xl border p-2.5">
      <span className="flex shrink-0 -space-x-2">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={modelAssetUrl(pair.female.faceAssetId || pair.female.anchorAssetId)} alt="" className="size-11 rounded-lg object-cover ring-2 ring-background" />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={modelAssetUrl(pair.male.faceAssetId || pair.male.anchorAssetId)} alt="" className="size-11 rounded-lg object-cover ring-2 ring-background" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{pair.displayName}</p>
        <p className="text-muted-foreground truncate text-xs">女：{pair.female.displayName} · 男：{pair.male.displayName}</p>
      </div>
      <Button variant="ghost" size="icon-xs" title="编辑组合" onClick={onEdit}><PencilIcon /></Button>
      <Button
        variant={confirmDelete ? "destructive" : "ghost"}
        size={confirmDelete ? "xs" : "icon-xs"}
        title="删除组合"
        onClick={() => {
          if (!confirmDelete) {
            setConfirmDelete(true);
            return;
          }
          void onDelete();
        }}
      ><Trash2Icon />{confirmDelete ? "确认" : null}</Button>
    </div>
  );
}

function LoadingLine() {
  return <p className="text-muted-foreground flex items-center gap-2 py-8 text-sm"><LoaderCircleIcon className="size-4 animate-spin" />正在加载模特库…</p>;
}

function EmptyLine({ text }: { text: string }) {
  return <p className="text-muted-foreground rounded-xl bg-muted/50 p-4 text-sm">{text}</p>;
}

function SourceStrip({ title, sources, selected, onSelect }: {
  title: string;
  sources: SubjectSource[];
  selected?: string;
  onSelect: (source: SubjectSource) => void;
}) {
  if (!sources.length) return null;
  return (
    <div className="mt-3">
      <p className="text-muted-foreground mb-1.5 text-xs">{title}</p>
      <div className="flex gap-1.5 overflow-x-auto pb-1">
        {sources.map((source) => <SourceButton key={source.key} source={source} selected={selected === source.key} onClick={() => onSelect(source)} />)}
      </div>
    </div>
  );
}

function SourceButton({ source, selected, onClick }: { source: SubjectSource; selected: boolean; onClick: () => void }) {
  const preview = useSourcePreview(source);
  return (
    <button type="button" onClick={onClick} title={source.label} className={cn("relative size-14 shrink-0 overflow-hidden rounded-lg border", selected && "ring-ring ring-2")}> 
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {preview ? <img src={preview} alt="" className="size-full object-cover" /> : <ImageIcon className="text-muted-foreground m-auto size-4" />}
    </button>
  );
}

function SubjectRow({ subject, selectable, onSelect, onUpdated, onDeleted }: {
  subject: MonoSubjectView;
  selectable: boolean;
  onSelect: () => void;
  onUpdated: (subject: MonoSubjectView) => void;
  onDeleted: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(subject.name);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [rowError, setRowError] = useState<string>();

  const update = async (patch: { name?: string; visibility?: MonoSubjectVisibility }) => {
    setBusy(true);
    setRowError(undefined);
    try {
      onUpdated(await updateSubjectClient(subject.id, patch));
    } catch (error) {
      setRowError(error instanceof Error ? error.message : "主体更新失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-3 rounded-xl border p-2.5">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={subject.previewUrl} alt="" className="size-12 rounded-lg object-cover" />
      <div className="min-w-0 flex-1">
        {editing ? (
          <form className="flex gap-1" onSubmit={(event) => { event.preventDefault(); if (draft.trim()) void update({ name: draft.trim() }).then(() => setEditing(false)); }}>
            <Input value={draft} maxLength={40} onChange={(event) => setDraft(event.target.value)} className="h-7" autoFocus />
            <Button type="submit" size="xs" disabled={busy}>保存</Button>
          </form>
        ) : <p className="truncate text-sm font-medium">{subject.name}</p>}
        <p className="text-muted-foreground mt-0.5 flex items-center gap-1 text-xs">
          {subject.visibility === "workspace" ? <><UsersIcon className="size-3" />工作区共享</> : "仅自己"}
        </p>
        {rowError ? <p className="text-destructive mt-1 text-xs">{rowError}</p> : null}
      </div>
      {selectable ? <Button size="xs" onClick={onSelect}>选择</Button> : null}
      {subject.editable ? (
        <div className="flex items-center">
          <Button variant="ghost" size="icon-xs" title="重命名" onClick={() => setEditing((value) => !value)}><PencilIcon /></Button>
          <Button variant="ghost" size="icon-xs" title={subject.visibility === "private" ? "共享到工作区" : "设为私有"} disabled={busy} onClick={() => void update({ visibility: subject.visibility === "private" ? "workspace" : "private" })}><UsersIcon /></Button>
          <Button
            variant={confirmDelete ? "destructive" : "ghost"}
            size={confirmDelete ? "xs" : "icon-xs"}
            title="删除主体"
            onClick={() => {
              if (!confirmDelete) { setConfirmDelete(true); return; }
              setBusy(true);
              setRowError(undefined);
              void deleteSubjectClient(subject.id)
                .then(onDeleted)
                .catch((error) => setRowError(error instanceof Error ? error.message : "主体删除失败"))
                .finally(() => setBusy(false));
            }}
          >
            <Trash2Icon />{confirmDelete ? "确认" : null}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function useSourcePreview(source: SubjectSource): string | undefined {
  const filePreview = useMemo(
    () => source.file ? URL.createObjectURL(source.file) : undefined,
    [source.file],
  );
  useEffect(() => {
    if (!filePreview) return;
    return () => URL.revokeObjectURL(filePreview);
  }, [filePreview]);
  return source.url ?? filePreview;
}

function useOptionalSourcePreview(source?: SubjectSource): string | undefined {
  const filePreview = useObjectUrl(source?.file);
  return source?.url ?? filePreview;
}

function useObjectUrl(file?: File): string | undefined {
  const preview = useMemo(() => file ? URL.createObjectURL(file) : undefined, [file]);
  useEffect(() => {
    if (!preview) return;
    return () => URL.revokeObjectURL(preview);
  }, [preview]);
  return preview;
}

function modelAssetUrl(assetId: string): string {
  return `/api/workbench/mono/assets/${encodeURIComponent(assetId)}/content`;
}

async function sourceToFile(source: SubjectSource, fallbackName: string): Promise<File> {
  return source.file ?? downloadImageSource(source.transferUrl ?? source.url, fallbackName);
}

async function cropImageToSquare(file: File): Promise<File> {
  const bitmap = await createImageBitmap(file);
  try {
    const edge = Math.min(bitmap.width, bitmap.height);
    const sourceX = Math.floor((bitmap.width - edge) / 2);
    const sourceY = Math.floor((bitmap.height - edge) / 2);
    const outputSize = Math.min(edge, 1024);
    const canvas = document.createElement("canvas");
    canvas.width = outputSize;
    canvas.height = outputSize;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("无法创建脸部裁剪");
    context.drawImage(bitmap, sourceX, sourceY, edge, edge, 0, 0, outputSize, outputSize);
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((value) => value ? resolve(value) : reject(new Error("脸部裁剪失败")), "image/jpeg", 0.92);
    });
    return new File([blob], `${file.name.replace(/\.[^.]+$/, "") || "model-face"}-square.jpg`, { type: "image/jpeg" });
  } finally {
    bitmap.close();
  }
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("读取图片失败"));
    reader.onerror = () => reject(new Error("读取图片失败"));
    reader.readAsDataURL(file);
  });
}
