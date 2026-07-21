import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  convertToModelMessages,
  stepCountIs,
  streamText,
  type UIMessage,
} from "ai";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { chatModel, hermesModel } from "@/lib/models";
import { defaultBackend, isBackendId, type BackendId } from "@/lib/backends";
import { WORKBENCH_SYSTEM } from "@/lib/prompts";
import { createImageToPromptTool } from "@/lib/tools/image-to-prompt";
import { createCollectorTools } from "@/lib/tools/collector";
import { createMonoTools } from "@/lib/tools/mono";
import { monoAspectRatios, type MonoImageGenerationInput, type MonoJob } from "@/lib/mono/contracts";
import { getMonoImage2Template, monoImage2TemplateIds } from "@/lib/mono/image2-templates";
import { createAsset, createImageGenerationJob, getSubject, newMonoActor } from "@/lib/mono/service";
import { subjectIdsFromPrompt } from "@/lib/mono/subject-compiler";
import { videoEraseTool } from "@/lib/tools/video-erase";
import { videoEnhanceTool } from "@/lib/tools/video-enhance";

export const maxDuration = 60;

type ChatRequestBody = {
  messages: UIMessage[];
  id?: string;
  /** AssistantChatTransport 注入的 ModelContext，modelName 即前端选中的 backend id。 */
  config?: {
    modelName?: string;
    image2?: unknown;
  };
};

const image2ChatConfigSchema = z.object({
  active: z.literal(true),
  templateId: z.enum(monoImage2TemplateIds).optional(),
  aspectRatio: z.enum(monoAspectRatios).default("9:16"),
  variants: z.union([z.literal(1), z.literal(2), z.literal(4), z.literal(6)]).default(1),
  structuredSubjectIds: z.array(z.string().nullable()).length(2).default([null, null]),
});

type ImageAttachmentPart = { url: string; filename?: string };

function latestImageAttachmentParts(messages: UIMessage[]): ImageAttachmentPart[] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "user") continue;
    return message.parts
      .flatMap((part): ImageAttachmentPart[] => part.type === "file" && part.mediaType.startsWith("image/")
        ? [{ url: part.url, ...(part.filename ? { filename: part.filename } : {}) }]
        : [])
      .slice(0, 6);
  }
  return [];
}

function latestUserText(messages: UIMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "user") continue;
    return message.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n");
  }
  return "";
}

function latestImageAttachments(messages: UIMessage[]): string[] {
  return latestImageAttachmentParts(messages).map((part) => part.url);
}

/**
 * 从最近一条用户消息文本里确定性提取 asset_<uuid> 引用（如"分析视频素材 asset_xxx"）。
 * 让模型自己在工具参数里手抄这个 36 位 UUID 容易转录出错，这里直接用正则从原文取，
 * 比模型复述更可靠。
 */
function latestVideoAssetId(messages: UIMessage[]): string | undefined {
  return latestUserText(messages).match(
    /asset_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
  )?.[0];
}

function latestUserMessageId(messages: UIMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "user") return messages[index].id;
  }
  return undefined;
}

function forcedToolName(userText: string, hasImageAttachment: boolean) {
  const text = userText.toLowerCase();
  if (
    hasImageAttachment &&
    /(分析|识别|反推|提示词|prompt|describe|analy[sz]e)/i.test(text)
  ) {
    return "image_to_prompt" as const;
  }
  // 视频意图必须先于生图判断：「反推视频提示词」这类请求也含“生…图”字样。
  if (
    /(分析|反推|拆解|解析).{0,12}视频|视频.{0,12}(分析|反推|拆解)|analy[sz]e.{0,20}video/i.test(text) &&
    /https?:\/\/|asset_[0-9a-f]/i.test(text)
  ) {
    return "mono_analyze_video" as const;
  }
  if (
    /(抠像|抠图|去背景|去除背景|换背景|remove\s*background|matting)/i.test(text) &&
    (hasImageAttachment || /https?:\/\/|asset_[0-9a-f]/i.test(text))
  ) {
    return "mono_matting" as const;
  }
  if (/(生图|生成.*图|画.*图|绘制.*图|generate.*image|create.*image)/i.test(text)) {
    return "mono_generate_image" as const;
  }
  // 罗盘榜单问数：明确提到罗盘/榜单异动时直接查差分事件。
  if (/(罗盘|短视频榜|商品卡榜|新进榜|急升|榜单.{0,6}(异动|变化|事件))/i.test(text)) {
    return "luopan_query_events" as const;
  }
  return undefined;
}

