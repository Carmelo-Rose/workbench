import type { ProductTemplate } from "@/lib/mono/product-template";
import type { DetailSlot } from "@/lib/mono/product-pipeline";
import type { IdentityGroupId } from "./types";

const CAMERA_STYLE =
  "哈苏 X2D 100C 拍摄，中画幅摄影，80mm f2.8 镜头，哈苏原生色彩配置文件，自然低饱和色彩，专业商业人像摄影";

const CASTING_PROMPTS: Record<IdentityGroupId, string> = {
  female:
    "生成一位原创中国年轻女性商业模特的清晰半身选角照。浅灰纯色影棚背景，正面略微侧转，面部完整无遮挡，五官清晰，表情自然，发型完整可见。自然雀斑妆、自然碎发，Y2K 甜酷与美式复古气质。穿无图案的中性色基础款上衣。不要帽子、眼镜、首饰、文字、Logo、水印或手部遮脸。人物必须是虚构身份，不模仿任何真实公众人物。",
  male:
    "生成一位原创中国年轻男性商业模特的清晰半身选角照。浅灰纯色影棚背景，正面略微侧转，面部完整无遮挡，五官清晰，表情自然，发型完整可见。休闲、年轻、自然的美式复古气质。穿无图案的中性色基础款上衣。不要帽子、眼镜、首饰、文字、Logo、水印或手部遮脸。人物必须是虚构身份，不模仿任何真实公众人物。",
};

export function castingPrompt(groupId: IdentityGroupId, candidateIndex: number): string {
  return `${CASTING_PROMPTS[groupId]}\n\n这是候选 ${candidateIndex + 1}，请生成与其他候选明显不同的原创面部身份。`;
}

export function identityGroupForLook(lookId: string): IdentityGroupId {
  if (lookId === "B") return "male";
  if (lookId === "A" || lookId === "C") return "female";
  throw new Error(`实验模板不支持 look ${lookId} 的身份分组`);
}

export function buildConsistencyPrompt(input: {
  template: ProductTemplate;
  slot: DetailSlot;
  colorRank: number;
  identityGroupId: IdentityGroupId;
}): string {
  const { template, slot, colorRank, identityGroupId } = input;
  const slotConfig = template.modelSlots[slot[0]];
  if (!slotConfig) throw new Error(`模板缺少槽位 ${slot[0]} 的构图描述`);
  const look = template.looks[colorRank % template.looks.length];
  return [
    "你将收到 4 张参考图，编号与输入顺序严格一致。",
    `【人物身份 · 最高优先级】\n参考图1是本套图片唯一的${identityGroupId === "female" ? "女" : "男"}模特身份。必须保持同一个人的脸型、五官比例、年龄感、肤色和辨识特征。允许按照本槽位改变姿势、视线、表情和基础服装，但不得换脸、混合身份或复制参考图1的原始姿势。`,
    `【商品还原 · 最高优先级】\n参考图2至参考图4是同一件帽子的多角度商品图，是商品外观的唯一权威。\n${template.productLock}`,
    `【画面风格】\n${look.text}`,
    `【构图】\n${template.framingRule}${slotConfig.framing}成图比例 ${slot[1]}:${slot[2]}。`,
    `【禁止出现】\n${template.negative}不得生成与参考图1不同的人物身份。`,
    `【摄影质感】\n${CAMERA_STYLE}`,
  ].join("\n\n");
}

