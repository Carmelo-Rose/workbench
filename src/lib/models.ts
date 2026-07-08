import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`缺少环境变量 ${name}，请在 workbench/.env.local 中配置`);
  }
  return value;
}

/**
 * 对话大脑：OpenAI 兼容后端（DeepSeek / GLM 等，可换）。
 * 负责聊天与决定何时调用工具，本身不需要视觉能力。
 */
export function chatModel() {
  const provider = createOpenAICompatible({
    name: "workbench-chat",
    baseURL: process.env.CHAT_BASE_URL ?? "https://api.deepseek.com/v1",
    apiKey: requireEnv("CHAT_API_KEY"),
  });
  return provider(process.env.CHAT_MODEL ?? "deepseek-chat");
}

/**
 * Hermes 网关在 SSE 流里混入非 OpenAI 规范的 Agent 活动块
 * （如 {"tool":"memory","emoji":"🧠","label":...}），会被 AI SDK 的
 * chunk 校验拒绝。这里把活动块转译成 reasoning_content 增量——
 * 前端的推理折叠区顺带成了 Agent 活动时间线；无法识别的行直接丢弃。
 */
function hermesActivityToChunk(payload: string): string | null {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(payload) as Record<string, unknown>;
  } catch {
    console.warn("[workbench] 丢弃无法解析的 Hermes SSE 行:", payload.slice(0, 200));
    return null;
  }
  if (Array.isArray(obj.choices)) return payload; // 规范 chunk 原样放行
  const label = typeof obj.label === "string" ? obj.label : undefined;
  const tool = typeof obj.tool === "string" ? obj.tool : undefined;
  if (!label && !tool) return null;
  const emoji = typeof obj.emoji === "string" ? obj.emoji : "🔧";
  const text = `${emoji} ${label ?? tool}\n`;
  return JSON.stringify({
    id: "hermes-activity",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "hermes-agent",
    choices: [
      { index: 0, delta: { reasoning_content: text }, finish_reason: null },
    ],
  });
}

function hermesStreamTransform(): TransformStream<string, string> {
  let buffer = "";
  const processLine = (line: string): string | null => {
    const trimmed = line.replace(/\r$/, "");
    if (!trimmed.startsWith("data:")) return line;
    const payload = trimmed.slice(5).trim();
    if (payload === "" || payload === "[DONE]") return line;
    const converted = hermesActivityToChunk(payload);
    return converted === null ? null : `data: ${converted}`;
  };
  return new TransformStream<string, string>({
    transform(chunk, controller) {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const out = processLine(line);
        if (out !== null) controller.enqueue(`${out}\n`);
      }
    },
    flush(controller) {
      if (buffer.length > 0) {
        const out = processLine(buffer);
        if (out !== null) controller.enqueue(out);
      }
    },
  });
}

const hermesFetch: typeof fetch = async (input, init) => {
  const res = await fetch(input, init);
  const isSSE = res.headers.get("content-type")?.includes("text/event-stream");
  if (!res.body || !isSSE) return res;
  const body = res.body
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(hermesStreamTransform())
    .pipeThrough(new TextEncoderStream());
  return new Response(body, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
};

/**
 * Hermes Agent 内核：hermes gateway 的 api_server 平台暴露 OpenAI 兼容端点，
 * Agent 循环（工具、记忆、技能）全部在 Hermes 服务端完成，
 * 对这里而言它就是一个"模型"。前端按请求切换，见 /api/chat 与 lib/backends.ts。
 */
export function hermesModel() {
  const provider = createOpenAICompatible({
    name: "hermes",
    baseURL: process.env.HERMES_BASE_URL ?? "http://127.0.0.1:8642/v1",
    apiKey: requireEnv("HERMES_API_KEY"),
    fetch: hermesFetch,
  });
  return provider(process.env.HERMES_MODEL ?? "hermes-agent");
}

/**
 * 视觉模型：供 image_to_prompt 工具内部调用。
 * 需要能看图，默认走 DashScope 的 OpenAI 兼容端点（Qwen-VL）。
 * 与对话大脑解耦——两者各走各的 baseURL / key / model。
 */
export function visionModel() {
  const provider = createOpenAICompatible({
    name: "workbench-vision",
    baseURL:
      process.env.VISION_BASE_URL ??
      "https://dashscope.aliyuncs.com/compatible-mode/v1",
    apiKey: requireEnv("VISION_API_KEY"),
  });
  return provider(process.env.VISION_MODEL ?? "qwen-vl-max");
}
