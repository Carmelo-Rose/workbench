# Phase 5：收口

对应治理计划「5. 收口」阶段。计划原文列了四件事：删旧正则分支/文本标记/被
替代逻辑、移除临时回滚开关、保留外部兼容 API、写 ADR 和标准接入模板。本轮
完成后两项；前两项**有意推迟**，原因见下面「范围说明」——不是漏做，是判断
过后不该在这个时间点做。

## 新增能力/供应商/素材后端标准接入模板

### 新增一个 Mono 能力（比如"视频擦除"从工具专属迁移成正式能力）

1. **Schema**：在 `src/lib/mono/contracts.ts` 加 `monoXxxSchema`（zod）。工具
   层如果需要比 API 层更宽松的校验（比如某个字段可以延后由 `execute()` 里的
   兜底逻辑补齐，参考 `monoMattingBaseSchema` vs `monoMattingSchema` 的分工），
   拆成 base/完整两个 schema。
2. **执行入口**：在 `mono/service.ts` 写 `createXxxJob`（异步，落 `mono_jobs`，
   `kind` 加进 `monoJobKinds`）或者一个同步函数（参考 `analyzeImage`）。
   **不要**在这一步碰任何入口代码（聊天工具/外部 API/MCP）。
3. **注册能力**：在 `src/lib/workbench/capability-registry.ts` 的
   `CAPABILITY_REGISTRY` 加一条：`id`、`mode`（sync/async）、`assetKinds`、
   `chatToolDescription`（这是聊天工具描述文本的唯一来源，不要在 `tools/`
   目录下重复写一份）、`inputSchema`、`runSync`/`runAsync`、（异步的话）
   `jobKind`。
4. **接入具体入口**（可选，按需要开）：
   - 聊天工具：在 `src/lib/tools/mono.ts`（或独立文件，参考
     `tools/image-to-prompt.ts`）加一个 `tool()`，`description` 用
     `getCapability(id)!.chatToolDescription`，`execute()` 走
     `runCapabilityCommand`（异步能力记得用 `run.id` 回查 `getJob` 还原成完
     整 `MonoJob` 再返回，不要直接透传 `CapabilityRun`——见
     [phase3-entry-migration.md](phase3-entry-migration.md) 里踩过的坑：
     assistant-ui 的 `MonoToolUI` 卡片直接读 `job.input`/`job.kind`）。
   - 外部 API：在 `src/app/api/mono/xxx/route.ts` 加一个 POST handler，
     `assertMonoApiAccess` + `parseMonoJson`（用注册表同一个 schema）+
     `runCapabilityCommand`，响应形状跟你想暴露给外部调用方的契约保持一致
     （同样是"回查 getJob 还原成 {job}"或者"透传 run.result"）。
   - MCP：如果外部 API 已经加了，`services/mono-mcp/server.mjs` 加一个
     `server.registerTool(...)` 转发过去就行，不需要碰 Next.js 代码。
5. **回滚开关**（如果这是个有风险的新入口迁移）：入口代码里判断
   `isCapabilityBusEnabled(id)`（`src/lib/workbench/capability-registry.ts`），
   `false` 时退回不经过总线的直连调用。
6. **测试**：至少一个 characterization test 锁定 `createXxxJob`/同步函数的输
   入输出契约（参考 `src/lib/mono/*.test.ts` 的现有写法：mock `fetch`/
   `generateText`，不 mock SQLite），一个 capability-bus 层的路由测试（参考
   `capability-bus.test.ts`）。

### 新增一个供应商（比如换一个视频分析的模型服务商）

Provider 配置目前是扁平函数（`src/lib/models.ts` 的 `chatModel`/
`hermesModel`/`visionModel`，或者 `mono/service.ts` 里散落的
`getConfigValue("MONO_XXX_URL"/"MONO_XXX_API_KEY"/"MONO_XXX_MODEL")` 模式）。
新增供应商目前是加同样形状的一组 env/config key，本轮**没有**引入角色化的
Provider Profile 抽象——这在 [phase1-baseline.md](phase1-baseline.md) 里已经
记成现状，不是本轮的遗留任务。

### 新增一个素材后端（比如真正开始创建 Toolbox/TOS location 的资产）

在 `mono/service.ts`（或者一个新的 `mono/asset-backends/xxx.ts`）写创建这种
资产的函数，调 `createMonoAsset(actor, {..., location: "toolbox"})`——`assetId`
消费端（`getAssetSource`/`publicAssetUrl` 等）不需要改，因为它们只认
`assetId`，具体字节在哪由创建时选的 `location`/`storageKey` 决定。详见
[ADR 0002](adr/0002-unified-asset-location.md)。

## 范围说明：为什么没有删旧代码、没有移除回滚开关

计划原文："稳定后删旧正则分支/文本标记/被替代逻辑；移除临时回滚开关。"关键
词是**稳定后**——这个前提在本次会话里不成立：Phase 1-4 全部在同一个 session
里连续完成，新路径（能力总线、独立 Worker）从写完代码到现在只经过了自动化
测试，**没有任何真实生产流量验证过**。在这个前提下做以下几件事都是错误的：

- **删除 `chat/route.ts` 的 `forcedToolName` 正则分发**：这是聊天入口"显式
  命令 > 高置信规则 > 模型工具选择"三级优先级里的中间一级，不是"被新架构
  替代的旧逻辑"——[phase3-entry-migration.md](phase3-entry-migration.md) 已
  经说明白：新的能力总线只是让三级优先级最终调用的工具收敛到同一个执行路
  径，没有改变分发顺序本身。这条正则规则现在还在正常工作，删掉是纯粹的功
  能回退，不是收口。
- **删除 `latestVideoAssetId` 文本标记提取**：计划原文点名这是"要用结构化
  `data-asset` part 替换掉的文本标记方案"，但本轮没有做那个替换（不在
  Phase 1-4 的范围内），所以没有可以删除的"旧的一份"。
- **移除 `WORKBENCH_CAPABILITY_BUS_DISABLED`（Phase 3）/`MONO_WORKER_MODE`/
  `MONO_JOB_MAX_ATTEMPTS`（Phase 4）**：前者是典型的"证明新路径没问题就可
  以删掉"的迁移期开关，但"证明"需要时间和真实流量，不是写完测试就等于证明
  完毕。后两者按 [ADR 0004](adr/0004-dual-mode-worker-rollback.md) 的判断，
  根本不属于"临时"开关，是长期部署配置项，计划里这条"移除回滚开关"的适用
  范围不包括它们。

**如果你（用户）判断不需要这段观察期**——比如这就是一次性内部工具、没有生
产流量需要担心——明确告诉我要不要现在就删，我可以照做；但在没有这个明确
指令之前，保留这些开关是更负责任的默认选择，不是我漏做了这一步。
