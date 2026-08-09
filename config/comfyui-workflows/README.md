# ComfyUI 工作流目录

每个视频/图片处理能力对应一个 **API 格式** 工作流 JSON，文件名 = 任务 kind：

| 文件 | 能力 | 建议模型 |
|---|---|---|
| `product-main-image.json` | 商品主图白场归一与 800×800 构图 | BiRefNet + ComfyUI-WhiteField |
| `matting-image.json` | 图片抠像换背景 | BiRefNet |
| `matting-video.json` | 视频抠像换背景 | RVM (Robust Video Matting) |

后续能力按同名约定扩展（`erase-video.json` 智能擦除、`lipsync.json` 口型同步、
`enhance-video.json` 修复增强……），Workbench 代码不需要改：换模型 = 换工作流文件。

## 如何生成工作流文件

1. 在 ComfyUI 里搭好工作流并跑通一次；
2. 设置 → 启用「Dev mode Options」，用 **Save (API Format)** 导出 JSON；
3. 把需要 Workbench 动态注入的字段值替换成占位符字符串（见下），存到本目录。

## 占位符约定

工作流 JSON 里的字符串值 `"{{TOKEN}}"` 会在提交前被替换：

| 占位符 | 含义 |
|---|---|
| `{{INPUT_MEDIA}}` | 输入文件名（Workbench 已上传到 ComfyUI 的 input 目录） |
| `{{INPUT_IMAGE}}` | 图片输入文件名（Workbench 已按内容哈希上传） |
| `{{OUTPUT_PREFIX}}` | ComfyUI 输出前缀 |

`wan2.2-ti2v-5b.json` is the checked-in API prompt export for the official
Wan2.2 TI2V-5B workflow. It uses `wan2.2_ti2v_5B_fp16.safetensors`,
`wan2.2_vae.safetensors`, and the installed UMT5 encoder. The video runner
fills its prompt, seed, dimensions, 121 frames, and output prefix; for text to
video it removes the optional `LoadImage` edge before submission.
| `{{BACKGROUND_COLOR}}` | 背景纯色 `#RRGGBB`，未指定时为空字符串 |
| `{{BACKGROUND_MEDIA}}` | 背景图文件名，未指定时为空字符串 |

注意：模板里出现的占位符必须能被参数覆盖，多余的占位符会导致任务报错，
不用的输入请直接在工作流里删掉。`matting-image.example.json` 是一个骨架示例，
节点类型（class_type）取决于你 ComfyUI 安装的自定义节点，请以自己导出的为准，
确认可用后去掉 `.example` 后缀。

## 商品主图白场工作流

`product-main-image.json` 是生产主图的唯一工作流。它保留真实阴影，不调用扩散
模型，也不经过本地二次抠图或方图重构。节点 15 直接保存 800×800 `_main` 成品；
节点 9 把 QA 报告写入 ComfyUI history，Workbench 只接受
`product_delta_max=0.000`。工作流没有诊断白底 SaveImage 节点，因此 history 只长期
保留 `_main` 成品，不堆积 3000px 中间文件。

生产参数固定为：`MASK_LONG_EDGE=2400`、`DELIVER_LONG_EDGE=3000`、
`EXCLUDE_PX=40`、`DILATE_PX=0`、`FEATHER_PX=1`、`WHITE_AT=0.965`、
`SHADOW_GAIN=1`、`HOLE_WHITE=0`、`SQUARE_FILL=0.90`、`SQUARE_SIDE=800`。

## 相关环境变量

- `COMFYUI_URL`：ComfyUI 地址，如 `http://127.0.0.1:8188`
- `COMFYUI_WORKFLOWS_DIR`：工作流目录（默认本目录）
- `COMFYUI_TIMEOUT_MS`：单任务超时（默认 10 分钟）
