"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { CheckIcon, ImageIcon, LoaderCircleIcon, PencilIcon, Trash2Icon, UploadIcon, UsersIcon } from "lucide-react";
import { useAuiState } from "@assistant-ui/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { useImage2Mode } from "@/lib/image2-mode";
import type { MonoImageGenerationSlot, MonoJob, MonoSubjectVisibility } from "@/lib/mono/contracts";
import {
  createSubjectFromSource,
  deleteSubjectClient,
  updateSubjectClient,
  useMonoSubjectCatalog,
  type MonoSubjectView,
} from "@/lib/mono/subject-client";

type ComposerAttachment = { id: string; name: string; file?: File };
type SubjectSource =
  | { key: string; label: string; file: File; url?: never }
  | { key: string; label: string; url: string; file?: never };

export function SubjectLibrarySheet() {
  const open = useImage2Mode((state) => state.subjectLibraryOpen);
  const slot = useImage2Mode((state) => state.subjectLibrarySlot);
  const close = useImage2Mode((state) => state.closeSubjectLibrary);
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

  useEffect(() => {
    if (!open) return;
    void load(true);
    let disposed = false;
    void fetch("/api/workbench/mono/jobs?kind=image_generation&limit=24", { cache: "no-store" })
      .then((response) => response.json())
      .then((payload: { jobs?: MonoJob[] }) => {
        if (disposed) return;
        const sources: SubjectSource[] = [];
        for (const job of payload.jobs ?? []) {
          const slots = (job.result as { slots?: MonoImageGenerationSlot[] } | null)?.slots ?? [];
          for (const result of slots) {
            if (result.status === "succeeded" && result.imageUrl) {
              sources.push({ key: `${job.id}:${result.index}`, label: "历史生成图片", url: result.imageUrl });
            }
            if (sources.length >= 12) break;
          }
          if (sources.length >= 12) break;
        }
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
          <SheetTitle>{slot === undefined ? "主体库" : `为${slot === 0 ? "产品图" : "参考图"}选择主体`}</SheetTitle>
          <SheetDescription>主体使用一张主图，可在普通模板中通过 @ 引用。</SheetDescription>
        </SheetHeader>

        <div className="border-b px-4 pb-4">
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

        <div className="flex-1 overflow-y-auto px-4 py-3">
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
      </SheetContent>
    </Sheet>
  );
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

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("读取图片失败"));
    reader.onerror = () => reject(new Error("读取图片失败"));
    reader.readAsDataURL(file);
  });
}
