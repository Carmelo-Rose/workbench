"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { CheckIcon, HistoryIcon, ImageUpIcon, SparklesIcon, XIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useAui, useAuiState } from "@assistant-ui/react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { useImage2Mode } from "@/lib/image2-mode";
import { Image2HistorySheet } from "@/components/workbench/Image2History";
import { useMonoSubjectCatalog, type MonoSubjectView } from "@/lib/mono/subject-client";
import { monoAspectRatios, monoImageVariants } from "@/lib/mono/contracts";
import {
  MONO_IMAGE2_TEMPLATES,
  getMonoImage2Template,
  type MonoImage2Template,
} from "@/lib/mono/image2-templates";

type Aui = ReturnType<typeof useAui>;

/** 模板参考图以普通附件形式进入 composer，靠文件名前缀识别以便切换模板时替换。 */
const TEMPLATE_ATTACHMENT_PREFIX = "模板参考图";

async function removeTemplateReferenceAttachments(aui: Aui) {
  const { attachments } = aui.composer().getState();
  for (const attachment of attachments) {
    if (attachment.name.startsWith(TEMPLATE_ATTACHMENT_PREFIX)) {
      await aui.composer().attachment({ id: attachment.id }).remove();
    }
  }
}

async function addTemplateReferenceAttachment(aui: Aui, template: MonoImage2Template) {
  if (!template.referenceImageUrl) return;
  try {
    const response = await fetch(template.referenceImageUrl);
    const blob = await response.blob();
    const extension = blob.type.split("/")[1] || "png";
    const file = new File(
      [blob],
      `${TEMPLATE_ATTACHMENT_PREFIX}-${template.title}.${extension}`,
      { type: blob.type || "image/png" },
    );
    await aui.composer().addAttachment(file);
  } catch {
    // 参考图加载失败时静默跳过，用户仍可手动上传。
  }
}

export function useSelectImage2Template() {
  const aui = useAui();
  const currentTemplateId = useImage2Mode((state) => state.selectedTemplateId);
  const selectTemplate = useImage2Mode((state) => state.selectTemplate);
  const setAspectRatio = useImage2Mode((state) => state.setAspectRatio);
  const setStructuredSubject = useImage2Mode((state) => state.setStructuredSubject);

  return async (template: MonoImage2Template) => {
    const current = getMonoImage2Template(currentTemplateId);
    if (Boolean(current?.structuredMode) !== Boolean(template.structuredMode)) {
      await aui.composer().clearAttachments();
      setStructuredSubject(0, undefined);
      setStructuredSubject(1, undefined);
    } else {
      await removeTemplateReferenceAttachments(aui);
    }
    selectTemplate(template.id);
    if (template.aspectRatio) setAspectRatio(template.aspectRatio);
    aui.composer().setText(template.prompt);
    await addTemplateReferenceAttachment(aui, template);
  };
}