export async function POST(req: Request) {
  const { messages, id, config }: ChatRequestBody = await req.json();

  const backend: BackendId = isBackendId(config?.modelName)
    ? config.modelName
    : defaultBackend();

  // 双链路常驻：Hermes 走网关内完整 Agent 循环（工具、记忆、技能，
  // 不注入本地 system 与工具），direct 走模型直连 + 本地工具。
  const imageAttachments = latestImageAttachments(messages);
  const image2Config = image2ChatConfigSchema.safeParse(config?.image2);
  if (image2Config.success) {
    return image2Response({
      messages,
      threadId: id,
      prompt: latestUserText(messages),
      attachments: imageAttachments,
      attachmentParts: latestImageAttachmentParts(messages),
      config: image2Config.data,
    });
  }

  const attachmentUrl = imageAttachments[0];
  const directTools = {
    image_to_prompt: createImageToPromptTool(attachmentUrl),
    ...createMonoTools({
      sessionId: id,
      userId: process.env.WORKBENCH_LOCAL_USER_ID ?? "local-user",
      workspaceId: process.env.WORKBENCH_LOCAL_WORKSPACE_ID ?? "default",
      attachmentUrl,
      videoAssetId: latestVideoAssetId(messages),
    }),
    ...createCollectorTools({
      userId: process.env.WORKBENCH_LOCAL_USER_ID ?? "local-user",
      workspaceId: process.env.WORKBENCH_LOCAL_WORKSPACE_ID ?? "default",
    }),
    video_erase: videoEraseTool,
    video_enhance: videoEnhanceTool,
  };
  const requiredTool = forcedToolName(latestUserText(messages), Boolean(attachmentUrl));

  const result =
    backend === "hermes"
      ? streamText({
          model: hermesModel(),
          messages: await convertToModelMessages(messages),
          // X-Hermes-Session-Id 让同一线程获得会话连续性。
          ...(id ? { headers: { "X-Hermes-Session-Id": `wb-${id}` } } : {}),
        })
      : streamText({
          model: chatModel(),
          system: WORKBENCH_SYSTEM,
          messages: await convertToModelMessages(messages),
          tools: directTools,
          // Force an obvious user intent only on the first step. Keeping a
          // toolChoice for later steps makes the SDK submit the same costly
          // generation repeatedly after it receives the queued job result.
          prepareStep: ({ stepNumber }) => {
            if (stepNumber === 0 && requiredTool) {
              return { toolChoice: { type: "tool" as const, toolName: requiredTool } };
            }
            if (stepNumber > 0 && requiredTool) return { activeTools: [] };
            return undefined;
          },
          // 允许模型在工具返回后继续生成收尾回复（多步）。
          stopWhen: stepCountIs(5),
        });

  return result.toUIMessageStreamResponse({
    // 消息落库时带上来源后端，前端据此渲染模式徽标。
    // assistant-ui 只透传 metadata.custom，自定义键必须放在 custom 下。
    messageMetadata: () => ({ custom: { backend } }),
    // Tool cards are the user-facing progress surface. Do not expose raw model
    // chain-of-thought, which is noisy and frequently mixes in English.
    sendReasoning: false,
    onError: (error) =>
      error instanceof Error ? error.message : "对话后端暂时不可用，请稍后重试",
  });
}

