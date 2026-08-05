# 交接文档：商品套图主图「重叠」问题 → 改为大模型整张直出

更新时间：2026-08-03。改动**已完成、未提交**，**未跑通一次完整任务**——最后一次运行因 AILAB 服务机断电失败（见「当前阻塞」）。

注意：`.claude/handoff.md` 是另一个会话（前端 UX bug）的交接文档，与本文件无关，别搞混。

## 起因

用户报 `Z:\型麦-得物-品牌\【详情页】-待审\1234\主图` 里的主图有「重叠效果」，怀疑是本地处理和大模型生成叠加了。**这个怀疑是对的。**

## 根因（已确认）

`composeSquareDeliverable` 渲染主图时叠了两层：

- **底层** `naturalShadow` —— `requestShadowBackdrop()` 返回的图。名字叫「阴影」，但模型返回的是**一整张重画过的商品照片**（白底 + 阴影 + 商品）。
- **上层** `foreground` —— 本地抠图抠出来的**原始商品**。

模型虽被要求「保持商品像素不变」，但它是整张重新生成的，商品的位置/大小/轮廓必然差几十像素。底层那顶模型画的帽子从上层边缘露出来，就是双圆顶、双顶扣、多一条弧线。

**验证方式**：用 `scripts/try-shadow-backdrop.ts` 直连模型（绕开抠图和合成）跑同一张原图，输出干净无重叠；而交付目录里同一张有明显双层。据此锁定问题在模型输出**之后**的合成步骤。

## 试过的两条路

### 方案 1：只取阴影，商品用本地真实像素（**已放弃**）

思路：把生成图里的商品抹掉只留投影，垫在本地抠图下面。做了 5 轮迭代：

1. 按彩度剔除商品（投影是灰的、商品带彩度）→ 重叠没了，但帽檐下接触阴影被整块抹白，露出锯齿状白斑。
2. 合并本地 `composeNaturalShadowBackdrop` 恢复接触阴影 → 白斑没了。
3. 轮廓一圈白边 → 是「前景层画到 alpha≥96、阴影层抹白到 alpha≥24」中间那段三不管造成的，对齐阈值后消失。
4. 帽檐下缘一条亮线 → 是模型自己画的帽檐高光边落在轮廓外被当成投影留下了，把抹白范围放宽到 matte≥8 后消失。
5. 帽檐下深阴影变中灰 → 亮度下限把该黑的像素当「模型画的暗部」删了，改从原图取回（`recoverPhotographedDarkness`）后与原图一致。

全尺寸合成看起来已经可用。**但真实 800×800 成品是废图**：帽子后面出现一个纯白的帽子形硬边轮廓。原因是 `composeSquareDeliverable` 用**不同的裁切边距**（阴影 0.12 / 前景 0.02）分别裁切再分别缩放，我把商品区填成纯白的做法一旦对不齐，那块白就以帽子形状露出来。我全程只验了全尺寸，没验方形成品这一步，所以没提前发现。

**结论**：把两张独立生成的图在像素级对齐拼起来，本身就是个不断长出新缝的做法——修完一处换个地方再冒。用户据此决定放弃。相关代码（`stripGeneratedProduct` / `recoverPhotographedDarkness` / `mergeDarker`）**已全部删除**。

### 方案 2：主图整张交给模型直出（**当前采用**）

用户明确选择这条。5 张原图（329A4143/4144/4145/4146/4147）验过：

- **好**：结构完全干净，无重叠、无白边、白底和投影自然一致。没有拼接就没有对齐问题。
- **代价（固有，改不掉）**：商品像素是模型重画的——颜色整体偏暖偏红偏亮、斜纹布质感发绵（变成雾状绒面）、绣花线迹被抹平成糖块状、logo 字母间距和位置有漂移。
- **慢**：每张 90–190 秒，没有改善。

## 当前代码状态（已改完，未提交）

`git diff` 涉及 3 个文件（其余改动是别的会话的，别动）：

**`src/lib/mono/product-pipeline.ts`**

- `MasterRenderLayers.naturalShadow` → `mainImage`（模型返回的整张图）。
- `makeWhiteMaster()`：主图改用 `requestShadowBackdrop()` 的整张返回图，并做白场提升（`GENERATED_SWEEP_WHITE_FLOOR = 245`，`.linear(255/245, 0)`）。**这个提升是必须的**——模型返回的白底差几个色阶，直接贴到纯白画布上会看出一个矩形边框。代价是阴影浓度损失几个百分点。
- `composeSquareDeliverable()`：第一个参数 `foreground` → `source`；options 从 `{ naturalShadow?: Buffer }` 改成显式的 `{ framing?: "main" | "sku" }`（原来是「有阴影层就算主图」的隐式判断）。阴影图层的拼贴逻辑、`clipLayerToSquare`、`SQUARE_SHADOW_CROP_PADDING` 全部删除。
- 主图渲染改用 `layers.mainImage` + `{ framing: "main" }`；SKU 路径不变。
- `PRODUCT_PIPELINE_SHADOW_ONLY_TRIAL` 恢复成 `false`（会正常跑 images）。调试期间我曾设为 `true`（只出主图/SKU，跳过付费 images），**要单独验主图时把它改回 `true`**，任务结果 `warnings` 里会带一条提示。

