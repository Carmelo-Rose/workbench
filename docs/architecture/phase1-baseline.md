# Phase 1 基线：冻结与特性化测试

对应治理计划「1. 冻结与基线」阶段。目标不是改行为，是把当前行为用测试和文档锁住，
给 Phase 2 起的应用层/Worker 拆分一个可对照的回归基线。本文档只记录本轮实际补了测试
的链路，没有测试覆盖的部分放在文末「未覆盖」里，不编造。

分支：`arch/workbench-governance`（从 main `1a3ec08` checkpoint 切出）。

## 1. 图片反推（Image Analysis）

- 入口：`mono/service.ts` 的 `analyzeImage(actor, input)`。
- 依赖：`ai` 的 `generateText` + `@/lib/models` 的 `visionModel(workspaceId)`（DashScope Qwen-VL 兼容协议）。
- 素材解析：`assetId` → 若素材落本地存储（`storageKey` 非空）解析成内部可取回 URL
  `${WORKBENCH_PUBLIC_URL}/api/workbench/mono/assets/{assetId}/content`；否则直接用 `sourceUrl`。
  `data:` URL 原样以字符串传给模型（不包成 `URL` 实例），普通 URL 包成 `URL` 实例。
- 请求体示例（`outputFormat: "prompt"`）：
  ```json
  {
    "messages": [{
      "role": "user",
      "content": [
        { "type": "text", "text": "<反推指令文本，含 focus 追加>" },
        { "type": "image", "image": "https://.../cat.png 或 data: URL 或内部 content URL" }
      ]
    }]
  }
  ```
- `outputFormat: "json"` 时 instruction 改为强制输出固定字段的 JSON（`subject/style/lighting/composition/color_palette/mood/details/prompt_en/prompt_cn`）。
- 返回：`{ assetId, prompt: text.trim(), traceId }`。
- 测试：[`src/lib/mono/analyze-image.test.ts`](../../src/lib/mono/analyze-image.test.ts)（4 个用例）。

## 2. 视频反推（Video Analysis）

- 入口：`createVideoAnalysisJob` 建 job → 异步 `dispatchJob` → 内部 `runVideoAnalysis`。
- 走裸 `fetch` 调用 `chat/completions`（非 `ai` SDK，因为需要 `video_url` 内容块），端点优先级
  `MONO_VIDEO_ANALYZE_URL` > `VISION_BASE_URL` > DashScope 默认地址；`apiKey` 优先级
  `MONO_VIDEO_API_KEY` > `VISION_API_KEY`；`model` 优先级 `input.model` > `MONO_VIDEO_MODEL` >
  `VISION_MODEL` > `qwen-vl-max`。
- 视频内容解析三路分流（`resolveVideoContent`）：
  1. 本地存储素材，估算 base64 体积 ≤10MiB（体积×1.37）→ 内嵌 `data:` URI。
  2. 本地存储素材，超过阈值 → 上传 TOS（`uploadVideoToTosAndGetUrl`），用一小时预签名 URL。
  3. 抖音分享链接（`v.douyin.com/...`）→ 先调用解析服务换成直链；未配置 `MONO_VIDEO_RESOLVE_URL` 直接报错。
  4. 普通直链 → 原样透传。
- 请求体示例：
  ```json
  {
    "model": "mono-video-analysis",
    "messages": [{
      "role": "user",
      "content": [
        { "type": "text", "text": "请总结视频内容、镜头语言、节奏、音频和可复用的创作提示词。" },
        { "type": "video_url", "video_url": { "url": "<data: URI 或 TOS 预签名 URL 或直链>" } }
      ]
    }]
  }
  ```
- 成功结果落 job：`{ text, model, provider: "vision" }`，job 状态 `succeeded`。
- 失败：非 2xx 响应时用 `error.message` 或 `视频分析服务返回 HTTP {status}` 作为 job 的 `error`，状态 `failed`。
- 测试：[`src/lib/mono/video-analysis.test.ts`](../../src/lib/mono/video-analysis.test.ts)（4 个用例：直链、内嵌小体积、TOS 大体积、失败态）。

## 3. Image2 生图

- 入口：`createImageGenerationJob` 建 job（同步做完素材/主体解析和 prompt 编译）→ 异步 `runImageGenerationBatch`。
- 参考图合并顺序：模板默认参考图 → `referenceImageUrls` → `referenceAssetIds` 解析出的 URL →
  主体快照 `sourceUrl`；非结构化模板会 `Set` 去重；合计 **超过 6 张直接 400**（
  `参考图与主体图片合计 N 张，最多允许 6 张`），在建 job 前就抛错，不产生 job 记录。
