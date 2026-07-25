# ADR 0004：Worker 双模式（inline/standalone）而不是一次性切换

- 状态：已采纳
- 相关：[phase4-worker.md](../phase4-worker.md)

## 背景

治理计划的方法论要求"分阶段替换，不是大爆炸重写"、"每个能力可独立回滚"。
把任务执行从 web 进程搬到独立 Worker 进程，是这五个阶段里对生产行为影响面
最大的一步——如果新 Worker 进程配置错误或者没启动，而 web 进程又已经完全
停止执行任务，队列会静默堆积，用户看到的是任务永远卡在"排队中"。

## 决策

`MONO_WORKER_MODE` 环境变量，默认 `inline`（web 进程自己执行，等价于这一步
之前的唯一行为）。只有显式设成 `standalone` 才会让 `scheduleMonoWorker()`
变成空操作、把执行职责交给独立进程。这不是"迁移开关用完就分两次删掉"的临时
状态——`inline` 模式本身也是一个正常、被支持、被测试覆盖的长期存在的部署形
态，适合小规模/单机部署不需要独立 Worker 的场景；`standalone` 是给需要进程
隔离（一个卡住的 Provider 调用不该拖慢 web 请求）的部署规模用的。

同理，`MONO_JOB_MAX_ATTEMPTS` 默认 1（不重试，等价于迁移前行为），调大才启
用队列级退避重试——不是"以后要删掉的兼容代码"，是"要不要在 Provider 抛错时
自动退避重试"这个本身长期存在的运维决策。

## 后果

- 好处：可以先在测试/预发环境把 `mono:worker` 跑起来观察一段时间，确认没问
  题再把某个 workspace/整个部署切到 `standalone`，出问题秒级切回 `inline`，
  不需要回滚代码或重新部署。
- 代价：`mono/service.ts` 里同时存在两条调度路径（`scheduleMonoWorker`/
  `drainMonoJobs` 给 inline，`runStandaloneWorkerTick` 给 standalone），
  但两者共享同一个 `dispatchClaimedJob` 执行体，不是两份业务逻辑，维护成本
  可控。
- **这两个开关不计划在"收口"阶段被移除**——跟 Phase 3 引入的
  `WORKBENCH_CAPABILITY_BUS_DISABLED` 那种"证明新路径没问题之后就可以删掉的
  过渡开关"性质不同，`MONO_WORKER_MODE`/`MONO_JOB_MAX_ATTEMPTS` 是长期存在的
  部署配置项。详见 [phase5-closeout.md](../phase5-closeout.md) 里对"移除临时
  回滚开关"这条计划条目的范围澄清。
