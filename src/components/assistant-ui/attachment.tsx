"use client";

import {
  type PropsWithChildren,
  useEffect,
  useRef,
  useState,
  type FC,
} from "react";
import {
  XIcon,
  PlusIcon,
  FileText,
  Loader2Icon,
  AlertCircleIcon,
} from "lucide-react";
import {
  AttachmentPrimitive,
  ComposerPrimitive,
  MessagePrimitive,
  useAuiState,
  useAui,
} from "@assistant-ui/react";
import { useShallow } from "zustand/shallow";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button";
import { cn } from "@/lib/utils";

const useFileSrc = (file: File | undefined) => {
  const [src, setSrc] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!file) {
      setSrc(undefined);
      return;
    }

    const objectUrl = URL.createObjectURL(file);
    setSrc(objectUrl);

    return () => {
      URL.revokeObjectURL(objectUrl);
    };
  }, [file]);

  return src;
};

const useAttachmentSrc = () => {
  const { file, src } = useAuiState(
    useShallow((s): { file?: File; src?: string } => {
      if (s.attachment.type !== "image") return {};
      if (s.attachment.file) return { file: s.attachment.file };
      const src = s.attachment.content?.filter((c) => c.type === "image")[0]
        ?.image;
      if (!src) return {};
      return { src };
    }),
  );

  return useFileSrc(file) ?? src;
};

const ATTACHMENT_THUMB_SIZE = 192;

/**
 * Chat attachments can be camera originals even though the message tile is
 * only 96px square. Decode a small bitmap for the tile so scrolling into an
 * attachment never has to synchronously decode the original image.
 */
const useAttachmentThumbnail = (src: string | undefined) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let disposed = false;
    const controller = new AbortController();
    setReady(false);

    if (!src || typeof createImageBitmap !== "function") {
      return () => controller.abort();
    }

    const load = async () => {
      try {
        const response = await fetch(src, { signal: controller.signal });
        if (!response.ok) throw new Error(`Attachment thumbnail HTTP ${response.status}`);
        const bitmap = await createImageBitmap(await response.blob(), {
          resizeWidth: ATTACHMENT_THUMB_SIZE,
          resizeQuality: "medium",
        });

        if (disposed) {
          bitmap.close();
          return;
        }

        const canvas = canvasRef.current;
        const context = canvas?.getContext("2d");
        if (!canvas || !context) {
          bitmap.close();
          return;
        }

        canvas.width = ATTACHMENT_THUMB_SIZE;
        canvas.height = ATTACHMENT_THUMB_SIZE;
        const scale = Math.max(
          ATTACHMENT_THUMB_SIZE / bitmap.width,
          ATTACHMENT_THUMB_SIZE / bitmap.height,
        );
        const width = bitmap.width * scale;
        const height = bitmap.height * scale;
        context.clearRect(0, 0, canvas.width, canvas.height);
        context.drawImage(
          bitmap,
          (ATTACHMENT_THUMB_SIZE - width) / 2,
          (ATTACHMENT_THUMB_SIZE - height) / 2,
          width,
          height,
        );
        bitmap.close();
        setReady(true);
      } catch (error) {
        if (!disposed && (error as Error).name !== "AbortError") {
          // Keep the lightweight fallback for an attachment that cannot be
          // fetched or decoded; the full source remains available in the
          // preview dialog.
          setReady(false);
        }
      }
    };

    void load();
    return () => {
      disposed = true;
      controller.abort();
    };
  }, [src]);

  return { canvasRef, ready };
};

type AttachmentPreviewProps = {
  src: string;
};

const AttachmentPreview: FC<AttachmentPreviewProps> = ({ src }) => {
  const [isLoaded, setIsLoaded] = useState(false);
  return (
    <img
      src={src}
      alt="Attachment preview"
      className={cn(
        "block h-auto max-h-[80vh] w-auto max-w-full object-contain",
        isLoaded
          ? "aui-attachment-preview-image-loaded"
          : "aui-attachment-preview-image-loading invisible",
      )}
      onLoad={() => setIsLoaded(true)}
    />
  );
};

const AttachmentPreviewDialog: FC<PropsWithChildren> = ({ children }) => {
  const src = useAttachmentSrc();

  if (!src) return children;

  return (
    <Dialog>
      <DialogTrigger
        className="aui-attachment-preview-trigger hover:bg-accent/50 cursor-pointer transition-colors"
        asChild
      >
        {children}
      </DialogTrigger>
      <DialogContent className="aui-attachment-preview-dialog-content [&>button]:bg-foreground/60 [&_svg]:text-background [&>button]:hover:[&_svg]:text-destructive p-2 sm:max-w-3xl [&>button]:rounded-full [&>button]:p-1 [&>button]:opacity-100 [&>button]:ring-0!">
        <DialogTitle className="aui-sr-only sr-only">
          Image Attachment Preview
        </DialogTitle>
        <div className="aui-attachment-preview bg-background relative mx-auto flex max-h-[80dvh] w-full items-center justify-center overflow-hidden">
          <AttachmentPreview src={src} />
        </div>
      </DialogContent>
    </Dialog>
  );
};