- Prompt 编译（`compileSubjectPrompt`）：`@主体名` 文本替换成 `参考图N（主体名）`；有参考图时整体包一层
  「你将收到 N 张参考图，编号与输入图片顺序一致。请严格按编号理解用户指令。」的前缀。
- 单槽请求体（`runSingleImageGeneration`，POST `${MONO_IMAGE_BASE_URL}/v1/api/generate` 或
  `MONO_IMAGE_GENERATE_URL` 覆盖）：
  ```json
  {
    "model": "gpt-image-2（或 template.model / input.model / MONO_IMAGE_MODEL 覆盖）",
    "prompt": "<编译后的 prompt>",
    "images": ["<参考图 URL 列表>"],
    "aspectRatio": "1:1",
    "replyType": "json"
  }
  ```
- 直接返回图片 URL 时立即完成；否则按 `id`/`task_id` 轮询 `${MONO_IMAGE_RESULT_URL 或 base/v1/api/result}?id=`，
  每 3 秒一次，120 秒超时（`图片生成任务超时`）。
- 每个 slot（`variants` 张）独立重试，`MAX_IMAGE_ATTEMPTS=3`；`variants` 张 slot 用 `Promise.all` 并发跑，
  互不阻塞。
- job 按 `(workspace_id, idempotencyKey)` 去重：同 key 二次调用直接返回已存在的 job，不新建。
- 结果形状：`{ slots: [{index, status, attempt, imageUrl?, error?}], succeeded, failed, provider: "mono-image", model }`。
- 测试：[`src/lib/mono/image-generation.test.ts`](../../src/lib/mono/image-generation.test.ts)（6 个用例：请求体、重试成功、并发多图、主体解析、超限拒绝、幂等去重）。

## 4. 多租户资产隔离

- 现状：无 ORM/中间件强制隔离，每个 store 函数手写 `WHERE workspace_id = ?`。测试前是这个代码库
  **唯一没有回归覆盖**的隔离面（`tenant.test.ts` 只测了 threads/api_config）。
- 验证结果：`getMonoAsset`/`getMonoJob`/`listMonoJobs`/`setMonoJobFavorite`/`purgeMonoJob` 均正确按
  `actor.workspaceId` 过滤，跨工作区读取返回 `null`/空列表/`false`（不是抛错）；`createVideoAnalysisJob`/
  `createMattingJob` 在引用他人工作区的 `assetId` 时会在建 job 前抛 `MonoHttpError(400, "素材不存在，或不属于当前工作区")`。
  本轮测试下**没有发现隔离缺口**——现状是安全的，只是此前完全没有测试锁定。
- 测试：[`src/lib/mono/asset-isolation.test.ts`](../../src/lib/mono/asset-isolation.test.ts)（4 个用例）。

## 5. 模型协议

- 三个扁平、独立配置的 provider 函数，无角色化 Provider Profile 抽象：
  - `chatModel()`：`CHAT_BASE_URL`（默认 DeepSeek）+ `CHAT_API_KEY`（必填，否则抛错）+ `CHAT_MODEL`
    （默认 `deepseek-chat`）。命中 DashScope/`maas.aliyuncs.com` 域名时自动注入
    `transformRequestBody` 强制 `enable_thinking: false`（Qwen thinking 模式不支持强制 tool_choice）。
  - `hermesModel()`：`HERMES_BASE_URL`（默认 `http://127.0.0.1:8642/v1`）+ `HERMES_API_KEY`（必填）+
    `HERMES_MODEL`（默认 `hermes-agent`），自带一个包装过的 `fetch`（把 Hermes 的 SSE 活动帧转成
    `reasoning_content` 增量）。
  - `visionModel(workspaceId)`：`VISION_BASE_URL`（默认 DashScope 兼容地址）+ `VISION_API_KEY`（必填，
    按工作区读取）+ `VISION_MODEL`（默认 `qwen-vl-max`）。