**`src/lib/mono/product-pipeline.test.ts`**：原「places a supplied natural-shadow backdrop under the product」用例已不适用，改写成「模型图自带的阴影能完整活过裁切和缩放」。

**`package.json`**：`mono:worker` 从 `tsx scripts/mono-worker.ts` 改成 `tsx watch ...`（原因见下）。

**验证状态**：`npx vitest run` 236 个全过，`eslint` 干净，`tsc --noEmit` 干净（`.next/dev/**` 的报错是另一个会话 dev server 生成的临时类型文件，不算）。**但没跑通过一次真实任务**。

## 当前阻塞

最后一次运行 `job_1e55f689-2109-4bbc-ba0d-8b39d2b928ac` 失败：

```
status = failed, error = "fetch failed"
最后事件 = progress {"stage":"正在生成白底主图","progress":5}
耗时 6.2 秒
```

6 秒就死在第一个网络调用上，即 `requestCutout()` 往网关传图那一步。**用户确认是 AILAB 服务机断电了**（网关 `http://192.168.1.198:8100`，见 `src/lib/toolbox/gateway.ts`）。不是代码问题。

服务机恢复后直接重跑即可。另外倒数第二个任务失败于 `gpt-image-2 请求失败 (HTTP 400)：excessive system load`，那是生图服务端的临时过载，也不是代码问题——重试即可。

## 环境坑（很重要，之前在这上面浪费了大量时间）

**1. worker 是独立进程，不跟着 Next 热更新。**
`.env.local` 里 `MONO_WORKER_MODE=standalone`，网页进程只负责入队，真正执行在 `npm run mono:worker` 起的独立进程里。**改了 `product-pipeline.ts` 而不重启这个进程，改动完全不生效**——本会话前期整整两轮「修了没用」都是这个原因（进程从 8/2 20:52 起就没重启过，一直跑旧代码）。已经把 `package.json` 的 `mono:worker` 改成 `tsx watch`，现在它会在源码变化时自己重启，日志里能看到 `[tsx] change in ... Restarting...`。**下个会话开工前先确认这个进程活着并且重启时间晚于最后一次代码改动。**

**2. 端口 3020 vs 3100。**
`package.json` 里 dev/start 都是 3020，但当前 3100 上跑着另一个会话起的 dev server（父进程命令是 `next dev -p 3020 -p 3100`，`-p` 写了两遍后者生效）。3020 上那个进程是 8/2 19:43 起的、读不到命令行、早于所有改动，很可能是旧构建。**用 3100。**（不过出图逻辑在 worker 里，网页进程只影响 UI 新旧。）

**3. Bash 里的 `python3` 是坏的**（Windows Store 的占位 stub，退出码 49）。用 PowerShell 里的 `python`（`AppData\Local\Programs\Python\Python311`），PIL 可用。

**4. sqlite3 CLI 在** `/c/Users/Administrator.DESKTOP-GRHN4PA/AppData/Local/Android/Sdk/platform-tools/sqlite3`。查任务：`mono_jobs`（注意 `mono_job_events` 的列是 `event_type` / `detail_json`，没有 `stage` 列）。

**5. nano-banana-fast 不接受像素比例。** 试过把主图模型换成它，服务端一律 400 `generate failed`。探测确认：它只吃 `3:4` 这类标准比例，`8688:5792` 这种像素比例会被拒；`gpt-image-2` 两种都吃。`requestShadowBackdrop` 传的正是 `${width}:${height}`。**要换 nano-banana 系模型必须先改 aspectRatio 的传法。**

## 待办

1. **服务机恢复后跑通一次完整任务**，确认方案 2 的 800×800 成品没问题（这是唯一没验过的环节，方案 1 就是栽在这里）。
2. **跑几遍稳定后清理死代码**（用户明确说等跑通再一起整理）：
   - `composeNaturalShadowBackdrop()` —— 本地阴影恢复，现在没人调用了。它是之前就提交在仓库里的、带测试的代码，我没敢删，留着是死代码，删了想回头得从 git 翻。
   - `requestShadowBackdrop()` 的 `model` 参数默认值仍是 `gpt-image-2`，`scripts/try-shadow-backdrop.ts` 还在用它，那个脚本本身是之前提交的，保留。
3. **未解决的性能问题**：用户问 images 能不能不等抠白底、并行去生图。**现在是串行的**——`runProductPipeline` 先把所有原图跑完 `makeWhiteMaster`，再 `classifyProductSources`，最后才轮到模特图。代码里 `masterToOriginal` 那段 TRIAL 注释只是让模特图的**参考图**改用原图，**执行顺序没动**，因为分类要吃白底图来聚颜色和量裁切框，卡在中间。要真并行得让分类改吃原图，是重构，不是开关。
4. **已知限制**：主图色差和材质失真是方案 2 的固有代价。如果后续审核过不了，剩下的路只有回到「本地阴影恢复」（`composeNaturalShadowBackdrop` 单独用，免费、瞬时、结构上不可能重影，但阴影是算法水平）——这一版**代码写好了但用户没看就放弃了**，git 历史里没有，需要重写（很简单：`makeWhiteMaster` 里把 `requestShadowBackdrop` 换成 `composeNaturalShadowBackdrop(source.path, cutout)`，恢复 `naturalShadow` 那套即可）。