function image2Response({
  messages,
  threadId,
  prompt,
  attachments,
  attachmentParts,
  config,
}: {
  messages: UIMessage[];
  threadId?: string;
  prompt: string;
  attachments: string[];
  attachmentParts: ImageAttachmentPart[];
  config: z.infer<typeof image2ChatConfigSchema>;
}) {
  const actor = newMonoActor({
    sessionId: threadId,
    userId: process.env.WORKBENCH_LOCAL_USER_ID ?? "local-user",
    workspaceId: process.env.WORKBENCH_LOCAL_WORKSPACE_ID ?? "default",
  });
  const template = getMonoImage2Template(config.templateId);
  let structuredReferences: MonoImageGenerationInput["structuredReferences"];
  if (template?.structuredMode) {
    const claimedAttachments = [0, 1].map((slot) =>
      attachmentParts.find((part) => part.filename?.startsWith(`参考图${slot + 1}-`)),
    );
    const leftovers = attachmentParts.filter((part) => !claimedAttachments.includes(part));
    const assetIds = [0, 1].map((slot) => {
      const subjectId = config.structuredSubjectIds[slot];
      if (subjectId) {
        const subject = getSubject(actor, subjectId);
        if (!subject) throw new Error("双槽中选择的主体不存在或已无权访问");
        return subject.assetId;
      }
      const part = claimedAttachments[slot] ?? leftovers.shift();
      if (!part) return undefined;
      return createAsset(actor, { sourceUrl: part.url, mimeType: "image/*", name: part.filename }).id;
    });
    if (assetIds[0] && assetIds[1]) {
      structuredReferences = { productAssetId: assetIds[0], sceneAssetId: assetIds[1] };
    }
  }
  const input: MonoImageGenerationInput = {
    prompt: prompt.trim() || template?.prompt || "请根据参考图创建图片",
    templateId: config.templateId,
    // 模板参考图在前端以普通附件进入消息，服务端不再重复注入。
    templateReferencesEnabled: false,
    referenceAssetIds: [],
    referenceImageUrls: template?.structuredMode ? [] : attachments,
    structuredReferences,
    subjectIds: template?.structuredMode ? [] : subjectIdsFromPrompt(prompt),
    aspectRatio: config.aspectRatio,
    variants: config.variants,
    idempotencyKey: `image2:${threadId ?? "thread"}:${latestUserMessageId(messages) ?? randomUUID()}`,
  };
  const job = createImageGenerationJob(actor, input);
  const publicJob = redactJobReferences(job);
  const toolCallId = `tool_${randomUUID()}`;
  const metadata = { custom: { backend: "direct", mode: "image2" } };
  const stream = createUIMessageStream({
    originalMessages: messages,
    execute: ({ writer }) => {
      writer.write({ type: "start", messageMetadata: metadata });
      writer.write({ type: "start-step" });
      writer.write({ type: "tool-input-available", toolCallId, toolName: "mono_generate_image", input: { ...input, referenceImageUrls: [] } });
      writer.write({ type: "tool-output-available", toolCallId, output: publicJob });
      writer.write({ type: "finish-step" });
      writer.write({ type: "finish", finishReason: "tool-calls", messageMetadata: metadata });
    },
    onError: (error) => error instanceof Error ? error.message : "图片生成任务提交失败",
  });
  return createUIMessageStreamResponse({ stream });
}

function redactJobReferences(job: MonoJob): MonoJob {
  const references = Array.isArray(job.input.referenceImageUrls) ? job.input.referenceImageUrls : [];
  const subjectSnapshots = Array.isArray(job.input.subjectSnapshots)
    ? job.input.subjectSnapshots.map((snapshot) => {
        if (typeof snapshot !== "object" || snapshot === null) return snapshot;
        const redacted = { ...(snapshot as Record<string, unknown>) };
        delete redacted.sourceUrl;
        return redacted;
      })
    : job.input.subjectSnapshots;
  const input = { ...job.input };
  delete input.compiledPrompt;
  return {
    ...job,
    input: {
      ...input,
      referenceImageUrls: references.map((_, index) => `attachment:${index + 1}`),
      subjectSnapshots,
    },
  };
}
