# 交接文档 — N1 任务中心 + N2 作品库已完成，下一步 N3

更新于 2026-08-03，分支 `claude/workbench-p2-polish-fzl9h8`（commit `1ab7528`，已 push 到 origin）。

## 这次做了什么

A 组 7 项通用能力在上一个会话已完成（commit `7aa0224`/`67c3f19`/`adacd8f`）。本会话按计划顺序做完了 **N1 任务中心** 和 **N2 作品库**，commit 见 `1ab7528`。

两项都已在浏览器里实操验证通过（登录 → 触发真实任务/查看真实历史资产 → 打开对应 Sheet → 操作），不是只跑了 tsc 就交差。

### N1 任务中心

| 项 | 文件 | 状态 |
|---|---|---|
| 后端 kinds 过滤 | `src/lib/mono/store.ts`（`listMonoJobs`）、`src/lib/mono/service.ts`（`listJobs`）、`src/app/api/workbench/mono/jobs/route.ts` | ✅ 新增 `kinds?: MonoJobKind[]` / `?kinds=a,b`，SQL 用 `IN (...)`，保留原单 `kind` 参数向后兼容 |
| 全局 store | `src/lib/mono/job-center.ts`（新文件） | ✅ 仿 `useAgentStatus`，10s 轮询 + focus 刷新 |
| Sheet | `src/components/workbench/JobCenterSheet.tsx`（新文件） | ✅ 仿 `SubjectLibrary` 的 Sheet 壳；`mono_jobs` 无 thread 关联字段，未渲染「打开所在会话」，优雅降级 |
| 侧边栏角标 | `src/components/assistant-ui/threadlist-sidebar.tsx`（`JobCenterFooterItem`） | ✅ 仅 `running+queued>0` 时出现，实测：提交真实生图任务后角标秒出「1 个任务进行中」，取消后角标消失 |

浏览器验证细节：登录后进生图模式提交一条真实 prompt，角标即时出现；打开 Sheet 能看到这条新任务和历史上全部 5 种任务类型（图片生成/视频生成/商品套图/抠像/视频分析）混合按时间倒序排列，状态标签、失败原因文案都正确；轮询会更新相对时间（「刚刚」→「2 分钟前」）；用 API 直接把任务标记 cancelled 后角标自动消失。

### N2 作品库

| 项 | 文件 | 状态 |
|---|---|---|
| 后端游标分页 | `src/lib/mono/store.ts`（`listGeneratedMonoAssets`）、`src/lib/mono/service.ts`（`listGeneratedAssets`）、`src/app/api/workbench/mono/assets/route.ts` | ✅ 新增可选 `beforeCreatedAt` / `?before=`，`origin=generated` 现有行为不变（`SubjectLibrary.tsx` 沿用的那次调用不受影响） |
| store | `src/lib/mono/asset-library.ts`（新文件） | ✅ 极简 open/close，无轮询（浏览型 Sheet，不需要常驻） |
| Sheet | `src/components/workbench/AssetLibrarySheet.tsx`（新文件） | ✅ `grid-cols-2` 卡片网格，图片用 `<img>`、视频用 `<video muted>`；每张卡 hover 出「插入到消息」「下载」两个操作 |
| 入口 1：composer `+` 菜单 | `src/components/assistant-ui/thread.tsx`（`ComposerPlusMenu`） | ✅ 加在「主体库」下面一项 |
| 入口 2：⌘K | `src/components/workbench/command-palette.tsx` | ✅ 新增「工具」分组，位置在「能力」和「设置」之间 |

浏览器验证细节：两个入口都实测能打开同一个 Sheet；首屏拉到 24 张真实历史资产，点「加载更多」用 `before` 游标再拉 24 张，48 张全部去重（`Set` 校验无重复 `src`）；点某张卡的「插入到消息」，`fetch` 该资产内容成功（200）、`aui.composer().addAttachment()` 后 composer 区域真的多出一个 `.aui-attachment-root`，随后 Sheet 关闭。

## 已知瑕疵（延续自上次，未修）

**置顶后不刷新当前视图就看不到分组跳动。** 细节见 git log 里 `adacd8f` 之前那版 HANDOFF（已被这次覆盖，可以 `git show adacd8f:HANDOFF.md` 翻出来）。这次没碰这块代码，问题原样还在。

## 这次踩的坑

