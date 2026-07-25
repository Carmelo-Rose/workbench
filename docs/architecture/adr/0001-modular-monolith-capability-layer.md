# ADR 0001：模块化单体 + 能力命令总线，不是微服务化

- 状态：已采纳
- 相关：[phase2-application-layer.md](../phase2-application-layer.md)、[phase3-entry-migration.md](../phase3-entry-migration.md)

## 背景

Mono 能力（图片反推/视频分析/抠像/生图）原本被三条入口各自实现一遍：AI SDK
聊天工具（`tools/mono.ts`）、`/api/mono/*` 外部 API、以及转发外部 API 的 MCP
server。三份实现共享底层 `mono/service.ts` 函数，但入参 schema、描述文本、
错误处理各写一份，新增一个能力要同时改三个地方，且没有任何东西保证三条入口
对"同一个能力"的理解是一致的。

## 决策

引入一层薄的应用层（`src/lib/workbench/`）：`CapabilityCommand` 统一命令信封、
`CAPABILITY_REGISTRY` 单一能力定义源（schema + 描述文本 + sync/async 执行入
口）、`runCapabilityCommand` 命令总线负责校验+分发。所有入口收敛成"构造一个
`CapabilityCommand` → 调总线"，而不是各自维护一份业务逻辑。

**明确不做**：不引入微服务拆分、不引入 Temporal/Redis/消息队列、不改
`mono/service.ts` 内部函数的实现——总线是纯适配器层，`runSync`/`runAsync`
直接调用未改动过的原函数。这是"模块化单体"而不是"微服务"：进程边界没变
（只有 Phase 4 的 Worker 是个例外，见 ADR 0004），变的只是代码组织方式。

## 后果

- 好处：新增能力只加一条注册项；三条入口（工具/外部 API/MCP）现在保证走同一
  个 schema 校验、同一个执行函数，不会出现"聊天工具接受这个参数但外部 API 拒
  绝"的漂移。
- 代价：多了一层间接——排查问题时要多看一层（命令 → 注册表 → 具体函数）。
- 已知限制：同步能力（`image_to_prompt`）的结果不落库，`CapabilityRun.id` 是
  一次性的，不能复查；`assetIds` 字段目前只是占位，没有校验它跟 `input` 内部
  的素材引用一致。这些记在 [phase2-application-layer.md](../phase2-application-layer.md)
  的"未覆盖"里，不是本决策的疏漏，是有意延后的范围。
