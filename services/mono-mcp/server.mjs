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
      aspectRatio: z.enum(["1:1", "3:4", "9:16", "4:3", "16:9"]).optional(),
      variants: z.union([z.literal(1), z.literal(2), z.literal(4), z.literal(6)]).optional(),
      model: z.string().optional(),
      idempotencyKey: z.string().optional(),
    },
  }, async (input) => toolText(await callMono("/api/mono/generate/image", {
    method: "POST",
    body: JSON.stringify(input),
  })));

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
