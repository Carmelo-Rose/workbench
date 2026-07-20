# video-toolbox-gateway

跑在 AILAB 服务机（192.168.1.198）上的视频工具箱 Job 网关：为 workbench 提供统一的异步视频处理协议。单 GPU（2080 Ti 22G）串行队列，每个能力独立 venv、以子进程方式执行。

源码在 workbench 仓库 `gateway/` 目录维护，部署时同步到服务机 `D:\hyk_sort\workspace\video-toolbox\gateway`。

## API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/health` | 健康检查（免 token） |
| GET | `/capabilities` | 能力清单（ready / planned） |
| POST | `/files` | multipart 上传输入文件 → `{file_id}` |
| POST | `/files/raw?name=xx.mp4` | 裸字节流上传（workbench 代理用） |
| POST | `/jobs` | 提交任务 `{capability, params, inputs}` |
| GET | `/jobs/{id}` | 任务状态 / 进度 / 产物列表 |
| POST | `/jobs/{id}/cancel` | 取消任务 |
| GET | `/jobs/{id}/artifacts/{path}` | 下载产物 |
| GET | `/jobs/{id}/log` | 查看子进程日志尾部 |

`inputs` 的值支持 `<file_id>` 或 `job:<job_id>/<产物路径>`（把上一个任务的产物接给下一个能力）。

鉴权可选：设置环境变量 `TOOLBOX_TOKEN` 后，除 `/health` 外都要求 `x-toolbox-token` 头（workbench 侧配同名环境变量即可）。

## 部署（服务机）

```bat
cd D:\hyk_sort\workspace\video-toolbox\gateway
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt
start.bat
```

放行防火墙（管理员）：

```bat
netsh advfirewall firewall add rule name="video-toolbox-gateway" dir=in action=allow protocol=TCP localport=8100
```

## 接入新能力（唯一需要做的事）

1. 在服务机为该能力装好独立 venv，写一个 CLI 入口脚本；
2. 在 `capabilities.json` 里把对应条目改为 `status: "ready"` 并补 `adapter` 配置（改完即生效，无需重启）；
3. workbench 侧加一个工具定义 + 用 `JobCard` 包一个 ToolUI（各约 20 行，照抄 video_erase）。

### 子进程约定

- 参数由 `adapter.command` 模板决定，占位符：`{input}`、`{input.<字段>}`、`{output_dir}`、`{job_dir}`、`{params_json}`、`{params.<键>}`、`{cwd}`；
- 产物写入 `{output_dir}`，退出码 0 = 成功；
- stdout 打印 `PROGRESS <0-100> <阶段说明>` 可驱动前端进度条（可选但推荐）；
- 所有输出自动落 `data/jobs/<id>/log.txt`，排错先看它。
