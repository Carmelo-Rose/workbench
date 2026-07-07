import {
  convertToModelMessages,
  stepCountIs,
  streamText,
  type UIMessage,
} from "ai";
import { chatModel, hermesModel } from "@/lib/models";
import { defaultBackend, isBackendId, type BackendId } from "@/lib/backends";
import { WORKBENCH_SYSTEM } from "@/lib/prompts";
import { imageToPromptTool } from "@/lib/tools/image-to-prompt";

export const maxDuration = 60;

type ChatRequestBody = {
  messages: UIMessage[];
  id?: string;
  /** AssistantChatTransport 注入的 ModelContext，modelName 即前端选中的 backend id。 */
  config?: { modelName?: string };
};

export async function POST(req: Request) {
  const { messages, id, config }: ChatRequestBody = await req.json();

  const backend: BackendId = isBackendId(config?.modelName)
    ? config.modelName
    : defaultBackend();

  // 双链路常驻：Hermes 走网关内完整 Agent 循环（工具、记忆、技能，
  // 不注入本地 system 与工具），direct 走模型直连 + 本地工具。
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
          tools: {
            image_to_prompt: imageToPromptTool,
          },
          // 允许模型在工具返回后继续生成收尾回复（多步）。
          stopWhen: stepCountIs(5),
        });

  return result.toUIMessageStreamResponse({
    // 消息落库时带上来源后端，前端据此渲染模式徽标。
    // assistant-ui 只透传 metadata.custom，自定义键必须放在 custom 下。
    messageMetadata: () => ({ custom: { backend } }),
    onError: (error) =>
      error instanceof Error ? error.message : "对话后端暂时不可用，请稍后重试",
  });
}