const AttachmentThumb: FC = () => {
  const src = useAttachmentSrc();
  const { canvasRef, ready } = useAttachmentThumbnail(src);

  return (
    <Avatar className="aui-attachment-tile-avatar h-full w-full rounded-none">
      <canvas
        ref={canvasRef}
        role="img"
        aria-label="Attachment preview"
        className={cn(
          "aui-attachment-tile-image size-full object-cover",
          !ready && "hidden",
        )}
      />
      {!ready ? (
        <AvatarFallback>
          <FileText className="aui-attachment-tile-fallback-icon text-muted-foreground size-8" />
        </AvatarFallback>
      ) : null}
    </Avatar>
  );
};

const AttachmentUI: FC = () => {
  const aui = useAui();
  const isComposer = aui.attachment.source !== "message";

  const isImage = useAuiState((s) => s.attachment.type === "image");
  const typeLabel = useAuiState((s) => {
    const type = s.attachment.type;
    switch (type) {
      case "image":
        return "Image";
      case "document":
        return "Document";
      case "file":
        return "File";
      default:
        return type;
    }
  });

  const uploadState = useAuiState((s) =>
    s.attachment.status.type === "running"
      ? "uploading"
      : s.attachment.status.type === "incomplete" &&
          s.attachment.status.reason === "error"
        ? "error"
        : undefined,
  );
  const isUploading = uploadState === "uploading";
  const isError = uploadState === "error";

  return (
    <Tooltip>
      <AttachmentPrimitive.Root
        className={cn(
          "aui-attachment-root relative",
          isImage &&
            !isComposer &&
            "aui-attachment-root-message only:*:first:size-24",
        )}
      >
        <AttachmentPreviewDialog>
          <TooltipTrigger asChild>
            <div
              className={cn(
                "aui-attachment-tile bg-muted relative size-14 cursor-pointer overflow-hidden rounded-[calc(var(--composer-radius)-var(--composer-padding))] border transition-opacity hover:opacity-75",
                isError && "border-destructive",
              )}
              role="button"
              tabIndex={0}
              aria-label={`${typeLabel} attachment${
                isError ? ", upload failed" : isUploading ? ", uploading" : ""
              }`}
            >
              <AttachmentThumb />
              {isUploading && (
                <div
                  aria-hidden="true"
                  className="aui-attachment-tile-uploading bg-background/60 absolute inset-0 flex items-center justify-center backdrop-blur-[1px]"
                >
                  <Loader2Icon className="text-muted-foreground size-5 animate-spin" />
                </div>
              )}
              {isError && (
                <div
                  aria-hidden="true"
                  className="aui-attachment-tile-error bg-destructive/10 absolute inset-0 flex items-center justify-center"
                >
                  <AlertCircleIcon className="text-destructive size-5" />
                </div>
              )}
            </div>
          </TooltipTrigger>
        </AttachmentPreviewDialog>
        {isComposer && <AttachmentRemove />}
      </AttachmentPrimitive.Root>
      <TooltipContent side="top">
        <AttachmentPrimitive.Name />
      </TooltipContent>
    </Tooltip>
  );
};

const AttachmentRemove: FC = () => {
  return (
    <AttachmentPrimitive.Remove asChild>
      <TooltipIconButton
        tooltip="移除文件"
        className="aui-attachment-tile-remove text-muted-foreground hover:[&_svg]:text-destructive absolute end-1.5 top-1.5 size-3.5 rounded-full bg-white opacity-100 shadow-sm hover:bg-white! [&_svg]:text-black"
        side="top"
      >
        <XIcon className="aui-attachment-remove-icon size-3 dark:stroke-[2.5px]" />
      </TooltipIconButton>
    </AttachmentPrimitive.Remove>
  );
};

export const UserMessageAttachments: FC = () => {
  return (
    <div className="aui-user-message-attachments-end col-span-full col-start-1 row-start-1 flex w-full flex-row justify-end gap-2">
      <MessagePrimitive.Attachments>
        {() => <AttachmentUI />}
      </MessagePrimitive.Attachments>
    </div>
  );
};

export const ComposerAttachments: FC = () => {
  return (
    <div className="aui-composer-attachments flex w-full flex-row items-center gap-2 overflow-x-auto empty:hidden">
      <ComposerPrimitive.Attachments>
        {() => <AttachmentUI />}
      </ComposerPrimitive.Attachments>
    </div>
  );
};

export const ComposerAddAttachment: FC = () => {
  return (
    <ComposerPrimitive.AddAttachment asChild>
      <TooltipIconButton
        tooltip="添加附件"
        side="bottom"
        variant="ghost"
        size="icon"
        className="aui-composer-add-attachment hover:bg-muted-foreground/15 dark:border-muted-foreground/15 dark:hover:bg-muted-foreground/30 size-7 rounded-full p-1 text-xs font-semibold"
        aria-label="添加附件"
      >
        <PlusIcon className="aui-attachment-add-icon size-4.5 stroke-[1.5px]" />
      </TooltipIconButton>
    </ComposerPrimitive.AddAttachment>
  );
};
