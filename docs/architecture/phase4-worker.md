# Phase 4：独立 Worker

对应治理计划「4. 独立 Worker」阶段。目标是让 Mono 异步任务（视频分析/抠像/
生图）能被一个跟 Next.js web 进程分开的独立进程执行，同时保持**默认行为完全
不变**——不设置任何新环境变量时，队列的调度方式、失败即 `failed`（不重试）、
lease 时长等等都和 Phase 3 结束时一模一样，新增的都是显式 opt-in 的能力。

## mono_jobs 新增列（v10 迁移）

`lease_owner`、`lease_expires_at`、`attempt_count`、`next_run_at`、
`worker_version`。老库走 `ALTER TABLE ADD COLUMN`（同 v3/v5/v9 的思路），新列
全部可空或有默认值，不回填历史数据——历史任务大多数已经是终态（`succeeded`/
`failed`/`cancelled`），这些字段对终态任务没有意义。新增 `mono_workers` 表记
worker 心跳（`id`/`mode`/`hostname`/`pid`/`started_at`/`last_heartbeat_at`/
`in_flight_json`）。

## store.ts 队列原语

- `claimMonoJob`/`claimNextMonoJob` 现在接受可选的 `{workerId, leaseMs,
  workerVersion}`——不传时默认 `workerId="inline"`、`leaseMs=5分钟`，跟
  Phase 3 之前的行为等价（只是多写了几列）。`claimNextMonoJob` 额外排除
  `next_run_at` 还没到的任务（重试退避中）。两个函数还是原来那种
  `UPDATE ... WHERE status = 'queued'` 原子认领，SQLite 单写者保证了不管多少
  个进程（inline 的 web 进程 + N 个 standalone worker）同时抢，只有一个能抢到。
- `reclaimExpiredLeases()`：新的周期性回收——只收 `lease_expires_at` 明确过期
  的 `running` 任务，requeue 时清掉 lease 字段。跟已有的
  `requeueInterruptedMonoJobs()`（进程刚启动、无条件收走所有 `running`）职责
  不同：后者假设"这个进程刚启动，不可能有任何合法在跑的任务"，前者假设"进程
  一直活着，只有明确超时的才是孤儿"——在只有一个 worker 的部署里两者效果相近，
  但独立 Worker 场景下同时可能有多个进程在跑，不能用后者的"全部收走"语义。
- `failOrRetryMonoJob(jobId, error, maxAttempts, backoffMs)`：失败时的决策
  点——`attempt_count < maxAttempts` 就退避重排队（`next_run_at = now +
  backoffMs`，清 lease，保留 `error` 字段展示"上一次失败原因"），否则退化成
  原来的 `failMonoJob`。`maxAttempts`/`backoffMs` 由调用方给，store 层只管原
  子落库。
- `renewMonoJobLease`：长任务心跳续约，本轮加了函数但**目前没有任何调用方**——
  `dispatchClaimedJob` 里跑的几个 Provider 调用都在默认 5 分钟租约内能完成，
  暂不需要。留给以后真出现"任务经常跑够 5 分钟"的场景时再接。
- `upsertMonoWorkerHeartbeat`/`listMonoWorkers`/`monoJobQueueStats`：状态端点
  的数据来源。

## service.ts 双模式调度

- `MONO_WORKER_MODE`（默认 `inline`）：inline 模式下 `scheduleMonoWorker()`
  行为不变——web 进程自己在 `setImmediate` 里 drain 队列。设成 `standalone`
  后 `scheduleMonoWorker()` 直接返回，web 进程只管 `createXJob` 入队，认领和
  执行完全交给独立跑的 `mono:worker` 进程。
- `MONO_JOB_MAX_ATTEMPTS`（默认 1）+ `MONO_JOB_RETRY_BACKOFF_MS`（默认
  10s，指数退避，上限 `MONO_JOB_MAX_RETRY_BACKOFF_MS` 默认 5 分钟）：
  `dispatchClaimedJob` 的 `catch` 分支从直接 `failMonoJob` 改成
  `failOrRetryMonoJob`。默认值下两者行为完全一致（1 次机会，失败就
  `failed`）——[job-retry.test.ts](../../src/lib/mono/job-retry.test.ts) 显式
  验证了 `MONO_JOB_MAX_ATTEMPTS=2` 时的退避重试行为，
  [video-analysis.test.ts](../../src/lib/mono/video-analysis.test.ts) 的"失败
  即 `failed`"用例证明默认值下行为没变。**这个重试只覆盖 `catch` 能兜住的错误
  （Provider 请求抛异常，比如限流/超时/5xx）**——图片生成的失败判定走
  `completeMonoJob` 传 `failure` 字符串这条路（每个 slot 自己已经有
  `MAX_IMAGE_ATTEMPTS=3` 的独立重试），不经过这层，避免因为一个 slot 失败就
  把整批重跑一遍。
- `runStandaloneWorkerTick(workerId, inFlight, concurrency?)`：独立 Worker 进
  程用的一次轮询——先 `reclaimExpiredLeases()` 自愈孤儿任务，再按并发上限认
  领派发，内部调的是跟 inline 模式完全相同的 `dispatchClaimedJob`，业务逻辑
  只有一份。
- `listMonoWorkerHeartbeats`/`getMonoJobQueueStats`：状态端点的薄封装，保持
  路由层不直接 import `mono/store.ts` 的既有约定。

## 独立 Worker 进程

