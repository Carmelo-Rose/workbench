# 商品套图（product_pipeline）体验改造 Plan

> 交给执行方（Sonnet 5）的完整施工说明。执行方是冷启动的，本文档假设你没有参与过之前的讨论。
> 先读仓库根目录的 `AGENTS.md`：本项目的 Next.js 16 与训练数据里的用法有出入，写代码前先读 `node_modules/next/dist/docs/` 里的对应指南。

---

## 0. 开工前必读

### 0.1 不要动的东西

| 位置 | 状态 | 原因 |
| --- | --- | --- |
| `src/lib/mono/product-template.ts` 的 `buildModelPrompt()` | 目前是**实验状态**：只返回 `look.text` + `CAMERA_STYLE`，原来的四段拼接被注释保留 | 用户正在评估这版提示词的出图效果，明确要求先留着 |
| `src/lib/mono/product-classify.test.ts` 里 `prompt assembly > states the product contract before the styling…` | **当前是失败的**（断言提示词里有 `790:1243` 和禁止项，实验版没有） | 这是上面那个实验的已知后果，不是回归。**不要为了让它变绿去改提示词或改断言。** 全套测试当前基线是 83/84 通过 |

如果你跑测试看到 1 个失败且就是这一个，属于预期，继续干活。出现第 2 个失败才是你引入的问题。

### 0.2 当前功能是干什么的

