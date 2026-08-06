"use client";

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type FC,
  type PropsWithChildren,
} from "react";
import { useRouter } from "next/navigation";
import { useAui } from "@assistant-ui/react";
import { useImage2Mode } from "@/lib/image2-mode";
import { useVideoGenerationMode } from "@/lib/video-generation-mode";
import { useExitImage2Mode } from "@/components/workbench/Image2ChatMode";
import { adoptComposerImageAsVideoFrame } from "@/components/workbench/VideoGenerationMode";
import { VideoAnalysisLauncher } from "@/components/workbench/VideoAnalysisLauncher";
import { ProductPipelineLauncher } from "@/components/workbench/ProductPipelineLauncher";
import type { CapabilityAction } from "@/lib/workbench/capabilities";
import type { Permission } from "@/lib/authorization";
import { useWorkbenchSession } from "@/components/workbench/auth-gate";

/**
 * 能力动作的单一执行器：欢迎页建议 chip 与 composer 的 `/` 命令共用同一套
 * 行为（填提示词 / 拉起文件选择器 / 打开视频卡 / 切生图模式），并集中承载
 * 隐藏 file input、视频对话框与导入错误提示。挂在 Thread 内层即可，两个入口
 * 通过 useCapabilityActions() 拿到 run()。
 */
export type CapabilityRunInput = {
  action?: CapabilityAction;
  prompt: string;
  permission?: Permission;
};

type CapabilityActionsContextValue = {
  run: (input: CapabilityRunInput) => void;
};

const CapabilityActionsContext =
  createContext<CapabilityActionsContextValue | null>(null);

export function useCapabilityActions(): CapabilityActionsContextValue {
  const ctx = useContext(CapabilityActionsContext);
  if (!ctx) {
    throw new Error(
      "useCapabilityActions must be used within <CapabilityActionsProvider>",
    );
  }
  return ctx;
}