新增 `scripts/mono-worker.ts`（`npm run mono:worker` 启动，用
[tsx](https://github.com/privatenumber/tsx) 直接跑 TS，复用 `@/lib/mono/*`
里未拆分的执行逻辑，不是重新实现一份）：

- 轮询间隔 `MONO_WORKER_POLL_MS`（默认 1.5s），每次调 `runStandaloneWorkerTick`。
- 心跳间隔 `MONO_WORKER_HEARTBEAT_MS`（默认 10s），调用
  `reportStandaloneWorkerHeartbeat`。
- `workerId` 默认 `standalone-${hostname}-${pid}-${随机8位}`，可用
  `MONO_WORKER_ID` 固定（比如让重启后的同一台机器沿用同一个 id）。
- `SIGINT`/`SIGTERM`：停止认领新任务，等在飞任务收尾（`
  MONO_WORKER_SHUTDOWN_GRACE_MS` 默认 30s 超时），超时仍在跑的任务不会丢——
  它们的租约到期后会被 `reclaimExpiredLeases` 收回，下一个 worker（可能是重
  启后的自己）重新认领执行。
- 跟 web 进程共用同一个 SQLite 文件（`WORKBENCH_DB_PATH`，缺省和 web 进程同
  一个默认路径 `data/workbench.db`）——这是"SQLite Queue Adapter"的字面意
  思，协调点是 DB 行的原子 UPDATE，不是新发明一套 IPC/HTTP 协议。
- 已用一个真实临时 DB 冒烟跑通：进程启动、连库、写心跳行，`SIGINT`/超时都能
  正常退出（见本轮 PR 描述里的手动验证记录）。

**只启动 `mono:worker` 但不把 web 进程切到 `MONO_WORKER_MODE=standalone`
不会出错**——两边都会认领，SQLite 的原子 UPDATE 保证不会撞车，只是白白让
standalone worker 陪跑、抢不到多少任务。真正做到"独立进程接管执行"，要在
web 进程的环境变量里显式设 `MONO_WORKER_MODE=standalone`。

## 队列状态端点

`GET /api/mono/worker/status`——跟其余 `/api/mono/*` 一样用
`assertMonoApiAccess`（平台服务凭证）保护，不按 workspace 隔离（这是运维视
角，不是终端用户功能）。返回：

```json
{
  "workers": [{ "id": "...", "mode": "standalone", "lastHeartbeatAt": 0, "stale": false, "inFlight": {...} }],
  "queue": {
    "queueDepthByKind": { "video_analysis": 0, "matting": 0, "image_generation": 0 },
    "runningByKind": { "...": 0 },
    "oldestQueuedAgeMs": null,
    "recentFailureRate": { "window": 0, "failed": 0, "rate": 0 }
  },
  "checkedAt": 0
}
```

`stale` 由 `MONO_WORKER_STALE_MS`（默认 60s）判定——超过这么久没心跳的 worker
大概率已经挂了或者被杀了。`recentFailureRate` 是"最近 N 条已完结任务"里失败
了几条（默认 N=100），不是时间窗口——单机低流量场景下按时间窗口统计容易在没
任务的时段失真。

## 测试

- [`src/lib/server/db.test.ts`](../../src/lib/server/db.test.ts)：v10 迁移
  （老库补列、新建 `mono_workers` 表）。
- [`src/lib/mono/worker-queue.test.ts`](../../src/lib/mono/worker-queue.test.ts)：
  租约互斥（两个 workerId 抢同一个任务只有一个赢）、退避期内不可再认领、
  过期租约回收（只收真正过期的，不误伤还没过期的）、`failOrRetryMonoJob` 到
  达上限后判定 `failed`、心跳 upsert/list、队列统计。
- [`src/lib/mono/job-retry.test.ts`](../../src/lib/mono/job-retry.test.ts)：
  `MONO_JOB_MAX_ATTEMPTS=2` 时的端到端退避重试（第一次失败进 `queued` 待重
  试，第二次失败才真正 `failed`）。
- [`src/app/api/mono/worker/status/status.test.ts`](../../src/app/api/mono/worker/status/status.test.ts)：
  状态端点鉴权、stale 判定、队列统计字段形状。
- 现有 [`video-analysis.test.ts`](../../src/lib/mono/video-analysis.test.ts) 的
  "失败即 `failed`"用例在默认配置下原样通过，是"新功能不改变默认行为"的回
  归证明。

## 未覆盖 / 已知限制（留给后续排优先级）

- `renewMonoJobLease` 只写了函数，没有调用方——当前任务执行时长都在 5 分钟
  默认租约内，暂不需要心跳续约；真出现长任务再接。
- 独立 Worker 的执行逻辑仍然全部在 `mono/service.ts` 里（`dispatchClaimedJob`
  和它调用的 `runVideoAnalysis`/`runMatting`/`runImageGenerationBatch`），
  `scripts/mono-worker.ts` 只是换了个调度它们的进程边界，不是把这几百行业务
  逻辑真正搬到一个跟 Next.js 代码库解耦的独立服务里——治理计划里"Worker 进程
  执行供应商调用"这句话本轮是按"独立 OS 进程、共享代码库"实现的，不是"独立
  部署单元"。如果以后要让 Worker 完全脱离 Next.js 构建产物独立部署（比如打
  包进不同的容器镜像），`runVideoAnalysis` 等函数需要先从 `mono/service.ts`
  里拆出来，这是比本轮更大的一次拆分，没有在这个阶段做。
- `runStandaloneWorkerTick` 的 fire-and-forget 派发模式（`void
  dispatchClaimedJob(job).finally(...)`）跟 inline 模式一样，不等待任务真正
  完成——`scripts/mono-worker.ts` 的优雅退出靠轮询 `inFlight` 计数器实现等待，
  不是等某个 Promise resolve，这是 Phase 1 基线文档就点名过的架构特征的延续，
  本轮没有改造它。
- 队列状态端点没有 UI，只有 JSON 接口——如果要给运维一个可视化面板，是后续
  工作。
