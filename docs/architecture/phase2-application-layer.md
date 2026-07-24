# Phase 2：应用层与素材层

对应治理计划「2. 应用层与素材层」阶段。目标是搭好命令总线、能力注册表和素材位置
字段的骨架，且**不改动**任何现有入口的行为——工具面板、聊天路由、`/api/mono/*`、
`/api/workbench/mono/*` 全部原样保留，行为零变化。入口切换是 Phase 3 的事。

## 素材位置字段

- `mono_assets` 新增 `location` 列，取值 `local-storage` / `toolbox` / `tos` / `remote-url`
  （`src/lib/mono/contracts.ts` 的 `MonoAssetLocation`）。
- 新库：DDL 直接建列，`CHECK` 约束 + 默认值 `remote-url`。
- 老库：迁移只 `ALTER TABLE ADD COLUMN`（不带 CHECK，跟 v3 的 `favorite` 列一个思路），
  按 `storage_key IS NOT NULL → local-storage，否则 → remote-url` 回填一次。
  `PRAGMA user_version` 8 → 9。
- `storage_key`/`source_url` 不删不改，`location` 目前只是新增的显式标注，
  没有任何读路径依赖它——可随时回滚（drop column 或忽略即可，旧代码不读这一列）。
- `createMonoAsset`/`createAsset` 新增可选 `location` 入参，不传时按同样规则自动推断，
  现有调用方（`mono_create_asset` 工具、`createStoredAsset`、`chat/route.ts` 的
  `image2Response` 素材登记）全部不用改代码就能拿到正确值。
- **今天还没有任何代码会创建 `toolbox`/`tos` 这两种 location 的资产**——现有 Toolbox
  `fileId`、TOS 上传都是运行时按需产生、不落 `mono_assets` 表（见 Phase 1 基线文档），
  这两个枚举值是为 Phase 3/4 打通 Toolbox 副本自动创建预留的坑位，本轮只是把类型定义好。

## 能力命令与注册表

新增 `src/lib/workbench/`：

- `capability-command.ts` — `CapabilityCommand`（`capabilityId`/`input`/`assetIds`/`actor`/
  `threadId`/`idempotencyKey`）和 `CapabilityRun`（复用 `MonoJobStatus` 当状态枚举，
  没有另起一套）。`CapabilityNotFoundError extends MonoHttpError(404, ...)`，走既有的
  `monoErrorResponse` 错误映射，没有新增错误处理机制。
- `capability-registry.ts` — 四个现有 Mono 能力（`image_to_prompt`/`mono_analyze_video`/
  `mono_matting`/`mono_generate_image`）各一条注册项：`inputSchema` 直接复用
  `mono/contracts.ts` 里已有的 zod schema，`runSync`/`runAsync` 直接调用
  `mono/service.ts` 里未改动过的原函数（`analyzeImage`/`createVideoAnalysisJob`/
  `createMattingJob`/`createImageGenerationJob`）。**这是纯适配器层，没有重新实现任何业务逻辑。**
- `capability-bus.ts` — `runCapabilityCommand(command)`：查注册表 → 用注册项的
  `inputSchema.parse()` 校验 → 按 `mode` 分发。异步能力把命令信封上的顶层
  `idempotencyKey` 兜底合并进 `input`（不覆盖 `input` 里已有的值）；结果统一包成
  `CapabilityRun`，异步的直接用创建出的 `MonoJob` 映射（`jobToCapabilityRun`），
  同步的现算现包（`id` 是一次性的，不落库，不能拿去 GET 复查——跟今天
  `image_to_prompt` 工具的行为一致，不是新增限制）。

`tools/mono.ts`、`tools/image-to-prompt.ts` 里的 AI SDK 工具定义本轮**没有改**，
两边的能力描述文本目前有重复，留给 Phase 3 收口（届时工具定义应该反过来从注册表读，
而不是各自维护一份）。

## 统一能力执行接口

新增 `src/app/api/workbench/capability-runs/`：

- `POST /api/workbench/capability-runs`——body `{capabilityId, input, assetIds?, threadId?, idempotencyKey?}`，
  鉴权走既有的 `actorFromWorkbenchRequest`（跟 `/api/workbench/mono/*` 同一套 session）。
  异步能力 202，同步能力 200，跟现有 `/api/workbench/mono/generate/image` 的
  202 约定对齐。
- `GET /api/workbench/capability-runs/:id`——只能查到异步能力（背后是 `mono_jobs` 行）；
  同步能力的 run id 查不到是预期行为，404。响应体里的 `capabilityId` 由
  `capabilityIdForJobKind(job.kind)` 从 job 的 `kind` 反查（job 表本身不记
  `capabilityId`，这是现状，不是本轮引入的债）。
- `POST /api/workbench/capability-runs/:id/cancel`——直接复用 `cancelJob`，
  跟 `/api/workbench/mono/jobs/:id` 的 `DELETE` 语义等价，只是换了个统一路径。
- 三个路由都没有新建鉴权/隔离逻辑，全部委托给已经被 Phase 1 测试验证过的
  `getJob`/`cancelJob`（按 `actor.workspaceId` 过滤）。

## 测试

- [`src/lib/workbench/capability-bus.test.ts`](../../src/lib/workbench/capability-bus.test.ts)（6 用例）：
  四个能力路由正确、idempotencyKey 合并、未知 capabilityId 404、input 校验失败。
- [`src/app/api/workbench/capability-runs/capability-runs.test.ts`](../../src/app/api/workbench/capability-runs/capability-runs.test.ts)（6 用例）：
  POST/GET/cancel 全链路、状态码约定、sync run 不可复查、跨工作区隔离。
- [`src/lib/server/db.test.ts`](../../src/lib/server/db.test.ts) 新增一条 `location` 回填迁移测试
  （老库无 `location` 列 → 迁移后按 `storage_key` 正确分类）。

## 未覆盖 / 已知限制（留给 Phase 3+）

- `assetIds` 目前只是命令信封上的字段，**没有任何代码校验它与 `input` 内部的素材引用
  一致**（比如 `mono_generate_image` 的 `referenceAssetIds`/`subjectIds`）。现在只是占位。
- 同步能力（`image_to_prompt`）的结果不落库，`GET /capability-runs/:id` 查不到——如果
  Phase 3 需要聊天历史或 UI 复查同步能力的结果，需要重新评估要不要把它也落一条
  `mono_jobs` 记录（会涉及给 `kind` CHECK 加新枚举值，参考 v5 的重建表迁移）。
- 聊天路由（`forcedToolName`/`createMonoTools`）、工具面板、MCP 都还没有切到这个新接口，
  依旧走各自原来的路径——按计划这是 Phase 3「入口迁移」要做的事，本轮特意不碰，
  保持每条链路可独立回滚。
