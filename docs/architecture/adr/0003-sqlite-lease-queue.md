# ADR 0003：任务队列继续用 SQLite + 租约，不引入 Temporal/Redis

- 状态：已采纳
- 相关：[phase4-worker.md](../phase4-worker.md)

## 背景

`mono_jobs` 表本来就是任务队列（`status` 状态机 + `idempotency_key` 去重）。
治理计划要求给独立 Worker 铺路，同时明确说"先用 SQLite Queue Adapter，接口
留给未来换 Temporal/Redis"——即不要在这一步引入新的基础设施依赖。

## 决策

给 `mono_jobs` 加 `lease_owner`/`lease_expires_at`/`attempt_count`/
`next_run_at`/`worker_version` 五列，用带过期时间的原子 `UPDATE ... WHERE
status = 'queued'` 做跨进程安全的认领；`mono_workers` 表记心跳。这些都是普通
SQLite 表和普通 SQL 语句，没有引入任何新的运行时依赖（`tsx` 是唯一新增的
devDependency，只用来跑 TS 脚本，不是队列基础设施）。

**为什么不现在换 Temporal/Redis**：当前部署规模是单机 AILAB 服务机，SQLite
WAL 模式下的单写者原子 UPDATE 已经能安全支撑"web 进程 + N 个独立 Worker 进程
竞争同一批任务"这个需求，不需要引入分布式协调组件。真正需要跨机器扩容或者
需要更复杂的编排（DAG、长时间人工审批步骤）时再评估换型——那时候
`CapabilityCommand`/`CapabilityRun`（ADR 0001）已经是跟具体队列实现无关的抽
象，理论上可以只换掉队列适配器，不用动调用方。

## 后果

- 好处：零新增基础设施依赖，运维成本没有增加；`reclaimExpiredLeases` 让"某
  个 Worker 进程崩了"这种故障能自愈（租约到期后任务自动被别的 Worker 重新
  认领），不需要人工介入。
- 代价：SQLite 单写者意味着写吞吐有上限，真到需要多机分布式执行的规模时必须
  换型——但那个规模目前不存在，为它预先设计是过度工程。
- 已知限制：`renewMonoJobLease`（心跳续约长任务）只写了函数没有调用方，因为
  目前所有任务都在默认 5 分钟租约内完成；真出现经常跑不完的长任务再接线。
