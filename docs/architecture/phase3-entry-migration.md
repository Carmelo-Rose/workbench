# Phase 3：入口迁移

对应治理计划「3. 入口迁移」阶段。目标是让已注册进 `CAPABILITY_REGISTRY` 的四个
Mono 能力（`image_to_prompt`/`mono_analyze_video`/`mono_matting`/`mono_generate_image`）
的所有既有入口（外部 API、聊天工具）都经 Phase 2 建的命令总线
（`runCapabilityCommand`）分发，而不是各自重复直连 `mono/service.ts`。**约束和
Phase 2 一样：不改行为、不改对外响应形状**——迁移只是换内部分发路径，每个能力
可以单独用环境变量回滚，不需要发版。

## 按能力回滚开关

`src/lib/workbench/capability-registry.ts` 新增 `isCapabilityBusEnabled(capabilityId)`：
读 `WORKBENCH_CAPABILITY_BUS_DISABLED`（逗号分隔的 capabilityId 列表），命中的能力
在已迁移的入口里会跳过命令总线，退回迁移前直接调用 `mono/service.ts` 的旧路径。
每次调用都重新读环境变量，不需要重启进程；未设置或留空时全部走新总线（默认状态）。

## 外部 API（`/api/mono/*`）

`analyze/image`、`analyze/video`、`matting`、`generate/image` 四个路由改为：

1. 校验请求（`assertMonoApiAccess` + `parseMonoJson`，schema 不变——四个路由原本用
   的 schema 和注册表里的 `inputSchema` 本来就是同一个常量，Phase 2 就已经对齐）。
2. `isCapabilityBusEnabled(capabilityId)` 为 false 时，走迁移前的直连调用
   （`analyzeImage`/`createVideoAnalysisJob`/`createMattingJob`/`createImageGenerationJob`），
   response 逐字节不变。
3. 否则调用 `runCapabilityCommand`。同步能力（`image_to_prompt`）直接把
   `run.result` 塞回 `{result}`；异步能力用 `run.id`（就是 job id）回查一次
   `getJob` 拿完整 `MonoJob`，塞回 `{job}`（202）——命令总线内部返回的是瘦身过的
   `CapabilityRun`（没有 `kind`/`input`/`workspaceId`），直接透传会改变这个记录在案的
   外部响应契约，所以这里必须多一次读库把形状转回去。

`services/mono-mcp/server.mjs`（Model Context Protocol 适配器）本身**完全没有改
代码**：它只是把 `mono_analyze_image`/`mono_analyze_video`/`mono_matting`/
`mono_generate_image` 四个 MCP 工具转发到 `/api/mono/*` 的 HTTP 端点，上面这条
迁移保证了响应体形状不变，MCP 入口因此是透明受益、不是遗漏。

## 聊天工具（`tools/mono.ts`、`tools/image-to-prompt.ts`）

聊天工具的约束比外部 API 更紧：AI SDK 工具的 `execute()` 返回值会整段落进
assistant-ui 的消息历史，`src/components/workbench/MonoToolUI.tsx` 里的
`JobCard`/`ImageGenerationCard`/`VideoAnalysisCard`/`MattingCard` 直接读
`job.kind`/`job.input`/`job.status` 渲染卡片（比如「再次生成」要读
`job.input.referenceImageUrls`）——如果 `execute()` 改成直接返回命令总线的
`CapabilityRun`（没有 `input` 字段），首帧渲染就会因为访问 `undefined.referenceImageUrls`
直接抛错。这是设计草图阶段就发现、在写代码前用只读方式确认过的真实回归风险，
不是猜测。

所以三个异步能力的工具改法和 `/api/mono/*` 一样：调用 `runCapabilityCommand`
后再用 `run.id` 回查一次 `getJob`，返回值还是完整 `MonoJob`——`runJobCapability`
辅助函数封装了这个"总线分发 + 回查 + 回滚开关"的样板，三个工具共用。
`image_to_prompt` 工具同理，把 `run.result.prompt` 摘出来拼回原来的
`{imageUrl, prompt}` 形状，而不是透传 `run.result`（`{assetId, prompt, traceId}`）。

顺带消灭了 Phase 2 文档标注的重复：`mono_analyze_video`/`mono_generate_image`/
`image_to_prompt` 三个工具的 `description` 直接读
`getCapability(id)!.chatToolDescription`；`mono_matting` 的描述文本大部分来自
注册表，只在末尾追加一句聊天场景特有的提示（"用户直接发图片附件时可都不填"——
这句话对没有"附件"概念的外部 API 调用方没有意义，所以没有塞进注册表的共享文案）。
`mono_matting` 的 `inputSchema` 仍然是 `monoMattingBaseSchema`（不带 refine 的
版本）而不是注册表用的 `monoMattingSchema`——工具层需要接受"素材 id 和媒体 URL
都不填"，由 `execute()` 里的附件兜底逻辑先把 `assetId` 填上再喂给总线，这是
`contracts.ts` 里早就写明的"工具层用 base，API 层用带 refine 的完整版"分工，
Phase 3 没有改变这个分工，只是让两层最终都调用同一个总线函数。

## 聊天入口的分发顺序

`chat/route.ts` 里"显式命令 > 高置信规则 > 模型工具选择"的优先级在 Phase 1
基线里已经是现状（`image2Config` 直接绕过模型是"显式命令"；`forcedToolName`
强制 `toolChoice` 是"高置信规则"；两者都不命中时模型自由选工具）。Phase 3 没有
改这段路由逻辑本身——三个优先级最终调用的工具（`directTools` 里的
`mono_analyze_video`/`mono_matting`/`mono_generate_image`/`image_to_prompt`）
现在都经总线分发，所以"收敛成同一种命令"这件事是在工具执行层面完成的，不需要
再改一遍分发顺序的代码。

## 未覆盖 / 已知限制（留给 Phase 4+）

- `mono_create_asset`、`mono_list_subjects`、`mono_get_job`、`mono_cancel_job`
  等非"生成式能力"的工具/路由没有进注册表，也没有改动——它们是素材/任务管理
  操作，不是 Phase 2 定义的"能力"概念，继续走原来的路径。
- 抠像/生图/视频分析工具每次调用多了一次 `getJob` 读库（为了保形状），SQLite 单机
  读性能可忽略，但这个"总线返回瘦身结果、调用方再回查完整对象"的模式本身是个
  信号——Phase 4 独立 Worker 阶段如果要让命令总线成为唯一权威分发路径，应该
  重新设计 `CapabilityRun`/`jobToCapabilityRun` 直接携带调用方需要的完整字段，
  而不是让每个入口自己回查一次。
- 按能力回滚开关目前只在已迁移的四个入口生效；`/api/workbench/capability-runs`
  这个 Phase 2 新增的入口本身没有"旧行为"可回滚，不受这个开关影响，符合预期。