一个商品文件夹（网络盘 UNC 路径，形如 `\\192.168.1.99\picture\...\【原图】-待制作\1234\`）里有：

- `原图/` —— 摄影师拍的原始图。其中 `x_1.jpg`、`x_2.jpg`… 这种 `x_` 开头的是**细节特写**，不抠图、不参与颜色识别，直接进详情页
- `主图/` —— 抠好的白底图（可复用，存在就跳过抠图这一步）
- `images/` —— 最终产物，11 张 `<文件夹名>_01.jpg` … `_11.jpg`

11 个槽位的构成（见 `product-pipeline.ts:21` 的 `DETAIL_SLOTS`）：

| 槽位 | 类型 | 说明 |
| --- | --- | --- |
| 01、03–08 | `model` | 调 gpt-image-2 生成模特图，**每张都花钱** |
| 02、09 | `fixed` | 模板包里现成的页，直接拷 |
| 10 | `tiled` | 平铺展示页，用白底图拼 |
| 11 | `detail` | 细节展示页，用 `x_` 特写拼 |

### 0.3 关键文件

| 文件 | 职责 |
| --- | --- |
| `src/lib/mono/product-pipeline.ts` | 编排全流程：抠图 → 分类 → 生模特图 → 拼版 → 质检 → 发布 |
| `src/lib/mono/product-classify.ts` | 从像素识别颜色分组、白底判定、裁切框 |
| `src/lib/mono/product-layouts.ts` | 10 号平铺页、11 号细节页的排版渲染 |
| `src/lib/mono/product-template.ts` | 模板 JSON 的 schema 与提示词拼装 |
| `src/components/workbench/ProductPipelineLauncher.tsx` | **当前的弹窗入口**（要大改） |
| `src/components/workbench/MonoToolUI.tsx` | 其他能力的对话内任务卡（`JobCard` / `TaskShell` 模式，要复用） |
| `src/components/workbench/CapabilityActions.tsx` | 能力动作分发，`case "product-pipeline"` 在 `:145` |
| `src/lib/workbench/capabilities.ts` | 能力注册表（chip + `/` 命令的单一真源） |
| `src/lib/tools/mono.ts` | Agent 工具注册表（**目前没有 product_pipeline 工具**） |

现有 API：

- `GET  /api/workbench/mono/product-pipeline/folders?q=` —— 列文件夹
- `POST /api/workbench/mono/product-pipeline/jobs` —— 建任务
- `GET  /api/workbench/mono/jobs/{id}` —— 查任务（通用，不是 product-pipeline 专属路径）
- `GET  /api/workbench/mono/product-pipeline/jobs/{id}/artifacts/{name}` —— **只能取 `主图/` 里的文件，取不到最终成品**

---

## 1. 要解决的三个问题

这三条都是实测踩出来的，不是推测。

### 问题 1：结果根本看不见

功能产出 11 张图，而 UI 从头到尾一张都不显示，跑完只有一句「任务已完成」。用户想看图只能自己去开资源管理器翻网络盘。

### 问题 2：失败等于全作废，钱白花

实测：`job_da8886db` 跑到 slot 04，前面 01、03 已经生成好、**钱已经付了**，04 连续三次被生图服务拒绝后，`runWithConcurrency`（`product-pipeline.ts:430`）遇到第一个异常就停止派发并向上抛，整个任务 failed。已生成的两张还在 staging 目录里没发布，直接被丢弃。重跑要重新付全款。

生图服务（gpt-image-2）本身会随机拒绝，实测同一份请求既成功过也失败过，两种错误形态：

```
{"status":"violation","error":"抱歉，我无法生成这张图片…你可以重新发起一次图片生成请求"}
{"status":"failed","error":"generate image failed"}
```

单张已有 3 次重试（`generateModelSlot`，`product-pipeline.ts:659`），但服务差的时候 3 次也扛不住。

### 问题 3：跑的时候是黑盒

7 分钟只有一句「正在生成模特图（45%）」。哪张在跑、哪张重试过、哪张已完成，后端 `result.slots` 里其实都有，UI 一个都没用。

---

## 2. 目标形态

**入口结论：弹窗保留，但只负责「选文件夹」这一步；点了开始之后的一切搬进对话。**

理由：这个 App 里所有其他能力（生图 / 抠像 / 视频分析）都是对话里的一张卡片，由 Agent 调用、实时轮询、结果留在对话里。只有商品套图是孤岛 —— Agent 调不动、关掉窗口什么都不剩、跑完回不去看。选文件夹是浏览网络盘，用弹窗合理；任务本身不该困在弹窗里。

改造后：

1. 弹窗 = 文件夹选择器（带状态标记，让用户知道点下去会发生什么）
2. 任务 = 对话里的卡片，实时进度板（11 个槽位可见）+ 完成后的图片画廊
3. 失败 = 已完成的照常发布，卡片上给「只重跑失败的 N 张」
4. Agent 能调用 = 加 `mono_product_pipeline` 工具

### 已定的产品决策

- **部分失败时，已生成的图照常写进共享盘 `images/`，缺的槽位就缺着。** 用户明确选择了这个（优先「立刻能在资源管理器里看到已完成的图」，接受文件夹阶段性不完整的风险）。
- **不新增 job 状态。** `monoJobStatuses`（`contracts.ts:5`）被 SQLite CHECK 约束卡在 `db.ts:122` 和 `db.ts:458` 两处，加一个 `partial` 要写迁移。改用：终态仍是 `succeeded`，在 `result` 里带 `incomplete: true` 和 `failedSlots`，UI 据此显示「部分完成」。

---

## 3. 模块拆分

**按模块顺序执行，每个模块独立验收，做完一个停下来让用户确认再继续。** 理由见 §4。

---

### M1 · 后端：失败不掀桌 + 部分发布

**改 `src/lib/mono/product-pipeline.ts`。**

1. 模特图循环（`runProductPipeline` 里 `runWithConcurrency(modelSlots, MODEL_CONCURRENCY, …)`，约 `:585`）改成**收集失败而不是中断**：
   - 在 worker 内部 try/catch，失败的槽位记进 `failedSlots: { slot, reason }[]`，不再向上抛
   - 取消信号（`signal.aborted`）仍然必须立刻中断，不能被当成可重试的失败吞掉
   - 注意 `runWithConcurrency` 本身遇错即停的语义不要改（其他地方在用），在 worker 里消化掉异常即可
2. `verifyDetailOutputs`（`:757`）目前对 `DETAIL_SLOTS` 全量校验尺寸，缺文件会抛。改成只校验**实际产出的**槽位。
3. `publishImages`（`:761`）目前无条件 `cp` 每个槽位，缺文件会抛。改成只发布 staging 里存在的槽位（它本来就会先把 destination 现有内容合并进 merge 目录，所以缺的槽位会保留上一次的旧图或就是空缺 —— 符合「缺的就缺着」）。
4. 全部模特图都失败时仍然应该 throw（没有任何新内容值得发布）。
5. 返回的 `result` 加上：`incomplete: boolean`、`failedSlots: { slot, reason }[]`。

**新增：只重跑失败槽位的入口。**

- `POST /api/workbench/mono/product-pipeline/jobs` 的 body 支持 `{ folderId, workflowId, onlySlots?: string[] }`
- `runProductPipeline` 读到 `onlySlots` 时，只跑这些模特槽位，跳过其余模特槽位，拼版槽位（10/11）照常重做（便宜且要跟新图保持一致），最后照常合并发布
- `onlySlots` 要校验：必须是 `DETAIL_SLOTS` 里 `kind === "model"` 的槽位 id，否则报错

**验收（不要用真跑验收，见 §4.3）：**
- 单测：模拟一个模特槽位抛错，断言其余槽位仍然产出、`result.incomplete === true`、`failedSlots` 内容正确、`publishImages` 只发布存在的文件
- 单测：`onlySlots: ["04"]` 时只调用一次模特生成
- 单测：`signal.aborted` 时立即中断且不计入 `failedSlots`
- `npx tsc --noEmit -p tsconfig.json` 干净
- `npx vitest run src/lib/mono/` 仍然只有 §0.1 那一个已知失败

---

### M2 · API：让成品图能取到

**新增 `src/app/api/workbench/mono/product-pipeline/jobs/[id]/images/[slot]/route.ts`。**

- 参照现有的 `artifacts/[name]/route.ts` 写，那份是安全实现的范本：校验 actor、校验 job 归属且 `kind === "product_pipeline"`、用 `resolveProductFolder` 解析路径、**用 `path.dirname` 比对防目录穿越**、`cache-control: private, no-store`
- 本路由从 `<folder>/images/<folderName>_<slot>.jpg` 读
- `slot` 只允许两位数字（`/^\d{2}$/`），不要接受任意文件名
- 支持 `?w=` 缩略图参数（用 sharp resize），进度板要显示 11 个小图，直接传原图太重
- 文件不存在返回 404，不要 500 —— 槽位可能还没生成或本次失败了，这是正常状态

**验收：** 对一个已完成的 job 逐个 slot 取图，01–11 都能拿到；构造穿越路径（`../`、绝对路径、`10.jpg` 之外的名字）必须 404；缺失槽位返回 404 而不是 500。

---

### M3 · 前端：任务卡 + 进度板 + 结果画廊

这是用户最想要的一块。

**复用 `MonoToolUI.tsx` 里的 `JobCard` / `TaskShell` 模式**，不要另起一套。注意 `JOB_TITLES` 里已经有 `product_pipeline: "商品套图"`。

**新增 `src/components/workbench/ProductPipelineCard.tsx`：**

- 11 个槽位的进度板，网格排列，每格显示槽位号和状态：
  - 排队 / 生成中（虚线描边）/ 已完成（显示缩略图）/ 失败（红）/ 固定页（弱化）
  - 重试过的槽位角标标「重试 N」—— 数据来自 `result.slots[].attempts`，注意 `attempts > 1` 但最终成功的槽位 `warning` 文案已经是「重试 N 次后成功（原因）」，不要把它当失败渲染
- 头部：文件夹名 + 当前阶段 + 停止按钮（复用 `JobCard` 的 cancel）
- 副信息：是否复用了已有主图（`result.resumed`）、识别到几个颜色（`result.colors`）、细节图张数（`result.detailShots`）
- 底部：付费槽位完成数 / 总数、已用时长
- 终态：
  - 全部成功 → 图片画廊（点开大图），操作：下载全部、复制文件夹路径
  - 部分完成 → 同上，外加醒目的「只重跑失败的 N 张」按钮（调 M1 的 `onlySlots`）
- 阶段文案沿用现有 `stageLabel` 那套映射，别新造一套术语

**改 `ProductPipelineLauncher.tsx`：** 砍成纯文件夹选择器。选中 → 建任务 → **关闭弹窗**，任务卡出现在对话里。弹窗里不再有进度、不再有结果、不再有那个语义混乱的「继续生成详情套图（付费）」按钮。

**任务卡怎么进对话：** 参考 `CapabilityActions.tsx` 里其他能力的做法。如果 M4 的工具已经做了，直接走工具调用的 tool UI 最自然；M3 先做的话，用 assistant-ui 的 append 把卡片挂进 thread，M4 再统一。**执行时先确认 assistant-ui 的当前 API，不要照抄记忆里的用法。**

**验收：** 用一个历史已完成的 job id（如 `job_2919e9f0-cf33-476c-a682-6f510f457580`，文件夹 1234）把卡片渲染出来，11 格缩略图都出得来；构造一个 `incomplete` 的假 result，确认「只重跑失败的 N 张」正确显示且带对了槽位号。

---

### M4 · Agent 工具

**在 `src/lib/tools/mono.ts` 加 `mono_product_pipeline`。**

- 入参：`folderId`（或 `folderName`，让模型能用「1234」这种自然说法，服务端再解析成 id）、可选 `onlySlots`
- 描述里必须写明**会调用付费生图服务**，参照现有 `mono_generate_image` 的描述写法
- 在 `MonoToolUI.tsx` 注册对应的 `makeAssistantToolUI`，渲染 M3 的卡片
- `mono_get_job` 已经能查这个 kind，确认它对 `product_pipeline` 的结果渲染是合理的（目前走 `JobStatusCard`，只有一句话，可以让它也复用 M3 的卡片）

做完之后「帮我把 1234 跑一遍」「刚才那个跑得怎么样」都能走通。

**验收：** 对话里说「用商品套图跑一下 1234」能正确发起；说「刚才那个任务怎么样了」能查到并渲染卡片。

---

### M5 · 选择器增强 + 扩展口子

**文件夹选择器加状态标记**，让用户点之前就知道会发生什么。`listProductFolders`（`product-pipeline.ts:280`）扩展返回：

- `hasMasters` —— `主图/` 齐全 → 标「主图可复用，跳过抠图」
- `detailShotCount` —— `原图/` 里 `x_` 开头的张数 → 标「含 N 张细节图」或「缺细节图」（缺的话 11 号页会退化成用整体图拼版）
- `hasImages` —— `images/` 已存在 → 标「已生成过，将覆盖」

这些都是几个 `stat`/`readdir` 就能拿到的，别为此去做抠图或分类。

**扩展口子：**

- 工作流当前硬编码 `WORKFLOW_ID = "hat-62604171-v1"`（`product-pipeline.ts:19`），而模板系统本身是按品类设计的（`product-template.ts` 顶部注释写得很清楚：模板描述的是**品类**不是单品）。选择器里把 workflow 做成可选项，只有一个模板包时显示为已选中且禁用。以后加新品类 = 丢一个模板包进 `config/product-pipeline/`，入口和卡片都不用改。
- `capabilities.ts` 的能力表已经有「留口子」的成熟约定（`disabled` + `badge: "即将上线"`），新品类没上线前照这个来。

**验收：** 选择器每行的标记与网络盘实际状态一致（拿 `123`/`1234`/`12345`/`62603196` 四个文件夹核对，它们状态各不相同）。

---

## 4. 执行建议

### 4.1 思考强度：high

理由：

- M1 动的是**发布语义和花钱的重试逻辑**，改错的直接后果是往同事在用的共享盘写坏数据、或者重复扣费
- M3 要接 assistant-ui 的 tool UI，这套 API 与训练数据里的版本可能有出入，需要先读现有代码再动手，不能凭记忆写
- M2、M5 相对机械，high 也不亏

**M1 建议再高一档**（ultrathink / max）：它同时涉及并发、异常边界、取消信号、原子发布四件事的交互，是整个 plan 里唯一「写错了不容易当场发现」的模块。

### 4.2 分模块执行，不要一次性

**结论：一个模块一个 session，做完停下来让用户验收再开下一个。**

理由：

1. **端到端验收现在做不了。** gpt-image-2 当前不稳定（实测连挂 3 轮），跑一次完整流程要 10–20 分钟且可能中途失败。一次性交付会卡在「没法证明它是对的」。
2. **M1 改的是花钱的路径。** 必须单独验收，混在一大坨改动里出问题很难定位是哪一层。
3. **M3 有明确的可视化产物**，用户看一眼就知道对不对，适合单独交付收反馈 —— 这也是用户最想要的一块，早点让他看到。
4. **依赖是线性的**：M2 是 M3 的前提，M4 依赖 M3 的卡片。顺序执行天然合理，并行没有收益。

建议节奏：`M1 → M2 → M3 → 用户验收一轮 → M4 → M5`。M2 很小，可以和 M1 或 M3 合并成一个 session。

### 4.3 怎么验证（重要）

**M1–M3 一律不要靠真跑流程来验收。** 生图服务现在不稳，跑一次十几分钟还可能挂，且每次都花钱。改用：

- **单测** —— M1 的失败/部分发布/取消语义全部可以用假的生成函数覆盖
- **直接调渲染函数** —— 排版类改动可以绕过整个流程单独渲染，参考做法：写一个 `.mts` 脚本，用 `pathToFileURL` 动态 import `src/lib/mono/*.ts`，用 `npx tsx` 跑。注意 tsx 的 CJS 输出不支持顶层 await，**文件名必须用 `.mts`**
- **历史 job** —— M2、M3 用已完成的 job（如 `job_2919e9f0-cf33-476c-a682-6f510f457580`，文件夹 `1234`，11 张图齐全）验证取图和渲染，不用新跑
- 真跑完整流程留到 M4 之后、且用户确认生图服务恢复了再做

开发服务器用 `.claude/launch.json` 里的配置起（`workbench-dev-3100`），不要用 Bash 起 next dev。

### 4.4 每个模块交付时要报告的

- 改了哪些文件、为什么这么改
- `npx tsc --noEmit -p tsconfig.json` 结果
- `npx vitest run src/lib/mono/` 结果（基线：83 通过 / 1 已知失败，见 §0.1）
- 验收怎么做的、实际看到了什么（有图就给图）
- 没做到的、绕过去的、有疑虑的，直说

---

## 附：本轮已完成、不要重复做的改动

这些是刚刚才改完的，执行方接手时已经在代码里了：

| 改动 | 位置 | 说明 |
| --- | --- | --- |
| 白底判定门槛 225 → 246 | `product-classify.ts` `BACKGROUND_MAX_CHANNEL` | 米色帽子最亮处 244，原来后半截被当背景丢掉导致裁切切边。实测识别率 2.5% → 24% |
| 平铺页自适应排版 | `product-layouts.ts:85` `tileRects` | 按内容比例选行列，3 色仍是 2+1（与参考图几何一致），4 色 2+2、5 色 3+2、7 色 3+2+2 |
| `x_` 细节图分流 | `product-pipeline.ts:342` `partitionSources` | 细节特写不抠图、不参与颜色识别，按文件名顺序进 11 号页；顶部大图取 `x_5`，没有则从最后一张裁 |
| 重试位置修正 | `product-pipeline.ts:659` `generateModelSlot` | 发请求原来在 try 外面，一次被拒就作废整个任务。现在三次机会真能用上 |
| 报错带接口正文 | `product-pipeline.ts:723` `requestModelImage` | 原来只报状态码，查不出是提示词、参考图还是额度问题 |
| 模特图并发 2 → 6 | `product-pipeline.ts:20` `MODEL_CONCURRENCY` | 用户指定 |
