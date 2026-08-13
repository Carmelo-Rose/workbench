# 商品白场归一（主图 / SKU）

> 状态：生产实现说明。最后按代码核对：2026-08-10。
>
> 本文是白场归一业务语义、运行边界与维护规则的单一入口。修改工作流、
> 调度策略、验收条件或参数时，必须在同一个改动中更新本文；节点数学与实现
> 细节留在 `config/comfyui-custom-nodes/ComfyUI-WhiteField/README.md`。

## 业务范围

白场归一服务商品套图流程中的**主图**与 **SKU** 两个分支，用途相反：

- **主图 V1（默认）**：对每张符合“商品整体图”条件的原始拍摄图，生成一张
  800×800 PNG 成品，发布到 `主图/`。背景归一为白色，**保留**实测投影。
- **主图 V2（显式选择）**：先走 SKU 的去投影白场与二次抠图，再按拍摄组内序号
  匹配版本化固定阴影，发布到 `主图-v2/`。匹配不安全或模板不可用时该张回退 V1，
  但仍写入 `主图-v2/`，不会覆盖 V1。
- **SKU**：只对每个颜色的代表图，生成一张背景被压平为纯白的归一图，作为抠图和
  构图的输入，成品发布到 `SKU/`。投影被**除掉**。

它不用于详情套图、模特图、视频或通用抠像，这些有各自的渲染链路。

### 为什么 SKU 也要走白场

SKU 要求纯白底、无投影。原先的做法是「原图像素 + 抠图蒙版按 224 二值化」，
在深色商品上会失效：白纸上的接触投影和黑色商品之间**没有亮度边界**，蒙版无论切在
哪里都会把一部分投影当成商品带进纯白底。实测同一款帽子的黑/藏青/米白三色，
按外接框归一后逐列比对，黑色帽檐下沿比米白低 25–40px（成品高度的 4–6%），
而帽冠边缘三色只差 1–3px。把 `SKU_ALPHA_THRESHOLD` 从 224 提到 253 只让轮廓
整体内缩 1–3px，对这条投影无效——因为问题不是软边界，是没有边界。

白场归一绕开了这个死结：接触投影本质是白纸被**乘性压暗**，除以拟合底图即可还原，
不需要那条不存在的边界；商品本身由 `protect` 携带，不参与这项运算。归一之后商品
与底之间是高对比（实测黑帽 25 vs 白底 250+），蒙版只需完成一次平凡的分割。

输入必须是商品在平滑无缝背景前的棚拍整体图。细节特写和空抠图会在进入主图分支前
被排除。对于纹理/图案背景、毛绒、透明或强镜面商品，尚无生产验证，不能承诺效果。

## 输出与质量约束

### 主图

- 唯一交付物是工作流节点 15 保存的 `_main` 文件，尺寸固定为 800×800。
- 商品蒙版只作为保护区域：商品内部像素必须原样保留，不使用生成式重绘，也不合成阴影。
- 背景通过估计无商品时的底图并做除法归一为白色；原始投影保留其方向、形状和衰减。
- 节点 9 的 QA 必须返回且仅返回 `product_delta_max=0.000`；否则本张失败，可在本地最多重试 3 次。
- 诊断图不落盘，ComfyUI history 长期仅保留 `_main` 成品和 QA 文本。

### SKU

- 归一图不是交付物，是中间产物：它整幅返回（不经 WhiteField 自己的方图裁切），
  再送抠图、按 224 二值化、由 `composeSquareDeliverable` 裁成 800×800 成品。
- 节点 9 的 QA 同样必须是 `product_delta_max=0.000`。**不论 `SHADOW_GAIN` 调到多大，
  商品像素都不允许被改动**——投影项在 `protect` 之外，调高增益只影响背景。
- 构图外接框取自**归一图上重新抠出的蒙版**，不复用白底大图测得的
  `SourceMetric.box`。后者是在未归一的画面上量的，深色商品上会把投影一起框进去，
  导致商品比 `SQUARE_SKU_FILL_RATIO` 要求的更小、更偏下，且各颜色不一致。
- 验收：成品轮廓以下必须是纯白；同款不同色在同一相对位置的轮廓应当一致（跨色对照
  是判断“真实产品形状”还是“残留投影”的首选方法，比调阈值可靠）。

### 主图 V2 固定阴影