export const CapabilityActionsProvider: FC<PropsWithChildren> = ({
  children,
}) => {
  const aui = useAui();
  const router = useRouter();
  const activateImage2 = useImage2Mode((state) => state.activate);
  const image2Active = useImage2Mode((state) => state.active);
  const exitImage2Mode = useExitImage2Mode();
  const videoGenerationActive = useVideoGenerationMode((state) => state.active);
  const activateVideoGeneration = useVideoGenerationMode((state) => state.activate);
  const resetVideoGeneration = useVideoGenerationMode((state) => state.reset);
  const { canGrant } = useWorkbenchSession();
  const [videoDialogOpen, setVideoDialogOpen] = useState(false);
  const [productPipelineOpen, setProductPipelineOpen] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const reverseImageInputRef = useRef<HTMLInputElement>(null);
  const mattingInputRef = useRef<HTMLInputElement>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);
  // 擦除与增强共用一个 file input，靠这里暂存的提示词区分是哪一个。
  const pendingVideoPromptRef = useRef<string>("");

  // 导入错误几秒后自动消失，避免残留遮挡。
  useEffect(() => {
    if (!importError) return;
    const timer = setTimeout(() => setImportError(null), 6000);
    return () => clearTimeout(timer);
  }, [importError]);

  // 建议只负责把提示词写进输入框，发不发送交给用户点发送按钮确认。
  const fillPrompt = (prompt: string) => {
    if (aui.thread().getState().isRunning) return;
    aui.composer().setText(prompt);
  };

  // 反推需要先选图：选完把附件 + 指令一起放进输入框，仍由用户点发送确认。
  const reverseImage = async (file: File) => {
    if (aui.thread().getState().isRunning) return;
    const composer = aui.composer();
    await composer.addAttachment(file);
    composer.setText("反推这张图片，生成可复用的 AI 生图提示词。");
  };

  const mattingImage = async (file: File) => {
    if (aui.thread().getState().isRunning) return;
    const composer = aui.composer();
    await composer.addAttachment(file);
    composer.setText("把这张图片做主体抠像，输出透明背景。");
  };

  // 视频要真上传到工具箱网关（几秒到几十秒），所以先写指令再挂附件——
  // 用户能立刻看到自己在等什么，附件 tile 自带上传中的转圈。
  const toolboxVideo = async (file: File) => {
    if (aui.thread().getState().isRunning) return;
    const composer = aui.composer();
    composer.setText(pendingVideoPromptRef.current);
    await composer.addAttachment(file);
  };

  // 导入抓取结果（douyin_Playwright 的 XLSX/CSV），成功后把分析指令填进输入框。
  const importCollectorFile = async (file: File) => {
    setImportError(null);
    try {
      const response = await fetch("/api/workbench/collector/import", {
        method: "POST",
        headers: { "x-workbench-filename": encodeURIComponent(file.name) },
        body: file,
      });
      const payload = (await response.json()) as {
        batch?: { batchId: string; platform: string; itemCount: number };
        error?: string;
      };
      if (!response.ok || !payload.batch) throw new Error(payload.error ?? "导入失败");
      fillPrompt(
        `我刚导入了一批抓取数据（批次 ${payload.batch.batchId}，平台 ${payload.batch.platform}，共 ${payload.batch.itemCount} 条）。请用 collector_search_items 查看这批内容，总结标题风格与互动数据分布，并指出表现最好的几条和可复用的选题方向。`,
      );
    } catch (error) {
      setImportError(error instanceof Error ? error.message : "导入失败，请重试");
    }
  };

  const run = ({ action = "fill", prompt, permission }: CapabilityRunInput) => {
    if (permission && !canGrant(permission)) return;
    // 从生图模式切到别的能力时，先清掉模板参考图和模式状态，避免底部的
    // "模板 / 比例 / 张数" 生图控制条残留在跟生图无关的对话里。
    if (action !== "image2-mode" && action !== "video-generation-mode" && image2Active) {
      void exitImage2Mode();
    }
    if (action !== "video-generation-mode" && videoGenerationActive) {
      resetVideoGeneration();
    }
    switch (action) {
      case "image2-mode":
        if (videoGenerationActive) resetVideoGeneration();
        activateImage2();
        router.push("/?mode=image2");
        return;
      case "video-generation-mode":
        void (async () => {
          if (image2Active) await exitImage2Mode();
          await adoptComposerImageAsVideoFrame(aui);
          activateVideoGeneration();
          router.push("/?mode=video");
        })();
        return;
      case "image-picker":
        reverseImageInputRef.current?.click();
        return;
      case "video-dialog":
        setVideoDialogOpen(true);
        return;
      case "matting-picker":
        mattingInputRef.current?.click();
        return;
      case "product-pipeline":
        setProductPipelineOpen(true);
        return;
      case "import-picker":
        importInputRef.current?.click();
        return;
      case "video-picker":
        pendingVideoPromptRef.current = prompt;
        videoInputRef.current?.click();
        return;
      case "fill":
      default:
        fillPrompt(prompt);
        return;
    }
  };

  return (
    <CapabilityActionsContext.Provider value={{ run }}>
      {children}
      <input
        ref={reverseImageInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void reverseImage(file);
        }}
      />
      <input
        ref={mattingInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void mattingImage(file);
        }}
      />
      <input
        ref={videoInputRef}
        type="file"
        accept="video/*"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void toolboxVideo(file);
        }}
      />
      <input
        ref={importInputRef}
        type="file"
        accept=".xlsx,.csv"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void importCollectorFile(file);
        }}
      />
      <VideoAnalysisLauncher
        open={videoDialogOpen}
        onOpenChange={setVideoDialogOpen}
        onSubmit={fillPrompt}
      />
      <ProductPipelineLauncher open={productPipelineOpen} onOpenChange={setProductPipelineOpen} />
      {importError ? (
        <div className="pointer-events-none fixed inset-x-0 bottom-28 z-50 flex justify-center px-4">
          <p className="bg-destructive/10 text-destructive rounded-full border border-destructive/30 px-3 py-1.5 text-xs shadow-sm backdrop-blur-sm">
            {importError}
          </p>
        </div>
      ) : null}
    </CapabilityActionsContext.Provider>
  );
};
