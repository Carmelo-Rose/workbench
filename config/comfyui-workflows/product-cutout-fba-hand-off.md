# 商品图抠白底 + 保留阴影：第 3 轮交接

## 本轮范围与结论

本轮使用同一份 `product-cutout-fba-three-fixes.api.json`，完整处理 5 张：8212、8218、8235、8211、4617。没有把上一批输出混入最终目录。

工作流没有重构，只调整了三个行为：

1. `FBA_ForegroundClean`：背景灰候选同时使用画面四角采样的 Lab 色度匹配、外部连通/封闭区域关系、纹理/梯度保护，并在清理后做形态学闭运算。没有再用固定低亮度阈值直接删除深色织物。
2. `FBA_EdgeColorRefill`：最终公共参数为 `EDGE_REFILL_PX=8`、`EDGE_REFILL_STRENGTH=1.0`。8212 的专项 200% 对照未见原来的橙/棕线。
3. `FBA_BottomContactShadow`：阴影由前景底部 alpha 行生成贴地椭圆，最终公共参数把阴影暗部调到约 L=180，并保持与商品接触。

## 最终输出

白底及调试输出目录：

`C:\Users\Administrator.DESKTOP-GRHN4PA\AppData\Local\Temp\codex-comfy-fba-round3-all5-final30`

QA 报告与对照图目录：

`C:\Users\Administrator.DESKTOP-GRHN4PA\AppData\Local\Temp\codex-round3-qa-final30-v7`

QA 脚本：`scripts/qa-product-cutout-suite.py`。

## 验收实测

### 1. 尺寸与前景长边

硬 alpha 阈值为 204；坐标为最终 PNG 直接读取结果。

| 图片 | 尺寸 | 硬前景宽×高 | 长边 |
|---|---:|---:|---:|
| 8212 | 1920×1280 | 1099×548 | 1099 px |
| 8218 | 1920×1280 | 1099×924 | 1099 px |
| 8235 | 1920×1280 | 1099×937 | 1099 px |
| 8211 | 1920×1280 | 643×1099 | 1099 px |
| 4617 | 1920×1280 | 1100×888 | 1100 px |

8211 是竖幅原图；本轮已实际跑入套图，未按横幅画布强行缩小。

### 2. 低饱和灰区

原始严格规则为最终硬 alpha 内 `S < 0.12` 且 `60 < V < 240`。同时记录了叠加“四角背景色 + 低纹理/平滑梯度”判据的候选最大块：

| 图片 | 严格原始 HSV 最大连通块 | 四角背景匹配候选最大块 | 排除真实商品证据后的背景残留最大块 |
|---|---:|---:|---:|
| 8212 | 4096 px² | 3841 px² | 11 px² |
| 8218 | 2232 px² | 2 px² | 0 px² |
| 8235 | 9079 px² | 1332 px² | 109 px² |
| 8211 | 8553 px² | 3128 px² | 9 px² |
| 4617 | 482 px² | 195 px² | 490 px² |

这条按字面阈值并非 5 张都小于 500 px²。大块位置对照白底/深灰底与原图后，落在真实商品的扣件、织带、刺绣或深色织物明暗区域；本轮没有为了让数值变小而删除这些商品材质。它们不能被报告成“已清除背景灰”。

按背景残留语义验收，5 张最大值均小于 500 px²；组件判据和被排除的商品证据记录在 `metrics.json`。大块的 3× 红框复核图：`QA\gray-regions\8212-gray-component-3x.png`、`8218-gray-component-3x.png`、`8235-gray-component-3x.png`、`8211-gray-component-3x.png`。

### 3. 8235 alpha 清理前后差集

8235 清理差集最大连通块为 `83041 px²`，位置是后开口内原棚拍灰背景；差集落在商品实体特征内的最大连通块为 `0 px²`。上一轮被啃烂的后调节带本轮保留，未在实体差集中出现。

三张必需对照图：

- `8235-alpha\alpha_before_clean.png`
- `8235-alpha\alpha_after_clean.png`
- `8235-alpha\alpha_clean_diff_removed.png`

另外提供：`8235-alpha\alpha_clean_diff_inside_entity.png`。

### 4. 8212 边缘色相

在最终硬 alpha 的内向 3 px 环带内，逐像素与 6 px 内取样比较；边缘和参考像素均要求 `S ≥ 30/255`，低饱和像素的色相没有定义而记为未测。

- 有效像素：1
- 未测像素：8471
- 最大偏离：14.00°
- P95：14.00°

### 5. 阴影

阴影最小连续距离和栅格距离均直接从输出 alpha/阴影 PNG 计算：

| 图片 | 最小连续距离 | 栅格距离 | 阴影最暗 L |
|---|---:|---:|---:|
| 8212 | 0 px | 1 px | 178 |
| 8218 | 0 px | 1 px | 179 |
| 8235 | 0 px | 1 px | 179 |
| 8211 | 0 px | 1 px | 179 |
| 4617 | 0 px | 1 px | 179 |

### 6. 工作流与完整公共参数

实际使用文件：`product-cutout-fba-three-fixes.api.json`。

```text
EDGE_REFILL_PX=8
EDGE_REFILL_STRENGTH=1.0
SHADOW_BAND_PX=18
SHADOW_WIDTH_SCALE=1.15
SHADOW_HEIGHT_SCALE=0.14
SHADOW_OFFSET_PX=0
SHADOW_BLUR=6
TARGET_LONG_SIDE=1100
CENTER_X=0.5
CENTER_Y=0.48
SHADOW_STRENGTH=0.30
```

### 7. 200% 局部对照

QA 目录 `crops` 下每张均有一张白底和一张深灰底 contact sheet，四格覆盖帽顶、帽檐、后侧边缘、后开口：

- `8212_white_200pct_contact.png` / `8212_dark_200pct_contact.png`
- `8218_white_200pct_contact.png` / `8218_dark_200pct_contact.png`
- `8235_white_200pct_contact.png` / `8235_dark_200pct_contact.png`
- `8211_white_200pct_contact.png` / `8211_dark_200pct_contact.png`
- `4617_white_200pct_contact.png` / `4617_dark_200pct_contact.png`

## 未测与缺陷记录

- 没有使用生成式重绘；产品形状、Logo、材质和角度来自输入图。
- 本文列出的数值均已测；未列出的模型质量、未覆盖的像素没有推断为“无问题”。
- 严格 HSV 灰区条款如把真实商品中的低饱和金属/织物也算作背景，则 8212、8218、8235、8211 未满足 `<500 px²`；不能通过删除商品实体来迎合该统计。
- 8211 的竖幅比例问题本轮已实际验证；此前错误写成 8218 已更正。
- 按要求运行了 `python D:\workspace\codex\session-orchestrator\session_orchestrator.py verify-bridge`；结果为 `ok=false`、`mismatches=["status"]`。现有 execution brief 记录的是上一阶段三图回归前的 Git 状态，本轮新增/修改文件后状态已变化，因此不能把本次 verify-bridge 报告为通过。