- 输入字段为 `mainImageVersion="template-shadow-v2"`；省略字段始终等价于
  `whitefield-v1`。创建 V2 任务还会锁定 `shadowTemplateVersion=hat-shadow-v1`。
- 每个颜色组必须恰好六张，且文件名最后一个数字严格递增。序号 2–6 依次映射为
  左斜、正面、俯视、侧面、背面；序号 1 没有模板，按设计回退 V1。
- 模板包位于 `config/product-main-shadows/<version>/`。manifest 与每张透明 PNG 都会
  在任务运行时做路径、尺寸、透明通道和 SHA-256 校验；原始样例共享盘不是运行依赖。
- 正面与左斜各有两个候选，按标准化商品的包围盒、尺寸与接地点做确定性最近匹配。
  阴影只允许等比缩放和平移，不拉伸、不镜像；合成顺序固定为白底、阴影、商品。

## 运行链路

```text
原始整体图
  → 上传到 ComfyUI input（内容哈希命名）
  → product-main-image.json
      ├─ BiRefNet：商品分割蒙版（GPU）
      ├─ WhiteField：背景拟合 / 白场归一 / QA / 1:1 构图（CPU）
      └─ SaveImage：800×800 _main
  → 读取 QA 与成品尺寸
  → 原子发布至 主图/
```

工作流定义：`config/comfyui-workflows/product-main-image.json`。
编排入口：`src/lib/mono/product-pipeline.ts` 中的 `requestWhiteFieldMain()` 与
`runMainBranch()`。

SKU 分支：

```text
颜色代表图（原图）
  → 上传到 ComfyUI input（内容哈希命名）
  → product-sku-field.json（节点 1–7、9，与主图同构，去掉方图裁切节点 14）
      └─ SaveImage：整幅归一图（背景压平为纯白）
  → 送抠图网关重新抠一次蒙版
  → 阈值 224 → 由新蒙版取外接框 → composeSquareDeliverable
  → 原子发布至 SKU/
```

工作流定义：`config/comfyui-workflows/product-sku-field.json`。
编排入口：`requestWhiteFieldSkuField()`、`composeSkuFromField()` 与 `runSkuBranch()`。

V2 主图复用同一条 SKU 去投影中间链路，随后由 Sharp 在本地完成 800×800 构图与
固定阴影合成。同一原图的去投影结果在主图 V2 和 SKU 分支之间按内容哈希共享。
模板制作使用 `product-shadow-template.json` 和
`scripts/build-product-shadow-bundle.ts`，只在发布新模板包时离线运行。

## 并发与硬件边界

主图分支会并发遍历候选图片，但每一张提交 ComfyUI 前都会进入
`productCutoutScheduler.runExclusive()`。因此，**白场工作流在整个 Workbench 进程内
一次只运行一张**：它先等待普通抠像任务清空，再独占 GPU，完成后才放行下一张。

SKU 归一走同一把独占锁，但只对**颜色代表图**提交，即每个颜色一次而不是每帧一次。
一个 3–7 色的 V1 商品因此增加 3–7 次独占运行（实测每次约 12–25 秒）。V2 对模板
命中的主图都使用 `SHADOW_GAIN=64` 去投影；其中颜色代表图与 SKU 共用同一个任务内
Promise 缓存，避免重复提交。V1 与 V2 的主图请求不会跨任务复用。

这是混合 CPU/GPU 链路，而不是同一张图的 CPU/GPU 并行计算：

| 阶段 | 主要资源 | 说明 |
|---|---|---|
| BiRefNet 分割 | GPU | 生成商品蒙版。 |
| WhiteField 自定义节点 | CPU | NumPy/OpenCV 计算；节点将 Tensor 转为 CPU 数组处理。 |
| 上传、下载、元数据校验、发布 | CPU / I/O | 与白场计算的关键路径前后衔接。 |

CPU 阶段依赖分割结果，GPU 也被独占锁保护；不要仅把 `runWithConcurrency` 的数量调大来
提高白场吞吐量，它不会让 ComfyUI 白场任务并发，反而会增加排队与内存压力。

普通抠像的默认调度上限与白场不同：单文件夹最多 6、全局最多 12，可由
`PRODUCT_PIPELINE_FOLDER_CUTOUT_CONCURRENCY`（或兼容变量
`PRODUCT_PIPELINE_CUTOUT_CONCURRENCY`）和 `PRODUCT_PIPELINE_GLOBAL_CUTOUT_CONCURRENCY`
向下调整；白场独占策略不受这些上限放开。

