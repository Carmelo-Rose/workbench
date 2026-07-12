import {
  convertToModelMessages,
  stepCountIs,
  streamText,
  type UIMessage,
} from "ai";
import { chatModel, hermesModel } from "@/lib/models";
import { defaultBackend, isBackendId, type BackendId } from "@/lib/backends";
import { WORKBENCH_SYSTEM } from "@/lib/prompts";
import { createImageToPromptTool } from "@/lib/tools/image-to-prompt";
import { createMonoTools } from "@/lib/tools/mono";

export const maxDuration = 60;

type ChatRequestBody = {
  messages: UIMessage[];
  id?: string;
  /** AssistantChatTransport 注入的 ModelContext，modelName 即前端选中的 backend id。 */
  config?: { modelName?: string };
};

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

function latestImageAttachment(messages: UIMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "user") continue;
    const image = message.parts.find(
      (part) => part.type === "file" && part.mediaType.startsWith("image/"),
    );
    if (image?.type === "file") return image.url;
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
  if (/(生图|生成.*图|画.*图|绘制.*图|generate.*image|create.*image)/i.test(text)) {
    return "mono_generate_image" as const;
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
  const attachmentUrl = latestImageAttachment(messages);
  const directTools = {
    image_to_prompt: createImageToPromptTool(attachmentUrl),
    ...createMonoTools({
      sessionId: id,
      userId: process.env.WORKBENCH_LOCAL_USER_ID ?? "local-user",
      workspaceId: process.env.WORKBENCH_LOCAL_WORKSPACE_ID ?? "default",
    }),
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
