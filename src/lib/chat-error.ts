/** 把 /api/chat 抛回的英文技术错误翻译成用户能看懂的中文提示。 */
export function translateChatError(raw: unknown): { title: string; detail: string } {
  const detail = raw instanceof Error ? raw.message : String(raw ?? "发生未知错误");

  // 早退路由（requireGrant 权限校验、mono 参数校验等）失败时不走流式协议，
  // 直接返回 `{ error: "人话原因" }` 的 JSON；HttpChatTransport 看到
  // !response.ok 只会把整个响应体原样塞进 Error.message。这里优先把它解开，
  // 不然真实原因（比如权限不足）会被下面的英文关键词兜底吞掉，
  // 只剩一句「发生错误，请重试」。
  try {
    const parsed: unknown = JSON.parse(detail);
    if (parsed && typeof parsed === "object" && "error" in parsed && typeof parsed.error === "string" && parsed.error) {
      return { title: parsed.error, detail };
    }
  } catch {
    // 不是 JSON，走下面的字符串特征匹配。
  }

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
