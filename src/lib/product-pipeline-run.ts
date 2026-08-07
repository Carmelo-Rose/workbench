"use client";

import type { useAui } from "@assistant-ui/react";

export type ProductPipelineRunConfig = {
  folderId: string;
  workflowId: string;
  /** Every newly created 商品套图 carries this; kept optional so legacy job cards can render. */
  modelPairId?: string;
  /** Display label only — echoed straight back to the card, never stored on the job. */
  folderName?: string;
  onlySlots?: string[];
  onlyMain?: string[];
  retryMain?: boolean;
};

/**
 * Set for the duration of a single `startProductPipelineRun` call and read by
 * `BackendModelContext` (backend-select.tsx) at request-prep time, the same
 * way image2-mode.ts's `getCurrentImage2ChatConfig` works. A plain module
 * variable is enough — nothing needs to re-render off this value, it only
 * has to be current when `AssistantChatTransport` builds the request body.
 */
let pending: ProductPipelineRunConfig | undefined;

/**
 * Reading consumes it. Unlike `image2`, which is a mode the user switches on
 * and every subsequent message should carry, this is a single action: the
 * chat route creates a paid job and skips the model entirely whenever it sees
 * this config, so leaving it readable for even one more request means the next
 * thing the user types both starts a second run and never reaches the model.
 *
 * The send path is not the only caller — `unstable_useMentionAdapter` reads the
 * merged model context too, though only when the "@" menu is actually opened.
 * Losing the config to that is the failure this is chosen for: the run simply
 * never starts and the user retries, which is the cheap direction to be wrong
 * in when the alternative charges for a second set of model images.
 */
export function getCurrentProductPipelineConfig(): ProductPipelineRunConfig | undefined {
  const config = pending;
  pending = undefined;
  return config;
}

/**
 * Sends a real chat turn whose only purpose is to carry `config.productPipeline`
 * to /api/chat. The server (productPipelineResponse in src/app/api/chat/route.ts)
 * creates/reuses the job and synthesizes the mono_product_pipeline tool result
 * directly — no model call — so the resulting card is a real, persisted
 * assistant turn instead of a client-only splice.
 */
export function startProductPipelineRun(
  aui: ReturnType<typeof useAui>,
  config: ProductPipelineRunConfig,
  messageText: string,
): void {
  pending = config;
  aui.thread().append({
    content: [{ type: "text", text: messageText }],
    runConfig: aui.composer().getState().runConfig,
  });
  // `append()` dispatches the send asynchronously (React state update → effect
  // → AssistantChatTransport.prepareSendMessagesRequest), so `pending` cannot
  // be cleared synchronously here — the request would go out without it.
  // `getCurrentProductPipelineConfig` clears it on read instead; this timer is
  // only a safety net for the case where that send never happens at all (the
  // component unmounts, the transport errors), so a stale config cannot ride
  // along on some unrelated message minutes later.
  window.setTimeout(() => { pending = undefined; }, 10_000);
}
