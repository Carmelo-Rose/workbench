import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

/**
 * A product-set template describes a *category* (caps today, possibly other
 * articles later) — never one article. Everything specific to the article being
 * photographed reaches the image model through the product reference image, so
 * the same bundle can drive any folder a designer drops in.
 */

const titleSchema = z.object({ chinese: z.string().min(1), english: z.string().min(1) });

export const productTemplateSchema = z.object({
  version: z.string().min(1),
  category: z.string().min(1),
  categoryLabel: z.string().min(1),
  /** Article-agnostic fidelity contract. Always sent first, at highest priority. */
  productLock: z.string().min(1),
  /** Canvas and safe-area rule shared by every generated slot. */
  framingRule: z.string().min(1),
  negative: z.string().min(1),
  /** Styling recipes, bound to colourways by rank rather than by colour name. */
  looks: z.array(z.object({ id: z.string().min(1), text: z.string().min(1) })).min(1),
  /** Per-slot shot direction, keyed by the two-digit slot id. */
  modelSlots: z.record(z.string(), z.object({ framing: z.string().min(1) })),
  pages: z.object({
    "10": z.object({ title: titleSchema }),
    "11": z.object({ title: titleSchema, caption: z.object({
      headline: z.string().min(1), english: z.string().min(1), sub: z.string().min(1),
    }) }),
  }),
  /** Slots served by a ready-made page shipped inside the bundle. */
  fixedSlots: z.record(z.string(), z.string().min(1)),
  /**
   * Optional brand wordmark stamped onto generated slots after the fact.
   *
   * It is composited rather than described in the prompt because image models
   * cannot be trusted to reproduce a wordmark's letterforms. Drop in `asset`
   * once a real logo file exists; the text form is only a stand-in.
   */
  brandMark: z.object({
    slots: z.array(z.string().min(1)).min(1),
    asset: z.string().min(1).optional(),
    text: z.string().min(1).optional(),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#0058a0"),
    fontSize: z.number().int().min(8).max(200).default(30),
  }).optional(),
});

export type ProductTemplate = z.infer<typeof productTemplateSchema>;

/** Shared camera/lens language appended to every generated slot, regardless of category. */
const CAMERA_STYLE =
  "哈苏 X2D 100C 拍摄，中画幅摄影，80mm f2.8 镜头，哈苏原生色彩配置文件，自然低饱和色彩，专业商业人像 / 静物摄影";

export async function loadProductTemplate(root: string): Promise<ProductTemplate> {
  const parsed = productTemplateSchema.safeParse(
    JSON.parse(await readFile(path.join(root, "template.json"), "utf8")),
  );
  if (!parsed.success) throw new Error(`商品套图模板格式错误: ${parsed.error.issues[0]?.message ?? "未知字段"}`);
  return parsed.data;
}

/**
 * Assemble one slot's prompt.
 *
 * Ordering is deliberate: the fidelity contract comes before the styling so the
 * model resolves any conflict in favour of the product. `colorRank` selects the
 * look positionally — colourway 0 always gets look A — because the pipeline
 * discovers colours from pixels and can never know their names.
 */
export function buildModelPrompt(
  template: ProductTemplate,
  slotId: string,
  colorRank: number,
  width: number,
  height: number,
): string {
  const slot = template.modelSlots[slotId];
  if (!slot) throw new Error(`模板缺少槽位 ${slotId} 的构图描述`);
  const look = template.looks[colorRank % template.looks.length];
  // TEST: 去掉商品还原/构图/禁止项三段规则，只留画风文案 + 摄影质感两段，
  // 配合参考图原图直接试效果。测试完记得视情况改回来。
  return [look.text, CAMERA_STYLE].join("\n\n");
  // return [
  //   `【商品还原 · 最高优先级】\n${template.productLock}`,
  //   `【画面风格】\n${look.text}`,
  //   `【构图】\n${template.framingRule}${slot.framing}成图比例 ${width}:${height}。`,
  //   `【禁止出现】\n${template.negative}`,
  //   `【摄影质感】\n${CAMERA_STYLE}`,
  // ].join("\n\n");
}