## 固定生产参数

| 参数 | 值 | 作用 |
|---|---:|---|
| `MASK_LONG_EDGE` | 2400 | 分割输入长边。 |
| `DELIVER_LONG_EDGE` | 3000 | 归一化前交付分辨率。 |
| `EXCLUDE_PX` | 40 | 背景拟合时避开商品边缘。 |
| `DILATE_PX` / `FEATHER_PX` | 0 / 1 | 商品保护区；增大 dilation 会造成灰边。 |
| `WHITE_AT` | 0.965 | 白点阈值。 |
| `SHADOW_GAIN` | 1 | 不强化或削弱实测阴影。 |
| `HOLE_WHITE` | 0 | 保留封闭开口中的实测结果。 |
| `SQUARE_FILL` / `SQUARE_SIDE` | 0.90 / 800 | 主图 1:1 构图。 |

SKU 归一（`WHITE_FIELD_SKU_FIELD_PARAMS`）继承上表，只覆盖一项：

| 参数 | 值 | 作用 |
|---|---:|---|
| `SHADOW_GAIN` | 64 | 把投影压平为纸白。 |

64 的来由：本类目最深的接触投影透过率实测约 0.13，`1 - (1 - t) / gain` 必须越过
`WHITE_AT`（0.965）才能被裁到纯白，需要 gain ≈ 25；64 留出余量应对更深的遮挡，
又不至于把底图噪声放大成色带。节点侧 `shadow_gain` 上限相应从 3 放开到 128。
SKU 不使用 `SQUARE_FILL` / `SQUARE_SIDE`（工作流里没有裁切节点），成品构图由
`SQUARE_SKU_CROP_PADDING` / `SQUARE_SKU_FILL_RATIO` 决定。

ComfyUI 连接和工作流目录由 `COMFYUI_URL`、`COMFYUI_WORKFLOWS_DIR`、
`COMFYUI_TIMEOUT_MS` 配置。

V2 创建入口由服务端环境变量 `PRODUCT_MAIN_V2_ENABLED=true` 开放。开关只影响新任务；
已经创建的任务完全按持久化版本执行，不能在 worker 执行期间漂移。

## 变更规则

1. 改节点算法或参数：同步更新本文的“固定生产参数”和
   `ComfyUI-WhiteField/README.md` 的算法说明；用代表性商品重新验证 QA。
2. 改工作流节点、输出节点或文件名：同步更新本文、
   `config/comfyui-workflows/README.md`，并确认节点 9 / 15 的读取逻辑仍匹配。
3. 改调度或硬件使用：同步更新本文“并发与硬件边界”，并补充
   `ProductCutoutScheduler` 的单元测试。
4. 扩大到其他素材（详情、模特、视频）：先明确新的输入质量标准、成品规范和验收
   指标；不得把已有分支的白场策略静默复用过去。SKU 的扩用见上文“为什么 SKU 也要
   走白场”与“输出与质量约束 / SKU”，它与主图**参数不同、成品规范不同**，两者的
   `SHADOW_GAIN` 不可互换。
5. 节点侧改 `shadow_gain` 上限或语义：AILAB 上的 ComfyUI 自定义节点是仓库的副本，
   改完要同步到 `custom_nodes/ComfyUI-WhiteField/` 并**重启 ComfyUI**（自定义节点在
   启动时加载）；否则新工作流会在提交时被节点的参数范围校验拒绝。

## 排障速查

| 现象 | 首查位置 |
|---|---|
| 一张主图失败 | 节点 9 QA 文本、3 次重试的最后错误。 |
| 不是 800×800 | 节点 15 输出及 `SQUARE_SIDE`。 |
| 商品像素被改动 | `product_delta_max`；不为 0 必须拒绝交付。 |
| 白场队列慢 | 是否有普通抠像在运行；白场本来就是全局串行。 |
| 边缘灰晕 | `DILATE_PX` 是否被调高；默认必须为 0。 |
| SKU 底部仍有暗块 | 先做跨色对照定位是真实形状还是残留投影；是残留就查 `SHADOW_GAIN` 是否生效（节点上限是否已放开、ComfyUI 是否已重启），不要去调 `SKU_ALPHA_THRESHOLD`。 |
| 提交 SKU 工作流报 `value_bigger_than_max` | AILAB 上的节点还是旧版（`shadow_gain` 上限 3）；同步节点文件并重启 ComfyUI。 |
