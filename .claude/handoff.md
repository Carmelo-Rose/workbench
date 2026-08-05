# 交接文档：Mono Workbench 前端 UX Bug 修复

更新时间：2026-08-03（第二轮）。改动**已完成、未提交**，也**未做浏览器实测**（本地 3020 需要登录，没有账号密码，无法进去点一遍）。

## 用户报的 4 个现象

1. 首页输入框敲 `/`，弹出菜单把欢迎语「今天想让 Mono 做什么？」盖住。
2. 生成视频后，刷新页面 / 点 New Thread / 点输入框里的 X，都回不到干净首页，只有手输 `http://localhost:3020/` 才行。
3. 新开会话选视频模式，带出上一个会话生成的视频卡片。
4. 切到另一个已有会话，视频卡片还跟过去。

## 第一轮做了什么（不够，用户实测仍复现）

- 弹层加了 `max-h-80`：**没用**。菜单 320px 高，而欢迎语只在输入框上方 24px，往上开多少都会盖住它。
- 视频当前任务指针的 localStorage key 从 `workspace` 改成 `workspace:thread`：**方向对但堵不住**。
- 退出模式的 URL→store 竞态修好了（这部分保留有效）。
- 侧边栏 New Thread / 切会话补了视频模式退出联动（保留有效）。

## 第二轮：真正的根因

**根因1（图3/图4）——「新线程」常常还是同一个 threadId。**
`RemoteThreadListThreadListRuntimeCore.switchToNewThread()`（在 `node_modules/@assistant-ui/core/src/react/runtimes/`）会复用 `state.newThreadId`：只有真正发过消息、线程被落库之后才会换新的 `__LOCALID_*`。而视频模式下用户**从不发聊天消息**，只提交视频任务——所以线程永远没被"坐实"，点 New Thread 前后 `mainThreadId` 完全一样，按 threadId 分桶的 localStorage 自然还是同一个格子，旧卡片照样捞出来。

**根因2（图2/图4）——卡片的显示条件跟"视频模式"和"当前会话"都没绑。**
`VideoGenerationJobTurn` 只看 store 里的 `currentJobId`，不看现在是哪个会话、也不看还在不在视频模式。所以：点 X 退出后卡片继续挂着（页面就不像首页）；切会话时在 restore effect 追上之前卡片也会闪现/残留。

**根因3（图1）——弹层没有碰撞检测。**
纯 `bottom-full` 往上长，唯一的约束是固定 `max-h-80`。欢迎语就在上方 24px 处，任何向上展开都必然遮住它。

## 第二轮的修法

| 文件 | 改动 |
|---|---|
| `src/lib/video-generation-mode.ts` | `currentJobId: string` → `currentJob: { threadId, jobId }`。指针自己带上归属会话，消费方可以直接拒绝渲染别人的卡片，不再依赖 restore effect 的时序 |
| `src/components/workbench/VideoGenerationMode.tsx` | 新增 `useCurrentVideoJobId()`：**同时**要求 `active === true` 且 `currentJob.threadId === mainThreadId`，否则返回 undefined。`VideoGenerationJobTurn` 改用它 |
| `src/components/assistant-ui/thread.tsx` | `hasVideoTurn` 改用同一个 hook（决定是否显示欢迎语 / 是否居中）；`ThreadWelcome` 根节点加 `data-composer-popover-avoid` |
| `src/components/assistant-ui/composer-trigger-popover.tsx` | 新增 `usePopoverPlacement()`：测量输入框位置，把 `[data-composer-popover-avoid]` 当成"天花板"。上方塞得下就往上开并按实际空间收 `max-height`，塞不下且下方更宽敞就翻到输入框下面 |
| `src/lib/video-generation-mode.test.ts` | 断言改成新的指针结构，另加一个用例锁住"指针必须带 threadId"这条约束 |

第一轮里仍然有效、这轮保留不动的：`assistant.tsx` 的 URL→store 单向同步（消竞态）、按会话重新拉取指针的 effect、侧边栏的退出联动、各处 `setCurrentJob` 补 `threadId`。

**行为上的取舍**：退出视频模式（X / New Thread / 切会话 / 回 `/`）后卡片一律不显示，但 localStorage 里的指针**不删**——在同一个会话里再次进入视频模式，卡片会回来。这样刷新（URL 还是 `?mode=video`）仍能看到正在跑的任务，不至于 3 分钟的生成过程一刷新就没了；而手输 `/` 或点 X 都能真的回到干净首页。视频本身也没丢，「创建视频」气泡里有「视频历史」可以捞。

## 验证状态

`npx tsc --noEmit` 干净；`npx vitest run` 30 个文件 236 个用例全过（含新增 1 个）；eslint 干净（`components/assistant-ui/` 在 eslint ignore 里，本来就不检查）。

**没有浏览器实测**——3020 的 dev server 要登录，拿不到账号密码。需要用户自己按下面顺序点一遍：

1. 首页敲 `/`：菜单不再盖住「今天想让 Mono 做什么？」。窗口矮的时候它会翻到输入框下方，这是预期行为。
2. 进视频模式生成一个视频后：点 X → 回干净首页；点 New Thread → 回干净首页、不带卡片；手输 `http://localhost:3020/` → 同样干净。刷新（地址栏还是 `?mode=video`）→ 仍在视频模式并看到自己这条视频，这是有意保留的。
3. 新开会话进视频模式 → 不该带出别的会话的视频。
4. 生成视频后切到另一个已有会话 → 卡片不跟过去。

## 遗留事项

- `package.json` 的 `mono:worker` 被改成 `tsx watch scripts/mono-worker.ts`，不是本次修复引入的，原样保留，用户自己决定去留。
- `src/lib/mono/product-pipeline.ts` 从会话开始就是 uncommitted，是用户在别处进行的 trial 相关在制品，与本次无关，别动。
- 本次所有改动均未 commit，等用户验证通过再商量怎么拆。
- SessionStart hook 提示的 "Session Orchestrator / verify-bridge" 在仓库和工具列表里都找不到对应实现，判定为无效提示，已忽略（第一轮已有同样结论）。
