/** 把 /api/chat 抛回的英文技术错误翻译成用户能看懂的中文提示。 */
export function translateChatError(raw: unknown): { title: string; detail: string } {
  const detail = raw instanceof Error ? raw.message : String(raw ?? "发生未知错误");
  const lower = detail.toLowerCase();

  if (lower.includes("econnrefused") || lower.includes("cannot connect")) {
    return { title: "无法连接到模型服务，请检查后端是否已启动", detail };
  }
  if (lower.includes("etimedout") || lower.includes("timeout") || lower.includes("timed out")) {
    return { title: "请求超时，请稍后重试", detail };
  }
  if (lower.includes("401") || lower.includes("unauthorized") || lower.includes("api key")) {
    return { title: "身份验证失败，请检查 API Key 配置", detail };
  }
  if (lower.includes("429") || lower.includes("rate limit")) {
    return { title: "请求过于频繁，请稍后重试", detail };
  }
  if (/\b5\d{2}\b/.test(detail)) {
    return { title: "服务端出错，请稍后重试", detail };
  }
  return { title: "发生错误，请重试", detail };
}