- 聊天路由的确定性分发（`chat/route.ts`，为了测试把 `forcedToolName`/`latestVideoAssetId` 加了
  `export`，纯签名改动，已跑 `next build` 确认不影响路由收集）：
  - `forcedToolName(userText, hasImageAttachment)`：五组正则规则，按顺序
    图片反推 → 视频分析 → 抠像 → 生图 → 罗盘榜单异动；视频分析规则必须排在生图前面，
    因为「反推视频提示词」同时命中两者的关键词。
  - `latestVideoAssetId(messages)`：从最后一条**用户**消息文本正则提取 `asset_<uuid>`，
    这是计划里要用结构化 `data-asset` part 替换掉的文本标记方案之一。
- 测试：[`src/lib/models.test.ts`](../../src/lib/models.test.ts)（8 个用例）、
  [`src/app/api/chat/forced-tool.test.ts`](../../src/app/api/chat/forced-tool.test.ts)（21 个用例）。

## 未覆盖（本轮不做，留给后续阶段排优先级）

- 抠像（matting，`runMatting`/ComfyUI 链路）、视频增强（enhance）、视频擦除（erase）、Toolbox
  `fileId` 直连链路（`submitJob`/`getJob`/poster）——原计划 Phase 1 明确点名的五项
  （图片反推/视频反推/Image2/多租户/模型协议）已全部覆盖，这几项不在点名范围内，未补测试。
- `mono_jobs` 表已有 `idempotency_key` 但没有 lease/retry/next_run_at/worker_id，`globalThis.__monoWorker`
  是进程内单例调度——这是 Phase 4 独立 Worker 要解决的问题，本轮只锁定现状，不改造。
- 测试过程中发现：`createImageGenerationJob`/`createVideoAnalysisJob`/`createMattingJob` 内部调用的
  `scheduleMonoWorker()` 是 fire-and-forget 的 `setImmediate`，不被任何地方 await。三个新测试文件
  （`asset-isolation`/`video-analysis`/`image-generation`）因此在 `afterAll` 里加了一次显式的
  worker flush，避免这个后台调度在测试清理阶段（`WORKBENCH_DB_PATH` 已还原）才触发，误连到真实的
  `data/workbench.db`。这本身是 Phase 4「独立 Worker + 可观测队列」要解决的架构问题的一个具体症状，
  不在本轮修，供 Phase 4 参考。

## Phase 2-5 路线图（摘要，供下次会话接续）

> Phase 2 已完成，详见 [phase2-application-layer.md](phase2-application-layer.md)。
> Phase 3 已完成，详见 [phase3-entry-migration.md](phase3-entry-migration.md)。
> Phase 4 已完成，详见 [phase4-worker.md](phase4-worker.md)。
> Phase 5（ADR + 接入模板部分）已完成，详见 [phase5-closeout.md](phase5-closeout.md)；
> "删旧代码/移除回滚开关"两项有意推迟，理由见该文档。

1. **应用层与素材层**（✅ 已完成）：能力命令总线 + 注册表；统一 `assetId`，新增素材位置字段
   （local-storage/toolbox/tos/remote-url），回填现有 `storage_key`/URL/Toolbox 引用；旧表旧字段先留着。
2. **入口迁移**（✅ 已完成）：`/api/mono/*` 外部 API（含间接受益的 MCP 转发）和聊天工具
   （`tools/mono.ts`、`tools/image-to-prompt.ts`）都改为经命令总线分发，响应/返回形状保持
   逐字节兼容；按能力逐项加了 `WORKBENCH_CAPABILITY_BUS_DISABLED` 回滚开关。
3. **独立 Worker**（✅ 已完成）：`mono_jobs` 加 lease/attempt_count/next_run_at/worker_version，
   新增 `mono_workers` 心跳表；`scripts/mono-worker.ts`（`npm run mono:worker`）是可独立启停的
   进程，靠 SQLite 原子 UPDATE 跟 web 进程协调，`MONO_WORKER_MODE=standalone` 时 web 进程只入队；
   `MONO_JOB_MAX_ATTEMPTS` 默认 1（行为不变），可调大启用队列级退避重试；
   `GET /api/mono/worker/status` 展示心跳/队列深度/最老排队年龄/失败率。
4. **收口**（🟡 部分完成）：ADR（[docs/architecture/adr/](adr/)）和标准接入模板
   （[phase5-closeout.md](phase5-closeout.md)）已完成；"稳定后删旧正则分支/文本标记/被替代
   逻辑、移除临时回滚开关"两项有意推迟到有真实运行数据之后，理由和范围界定见
   [phase5-closeout.md](phase5-closeout.md)。
