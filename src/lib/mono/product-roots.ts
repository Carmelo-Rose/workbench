/**
 * Server-only roots shared by the production product pipeline and the
 * temporary model-pair adapter. Keeping them outside product-pipeline.ts avoids
 * making reusable model assets depend on the runner itself.
 */
export function productSourceRoot(): string {
  return process.env.PRODUCT_PIPELINE_SOURCE_ROOT
    ?? "\\\\192.168.1.99\\picture\\型麦-得物-品牌\\【原图】-待制作";
}

export function productDetailPageRoot(): string {
  return process.env.PRODUCT_PIPELINE_DETAIL_ROOT
    ?? "\\\\192.168.1.99\\picture\\型麦-得物-品牌\\【详情页】-待审";
}
