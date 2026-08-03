/**
 * 欢迎页文案池——刻意不嵌入产品名，只说能力本身，这样加新能力时不用
 * 为了塞产品名重写一遍（对齐 P1-5：产品名统一后，欢迎语不再依赖它）。
 */
export const WELCOME_COPY: readonly string[] = [
  "今天想生成点什么？",
  "有商品图要出吗？",
  "描述一下你想要的画面",
  "需要图片、视频，还是聊聊数据？",
  "从一句话开始",
  "今天要做点什么",
];

export function pickWelcomeCopy(): string {
  return WELCOME_COPY[Math.floor(Math.random() * WELCOME_COPY.length)] ?? WELCOME_COPY[0];
}