export function Image2TemplateRail() {
  const selectedTemplateId = useImage2Mode((state) => state.selectedTemplateId);
  const selectTemplate = useSelectImage2Template();

  return (
    <div className="aui-image2-template-rail w-full px-4">
      <div className="mx-auto flex max-w-(--thread-max-width) gap-2 overflow-x-auto pb-1 scrollbar-none">
        {MONO_IMAGE2_TEMPLATES.map((template) => (
          <button
            key={template.id}
            type="button"
            onClick={() => void selectTemplate(template)}
            className={cn(
              "bg-background hover:bg-muted flex w-36 shrink-0 items-center gap-2 rounded-xl border p-2 text-left transition-colors",
              selectedTemplateId === template.id && "border-foreground/35 bg-muted",
            )}
          >
            {/* Static template thumbnails are local Workbench assets. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={template.thumbnailUrl} alt="" className="size-10 shrink-0 rounded-lg object-cover" />
            <span className="min-w-0">
              <strong className="block truncate text-xs font-medium">{template.title}</strong>
              <span className="text-muted-foreground mt-0.5 block truncate text-[11px]">{template.description}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function Image2ModeControl() {
  const router = useRouter();
  const aui = useAui();
  const selectedTemplateId = useImage2Mode((state) => state.selectedTemplateId);
  const aspectRatio = useImage2Mode((state) => state.aspectRatio);
  const variants = useImage2Mode((state) => state.variants);
  const reset = useImage2Mode((state) => state.reset);
  const setAspectRatio = useImage2Mode((state) => state.setAspectRatio);
  const setVariants = useImage2Mode((state) => state.setVariants);
  const selectTemplate = useSelectImage2Template();
  const activeTemplate = getMonoImage2Template(selectedTemplateId);
  const [historyOpen, setHistoryOpen] = useState(false);

  const exit = async () => {
    await removeTemplateReferenceAttachments(aui);
    reset();
    router.replace("/");
  };

  return (
    <span className="bg-muted flex h-7 items-center rounded-full text-xs font-medium">
      <Popover>
        <PopoverTrigger asChild>
          <button type="button" className="hover:bg-muted-foreground/10 flex h-7 items-center gap-1.5 rounded-l-full pl-2.5 pr-2 transition-colors">
            <SparklesIcon className="size-3.5" />
            <span>{activeTemplate?.title ?? "创建图片"}</span>
          </button>
        </PopoverTrigger>
        <PopoverContent side="top" align="start" className="max-h-[min(70vh,34rem)] overflow-y-auto">
          <div className="mb-2 flex items-center justify-between gap-3">
            <strong className="text-sm">创建图片</strong>
            <Button variant="ghost" size="xs" onClick={() => setHistoryOpen(true)}>
              <HistoryIcon />
              历史
            </Button>
          </div>
          <div className="space-y-1">
            {MONO_IMAGE2_TEMPLATES.map((template) => (
              <button
                key={template.id}
                type="button"
                onClick={() => void selectTemplate(template)}
                className="hover:bg-muted flex w-full items-center gap-2 rounded-lg p-2 text-left"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={template.thumbnailUrl} alt="" className="size-9 rounded-md object-cover" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{template.title}</span>
                  <span className="text-muted-foreground block truncate text-xs">{template.description}</span>
                </span>
                {selectedTemplateId === template.id ? <CheckIcon className="size-4" /> : null}
              </button>
            ))}
          </div>
        </PopoverContent>
      </Popover>
      <span className="bg-muted-foreground/20 h-3.5 w-px" aria-hidden />
      <QuickOption
        label="画面比例"
        value={aspectRatio}
        options={monoAspectRatios}
        onChange={setAspectRatio}
      />
      <span className="bg-muted-foreground/20 h-3.5 w-px" aria-hidden />
      <QuickOption
        label="生成张数"
        value={variants}
        options={monoImageVariants}
        display={`${variants} 张`}
        suffix=" 张"
        onChange={setVariants}
      />
      <button
        type="button"
        onClick={() => void exit()}
        aria-label="退出创建图片模式"
        title="退出创建图片模式"
        className="text-muted-foreground hover:bg-muted-foreground/10 hover:text-foreground mx-1 flex size-5 items-center justify-center rounded-full transition-colors"
      >
        <XIcon className="size-3" />
      </button>
      <Image2HistorySheet open={historyOpen} onOpenChange={setHistoryOpen} />
    </span>
  );
}

export function Image2ComposerContext() {
  const active = useImage2Mode((state) => state.active);
  const selectedTemplateId = useImage2Mode((state) => state.selectedTemplateId);
  const attachmentCount = useAuiState((state) => state.composer.attachments.length);
  const composerText = useAuiState((state) => state.composer.text);
  const template = getMonoImage2Template(selectedTemplateId);
  if (!active) return null;

  const subjectCount = countSubjectDirectives(composerText);
  const totalReferences = attachmentCount + subjectCount;
  const tooMany = !template?.structuredMode && totalReferences > 6;
  if (!tooMany) return null;

  return (
    <div className="px-2 text-xs">
      <p className="text-destructive">附件和主体图片合计最多 6 张，请移除 {totalReferences - 6} 项。</p>
    </div>
  );
}

/** 当前是否处于结构化双图模板（替换产品 / 参考生成）。 */
export function useImage2StructuredTemplate(): MonoImage2Template | undefined {
  const active = useImage2Mode((state) => state.active);
  const selectedTemplateId = useImage2Mode((state) => state.selectedTemplateId);
  const template = getMonoImage2Template(selectedTemplateId);
  return active && template?.structuredMode ? template : undefined;
}

/**
 * 结构化模板的双槽上传：槽位靠文件名前缀（参考图1-/参考图2-）识别，
 * 附件变化时自动把顺序归一化为「产品图在前」——后端按附件顺序取
 * 前两张作为产品图/场景图，这里是顺序契约的唯一守护点。
 */
export const SLOT_PREFIXES = ["参考图1-", "参考图2-"] as const;

type SlotAttachment = { id: string; name: string; file?: File };

function mapSlots(attachments: readonly SlotAttachment[]): (SlotAttachment | undefined)[] {
  const claimed = SLOT_PREFIXES.map((prefix) =>
    attachments.find((attachment) => attachment.name.startsWith(prefix)),
  );
  const leftovers = attachments.filter((attachment) => !claimed.includes(attachment));
  return claimed.map((slot) => slot ?? leftovers.shift());
}

function withSlotPrefix(file: File, slotIndex: number): File {
  const prefix = SLOT_PREFIXES[slotIndex];
  const bareName = SLOT_PREFIXES.reduce(
    (name, known) => (name.startsWith(known) ? name.slice(known.length) : name),
    file.name,
  );
  return new File([file], `${prefix}${bareName}`, { type: file.type });
}

export function Image2StructuredSlots() {
  const template = useImage2StructuredTemplate();
  const aui = useAui();
  const attachments = useAuiState((state) => state.composer.attachments) as readonly SlotAttachment[];
  const rebuilding = useRef(false);
  const structuredSubjectIds = useImage2Mode((state) => state.structuredSubjectIds);
  const setStructuredSubject = useImage2Mode((state) => state.setStructuredSubject);
  const openSubjectLibrary = useImage2Mode((state) => state.openSubjectLibrary);
  const subjects = useMonoSubjectCatalog((state) => state.subjects);

  const slots = useMemo(() => mapSlots(attachments), [attachments]);

  useEffect(() => {
    if (!template || rebuilding.current) return;
    const [product, scene] = mapSlots(attachments);
    if (!product || !scene) return;
    const canonical =
      attachments.length === 2 &&
      attachments[0].id === product.id &&
      product.name.startsWith(SLOT_PREFIXES[0]) &&
      scene.name.startsWith(SLOT_PREFIXES[1]);
    if (canonical) return;
    if (!(product.file instanceof File) || !(scene.file instanceof File)) return;
    rebuilding.current = true;
    void (async () => {
      try {
        await aui.composer().clearAttachments();
        await aui.composer().addAttachment(withSlotPrefix(product.file as File, 0));
        await aui.composer().addAttachment(withSlotPrefix(scene.file as File, 1));
      } finally {
        rebuilding.current = false;
      }
    })();
  }, [attachments, aui, template]);

  useEffect(() => {
    structuredSubjectIds.forEach((subjectId, index) => {
      if (!subjectId) return;
      const attachment = attachments.find((item) => item.name.startsWith(SLOT_PREFIXES[index]));
      if (attachment) void aui.composer().attachment({ id: attachment.id }).remove();
    });
  }, [attachments, aui, structuredSubjectIds]);

  if (!template) return null;
  const slotLabels = ["产品图", template.structuredMode === "replace-product" ? "场景参考图" : "穿戴参考图"];

  const setSlot = async (slotIndex: number, file: File) => {
    const existing = mapSlots(aui.composer().getState().attachments as readonly SlotAttachment[])[slotIndex];
    if (existing) await aui.composer().attachment({ id: existing.id }).remove();
    setStructuredSubject(slotIndex as 0 | 1, undefined);
    await aui.composer().addAttachment(withSlotPrefix(file, slotIndex));
  };

  const clearSlot = async (slotIndex: number) => {
    const existing = mapSlots(aui.composer().getState().attachments as readonly SlotAttachment[])[slotIndex];
    if (existing) await aui.composer().attachment({ id: existing.id }).remove();
    setStructuredSubject(slotIndex as 0 | 1, undefined);
  };

  return (
    <div className="flex gap-2 px-2 pt-1">
      {slotLabels.map((label, index) => (
        <StructuredSlot
          key={label}
          index={index}
          label={label}
          attachment={slots[index]}
          subject={subjects.find((subject) => subject.id === structuredSubjectIds[index])}
          onPick={(file) => void setSlot(index, file)}
          onClear={() => void clearSlot(index)}
          onPickSubject={() => openSubjectLibrary(index as 0 | 1)}
        />
      ))}
    </div>
  );
}

function StructuredSlot({ index, label, attachment, subject, onPick, onClear, onPickSubject }: {
  index: number;
  label: string;
  attachment?: SlotAttachment;
  subject?: MonoSubjectView;
  onPick: (file: File) => void;
  onClear: () => void;
  onPickSubject: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const previewUrl = useFilePreview(attachment?.file);

  return (
    <div className="relative flex flex-col items-start gap-1">
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        aria-label={`上传${label}`}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) onPick(file);
          event.target.value = "";
        }}
      />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        title={attachment || subject ? `上传图片替换${label}` : `上传${label}`}
        className={cn(
          "flex h-24 w-32 flex-col items-center justify-center gap-1 overflow-hidden rounded-lg border text-xs transition-colors",
          attachment || subject
            ? "border-border p-0"
            : "text-muted-foreground hover:bg-muted/60 hover:text-foreground border-dashed",
        )}
      >
        {subject ? (
          <span className="relative block h-full w-full">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={subject.previewUrl} alt={label} className="h-full w-full object-cover" />
            <span className="bg-background/85 absolute inset-x-0 bottom-0 truncate px-1.5 py-0.5 text-[11px]">
              {index + 1} · {subject.name}
            </span>
          </span>
        ) : attachment && previewUrl ? (
          <span className="relative block h-full w-full">
            {/* 预览来自本地 File 对象的 objectURL */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={previewUrl} alt={label} className="h-full w-full object-cover" />
            <span className="bg-background/85 absolute inset-x-0 bottom-0 truncate px-1.5 py-0.5 text-[11px]">
              {index + 1} · {label}
            </span>
          </span>
        ) : (
          <>
            <ImageUpIcon className="size-4" />
            <span>{index + 1} · {label}</span>
          </>
        )}
      </button>
      <Button type="button" variant="ghost" size="xs" onClick={onPickSubject} className="h-6 px-1.5">
        从主体库选择
      </Button>
      {attachment || subject ? (
        <button
          type="button"
          onClick={onClear}
          aria-label={`移除${label}`}
          className="bg-background text-muted-foreground hover:text-foreground absolute -right-1.5 -top-1.5 flex size-5 items-center justify-center rounded-full border shadow-sm"
        >
          <XIcon className="size-3" />
        </button>
      ) : null}
    </div>
  );
}

function useFilePreview(file?: File) {
  const url = useMemo(
    () => (file instanceof File ? URL.createObjectURL(file) : undefined),
    [file],
  );
  useEffect(() => {
    if (!url) return;
    return () => URL.revokeObjectURL(url);
  }, [url]);
  return url;
}

export function useImage2SendBlocked() {
  const active = useImage2Mode((state) => state.active);
  const selectedTemplateId = useImage2Mode((state) => state.selectedTemplateId);
  const attachments = useAuiState((state) => state.composer.attachments) as readonly SlotAttachment[];
  const composerText = useAuiState((state) => state.composer.text);
  const structuredSubjectIds = useImage2Mode((state) => state.structuredSubjectIds);
  const template = getMonoImage2Template(selectedTemplateId);
  if (!active) return false;
  if (!template?.structuredMode) return attachments.length + countSubjectDirectives(composerText) > 6;
  return mapSlots(attachments).filter(Boolean).length + structuredSubjectIds.filter(Boolean).length !== 2;
}

function countSubjectDirectives(text: string): number {
  return new Set(
    [...text.matchAll(/:subject\[[^\]]+\](?:\{name=([^}]+)\})?/gu)]
      .map((match) => match[1] ?? match[0]),
  ).size;
}

function QuickOption<T extends string | number>({ label, value, options, display, suffix = "", onChange }: {
  label: string;
  value: T;
  options: readonly T[];
  display?: string;
  suffix?: string;
  onChange: (value: T) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title={label}
          aria-label={label}
          className="hover:bg-muted-foreground/10 flex h-7 items-center px-2 tabular-nums transition-colors"
        >
          {display ?? String(value)}
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="center" className="w-auto p-2">
        <p className="text-muted-foreground mb-1.5 px-1 text-xs">{label}</p>
        <div className="flex gap-1">
          {options.map((option) => (
            <Button
              key={String(option)}
              type="button"
              variant={value === option ? "secondary" : "ghost"}
              size="xs"
              onClick={() => {
                onChange(option);
                setOpen(false);
              }}
            >
              {option}{suffix}
            </Button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
