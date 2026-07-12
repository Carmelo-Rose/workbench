/**
 * 反推结果 → Image2 工作台的提示词交接。
 * 提示词可能很长，走 sessionStorage 而不是 URL query，避免编码与长度问题。
 */
const HANDOFF_PROMPT_KEY = "mono:image2:handoff-prompt";

export function stashImage2Prompt(prompt: string) {
  try {
    window.sessionStorage.setItem(HANDOFF_PROMPT_KEY, prompt);
  } catch {
    // 隐私模式等场景下 sessionStorage 不可用，跳转后由用户手动粘贴。
  }
}

/** 取出并清空暂存的提示词，保证刷新页面不会重复注入。 */
export function takeImage2Prompt(): string | undefined {
  try {
    const value = window.sessionStorage.getItem(HANDOFF_PROMPT_KEY);
    if (value !== null) window.sessionStorage.removeItem(HANDOFF_PROMPT_KEY);
    return value ?? undefined;
  } catch {
    return undefined;
  }
}
