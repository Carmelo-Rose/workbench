import { createServer } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import * as z from "zod/v4";

const port = Number.parseInt(process.env.MONO_MCP_PORT ?? "8787", 10);
const serviceUrl = (process.env.MONO_SERVICE_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");
const mcpApiKey = process.env.MONO_MCP_API_KEY ?? "";
const platformApiKey = process.env.MONO_PLATFORM_API_KEY ?? "";

function secretEquals(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function requestTraceHeaders() {
  return {
    "x-mono-trace-id": `mcp_${randomUUID()}`,
  };
}

async function callMono(path, init = {}) {
  const headers = {
    "content-type": "application/json",
    ...requestTraceHeaders(),
    ...(platformApiKey ? { authorization: `Bearer ${platformApiKey}` } : {}),
    ...init.headers,
  };
  const response = await fetch(`${serviceUrl}${path}`, { ...init, headers });
  const body = await response.json().catch(() => ({ error: "Mono 服务返回了无效 JSON" }));
  if (!response.ok) throw new Error(body.error ?? `Mono 服务返回 HTTP ${response.status}`);
  return body;
}

function toolText(value) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function createMonoMcpServer() {
  const server = new McpServer({ name: "mono-creative", version: "0.1.0" });

  server.registerTool("mono_create_asset", {
    title: "Create Mono asset",
    description: "Register an image or video URL as a Mono workspace asset.",
    inputSchema: {
      sourceUrl: z.string().min(1),
      mimeType: z.string().optional(),
      name: z.string().optional(),
    },
  }, async (input) => toolText(await callMono("/api/mono/assets", {
    method: "POST",
    body: JSON.stringify(input),
  })));

  server.registerTool("mono_list_subjects", {
    title: "List Mono subjects",
    description: "List private and workspace-shared image subjects visible to the configured Mono actor.",
    inputSchema: {},
  }, async () => toolText(await callMono("/api/mono/subjects")));

  server.registerTool("mono_create_subject", {
    title: "Create Mono subject",
    description: "Create a reusable one-image subject from an existing Mono asset.",
    inputSchema: {
      name: z.string().min(1).max(40),
      assetId: z.string().min(1),
      visibility: z.enum(["private", "workspace"]).optional(),
    },
  }, async (input) => toolText(await callMono("/api/mono/subjects", {
    method: "POST",
    body: JSON.stringify(input),
  })));

  server.registerTool("mono_update_subject", {
    title: "Update Mono subject",
    description: "Rename a subject or change its private/workspace visibility. Only the creator can update it.",
    inputSchema: {
      subjectId: z.string().min(1),
      name: z.string().min(1).max(40).optional(),
      visibility: z.enum(["private", "workspace"]).optional(),
    },
  }, async ({ subjectId, ...patch }) => toolText(await callMono(`/api/mono/subjects/${encodeURIComponent(subjectId)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  })));

  server.registerTool("mono_delete_subject", {
    title: "Delete Mono subject",
    description: "Delete a reusable subject record without deleting its underlying asset.",
    inputSchema: { subjectId: z.string().min(1) },
  }, async ({ subjectId }) => toolText(await callMono(`/api/mono/subjects/${encodeURIComponent(subjectId)}`, {
    method: "DELETE",
  })));

  server.registerTool("mono_analyze_image", {
    title: "Analyze image prompt",
    description: "Reverse an image into reusable Chinese and English creation prompts.",
    inputSchema: {
      assetId: z.string().optional(),
      imageUrl: z.string().optional(),
      focus: z.string().optional(),
    },
  }, async (input) => toolText(await callMono("/api/mono/analyze/image", {
    method: "POST",
    body: JSON.stringify(input),
  })));

  server.registerTool("mono_analyze_video", {
    title: "Create video analysis job",
    description: "Submit a video analysis job and return a persistent job id.",
    inputSchema: {
      assetId: z.string().optional(),
      videoUrl: z.string().url().optional(),
      focus: z.string().optional(),
      model: z.string().optional(),
      idempotencyKey: z.string().optional(),
    },
  }, async (input) => toolText(await callMono("/api/mono/analyze/video", {
    method: "POST",
    body: JSON.stringify(input),
  })));

  server.registerTool("mono_generate_image", {
    title: "Create image generation job",
    description: "Submit an Image2 batch generation job with templates, references, aspect ratio, and 1/2/4/6 variants.",
    annotations: { destructiveHint: false, openWorldHint: true },
    inputSchema: {
      prompt: z.string().min(1),
      templateId: z.enum(["tpl-ecommerce", "tpl-replace-product", "tpl-ref-gen", "tpl-night-flash", "tpl-mid-century", "tpl-triptych"]).optional(),
      templateReferencesEnabled: z.boolean().optional(),
      referenceAssetIds: z.array(z.string()).optional(),
      referenceImageUrls: z.array(z.string()).max(6).optional(),
      structuredReferences: z.object({
        productAssetId: z.string().min(1),
        sceneAssetId: z.string().min(1),
      }).optional(),
      subjectIds: z.array(z.string().min(1)).max(6).optional(),
      aspectRatio: z.enum(["1:1", "3:4", "9:16", "4:3", "16:9"]).optional(),
      variants: z.union([z.literal(1), z.literal(2), z.literal(4), z.literal(6)]).optional(),
      model: z.string().optional(),
      idempotencyKey: z.string().optional(),
    },
  }, async (input) => toolText(await callMono("/api/mono/generate/image", {
    method: "POST",
    body: JSON.stringify(input),
  })));

  server.registerTool("mono_matting", {
    title: "Create matting job",
    description: "Submit a subject matting / background replacement job for an image or video asset.",
    inputSchema: {
      assetId: z.string().optional(),
      mediaUrl: z.string().url().optional(),
      mediaType: z.enum(["image", "video"]).optional(),
      backgroundColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
      backgroundAssetId: z.string().optional(),
      idempotencyKey: z.string().optional(),
    },
  }, async (input) => toolText(await callMono("/api/mono/matting", {
    method: "POST",
    body: JSON.stringify(input),
  })));

  registerLuopanTools(server);

  server.registerTool("mono_get_job", {
    title: "Get Mono job",
    description: "Read the state, result, or error for a Mono task.",
    inputSchema: { jobId: z.string().min(1) },
  }, async ({ jobId }) => toolText(await callMono(`/api/mono/jobs/${encodeURIComponent(jobId)}`)));

  server.registerTool("mono_cancel_job", {
    title: "Cancel Mono job",
    description: "Cancel a queued or running Mono task.",
    inputSchema: { jobId: z.string().min(1) },
  }, async ({ jobId }) => toolText(await callMono(`/api/mono/jobs/${encodeURIComponent(jobId)}`, {
    method: "DELETE",
  })));

  return server;
}

/**
 * 罗盘数据只读工具：直接转发采集机上的 luopan sidecar API
 * （services/luopan-api/server.py），未配置 LUOPAN_API_URL 时不注册。
 */
function registerLuopanTools(server) {
  const luopanUrl = (process.env.LUOPAN_API_URL ?? "").replace(/\/$/, "");
  if (!luopanUrl) return;
  const luopanToken = process.env.LUOPAN_API_TOKEN ?? "";

  async function callLuopan(path, params = {}) {
    const url = new URL(`${luopanUrl}${path}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
    }
    const response = await fetch(url, {
      headers: luopanToken ? { authorization: `Bearer ${luopanToken}` } : {},
    });
    const body = await response.json().catch(() => ({ error: "罗盘数据服务返回了无效 JSON" }));
    if (!response.ok) throw new Error(body.error ?? `罗盘数据服务返回 HTTP ${response.status}`);
    return body;
  }

  const scopePrefix = z.enum(["video_order", "video_acc", "card_order"]).optional();

  server.registerTool("luopan_query_rounds", {
    title: "List Luopan capture rounds",
    description: "List Douyin Compass monitoring capture rounds (run ids and counts).",
    inputSchema: { scopePrefix, limit: z.number().int().min(1).max(50).optional() },
  }, async (input) => toolText(await callLuopan("/api/rounds", { scope_prefix: input.scopePrefix, limit: input.limit })));

  server.registerTool("luopan_query_snapshot", {
    title: "Query Luopan ranking snapshot",
    description: "Query the TOP200 ranking snapshot of one capture round.",
    inputSchema: {
      runId: z.string().optional(),
      scopeKey: z.string().optional(),
      scopePrefix,
      limit: z.number().int().min(1).max(200).optional(),
      offset: z.number().int().min(0).optional(),
    },
  }, async (input) => toolText(await callLuopan("/api/snapshot", {
    run_id: input.runId,
    scope_key: input.scopeKey,
    scope_prefix: input.scopePrefix,
    limit: input.limit,
    offset: input.offset,
  })));

  server.registerTool("luopan_product_trend", {
    title: "Query product rank trend",
    description: "Query one product's rank trajectory across capture rounds.",
    inputSchema: { productId: z.string().min(1), scopeKey: z.string().optional(), limit: z.number().int().min(1).max(100).optional() },
  }, async (input) => toolText(await callLuopan(`/api/products/${encodeURIComponent(input.productId)}/trend`, {
    scope_key: input.scopeKey,
    limit: input.limit,
  })));

  server.registerTool("luopan_query_events", {
    title: "Query Luopan ranking events",
    description: "Query ranking diff events: NEW_ENTRY and RANK_UP_50/100/150.",
    inputSchema: {
      eventType: z.enum(["NEW_ENTRY", "RANK_UP_50", "RANK_UP_100", "RANK_UP_150"]).optional(),
      scopePrefix,
      runId: z.string().optional(),
      limit: z.number().int().min(1).max(200).optional(),
    },
  }, async (input) => toolText(await callLuopan("/api/events", {
    event_type: input.eventType,
    scope_prefix: input.scopePrefix,
    run_id: input.runId,
    limit: input.limit,
  })));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

async function writeWebResponse(response, nodeResponse) {
  nodeResponse.statusCode = response.status;
  for (const [key, value] of response.headers) nodeResponse.setHeader(key, value);
  if (!response.body) return nodeResponse.end();
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      nodeResponse.write(Buffer.from(value));
    }
  } finally {
    nodeResponse.end();
  }
}

const app = createServer(async (request, response) => {
  if (request.url?.split("?")[0] !== "/mcp") {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "Not found" }));
    return;
  }
  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "POST, GET, DELETE, OPTIONS",
      "access-control-allow-headers": "authorization, content-type, mcp-protocol-version, mcp-session-id",
    });
    response.end();
    return;
  }
  const authorization = request.headers.authorization;
  const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!mcpApiKey || !secretEquals(token, mcpApiKey)) {
    response.writeHead(401, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "Unauthorized" }));
    return;
  }

  try {
    const body = ["GET", "HEAD"].includes(request.method ?? "") ? undefined : await readBody(request);
    const headers = new Headers();
    for (const [key, value] of Object.entries(request.headers)) {
      if (Array.isArray(value)) headers.set(key, value.join(", "));
      else if (value !== undefined) headers.set(key, value);
    }
    const webRequest = new Request(`http://${request.headers.host ?? "127.0.0.1"}${request.url}`, {
      method: request.method,
      headers,
      body,
    });
    const transport = new WebStandardStreamableHTTPServerTransport();
    const server = createMonoMcpServer();
    await server.connect(transport);
    const webResponse = await transport.handleRequest(webRequest);
    await writeWebResponse(webResponse, response);
    await server.close();
  } catch (error) {
    console.error("[mono-mcp] request failed", error);
    if (!response.headersSent) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null }));
    }
  }
});

app.listen(port, () => {
  console.log(`[mono-mcp] listening on http://127.0.0.1:${port}/mcp`);
  console.log(`[mono-mcp] forwarding to ${serviceUrl}`);
});
