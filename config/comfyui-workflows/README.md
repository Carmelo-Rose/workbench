# ComfyUI 工作流目录

每个视频/图片处理能力对应一个 **API 格式** 工作流 JSON，文件名 = 任务 kind：

| 文件 | 能力 | 建议模型 |
|---|---|---|
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
| `{{BACKGROUND_COLOR}}` | 背景纯色 `#RRGGBB`，未指定时为空字符串 |
| `{{BACKGROUND_MEDIA}}` | 背景图文件名，未指定时为空字符串 |

注意：模板里出现的占位符必须能被参数覆盖，多余的占位符会导致任务报错，
不用的输入请直接在工作流里删掉。`matting-image.example.json` 是一个骨架示例，
节点类型（class_type）取决于你 ComfyUI 安装的自定义节点，请以自己导出的为准，
确认可用后去掉 `.example` 后缀。

## 相关环境变量

- `COMFYUI_URL`：ComfyUI 地址，如 `http://127.0.0.1:8188`
- `COMFYUI_WORKFLOWS_DIR`：工作流目录（默认本目录）
- `COMFYUI_TIMEOUT_MS`：单任务超时（默认 10 分钟）