**Radix `Sheet`/`Dialog` 在这个沙盒的浏览器自动化工具里，关闭动画比平时感觉更慢。** 点了关闭按钮或触发 `onOpenChange(false)` 之后，`role="dialog"` 的节点不会立刻从 DOM 消失，用 `read_page`/`javascript_tool` 马上查会看到内容还在（甚至看起来像“没关掉”）；等个 2~3 秒再查就确认关了。JobCenterSheet 和 AssetLibrarySheet 的关闭逻辑本身都是对的，纯粹是验证时候等得不够久，别被这个现象误导成「close() 没生效」去瞎改代码。

**这个沙盒里 Radix `DropdownMenu` 用 `computer` 工具的 `left_click` 点触发按钮，有时候第一次点没反应（`data-state` 还是 `closed`），第二次点才真的开。** 用原生 `.click()` 或手工 dispatch 完整的 pointerdown/mousedown/pointerup/mouseup/click 序列也复现过同样的延迟。原因没深挖（可能是 Radix 的 pointer-capture 逻辑和这个沙盒的合成事件时序对不上），已确认不是我这次改的代码的问题——同样的现象在完全没碰过的「账号与工作区」下拉菜单上也能复现。下次调试类似菜单，多点一次或者等一下再查。

**提交前发现 `src/components/workbench/backend-select.tsx` 和 `src/app/assistant.tsx` 有一处不是我做的改动**：完整移除了头部的 `HeaderBackendStatus` 徽标组件（导出和所有引用都干净地删掉了，没留下悬挂引用，`tsc`/`eslint`/`vitest` 全过）。看起来是有意为之的外部改动，没有回退，一并提交了。如果这不是预期的，git blame `1ab7528` 能看到具体 diff。

## 环境踩坑记录（延续自上次，仍然有效）

`npm install` 如果巨慢或报 403，先查 `package-lock.json` 里的 `registry.npmmirror.com` 镜像地址问题（详见 `adacd8f` 之前那版 HANDOFF 或 `git log -p -- package-lock.json`）。这次没有触发这个问题（这次会话开始时 `node_modules` 已经装好了，只跑了一次 `npm install` 做增量校验，9 秒完事）。

**Windows 下 `next dev -p 3020` 起不来**：3020 落在 Windows 保留端口段里，报 `EADDRINUSE`/reserved port 错误。`.claude/launch.json` 里已经准备好备用配置 `workbench-dev-3100`（`-p 3100`），这次全程用它验证，没问题。

## 下一步：N3

Plan 原文第三批的最后一项：

**N3 用量面板** — 设置里新分区，新增 `GET /api/workbench/usage?range=day|week|month`。这次没有深入调研这块（用量数据存在哪张表、口径怎么定义都还没查），下一个会话开始前建议先起一个 Explore 调研：
- 用量/计费相关的数据现在存在哪（`mono_jobs` 有没有能顺出 token/时长/张数的字段？有没有专门的用量表？）
- `settings-dialog.tsx` 里加新分区的现有模式（参考「外观」「数据」分区怎么写的）
- 复用点参考原 plan 表格里提到的模式，这次 N1/N2 都验证了「新 store + 仿 SubjectLibrary 的 Sheet 壳」这套路子很顺手，N3 大概率是「新 store + 设置分区里嵌一个统计面板」而不是 Sheet，UI 形态会不一样，调研时注意确认。

## 回归验证方式（照抄即可）

```bash
npx tsc --noEmit          # 应为 0 错误（如果报 .next/dev/types 下一堆 TS1005，先 rm -rf .next 再跑，是构建缓存不是真错误）
npx eslint .               # 应只剩 pre-existing 的 13 个问题（跟本次改动无关的文件）
npx vitest run              # 239 passed，全绿
```

浏览器验证需要先在 `.env.local`（gitignored，可以放心留着）设置一次性 bootstrap 账号：
```bash
WORKBENCH_BOOTSTRAP_EMAIL="dev@workbench.local"
WORKBENCH_BOOTSTRAP_PASSWORD="dev-smoke-test-pw-12345"
```
（密码需要 ≥12 位，见 `ensureConfiguredBootstrap` 里的校验。）这次会话已经把这两行写进 `.env.local` 了，直接用 `workbench-dev-3100` 配置起服务、打开浏览器就是已登录状态，不用重新走一遍登录流程。Qwen 直连这次是真的在线，之前几轮 handoff 提到的「后端离线不影响纯前端验证」这次没用上——如果之后又变离线，纯前端功能（Sheet 打开、菜单项、分页）依然不受影响。

## B 组（按需，不急）

提示词库、消息分叉、消息收藏、长任务浏览器通知、分享链接——原 plan 里已经写清楚了，等 N3 做完再看优先级。
