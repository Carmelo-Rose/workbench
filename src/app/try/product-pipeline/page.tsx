import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isProductPipelineTrialEnabled } from "@/lib/try/product-pipeline-trial";
import { ProductPipelineTrial } from "./ProductPipelineTrial";

export const metadata: Metadata = {
  title: "商品套图体验",
  description: "商品套图临时体验页",
  robots: {
    index: false,
    follow: false,
    nocache: true,
  },
};

export const dynamic = "force-dynamic";

export default function ProductPipelineTrialPage() {
  if (!isProductPipelineTrialEnabled()) notFound();
  return <ProductPipelineTrial />;
}
