# video-toolbox-gateway

跑在 AILAB 服务机（192.168.1.198）上的视频工具箱 Job 网关：为 workbench 提供统一的异步视频处理协议。每个能力独立 venv、以子进程方式执行；`product_cutout` 可由 Workbench 的公平调度并行运行，网关仍以 12 个任务作为最终 GPU 硬上限。

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

除 `/health` 外，网关要求 `TOOLBOX_TOKEN`，Workbench 代理会同时注入服务
token、`x-workbench-workspace-id` 和 `x-workbench-user-id`。上传文件、任务、
日志、产物和 `job:` 串联引用都会在网关端按 workspace 再校验一次；浏览器不应
直连网关，也不能自行提供这些身份头。

升级旧网关数据时可临时设置 `TOOLBOX_ALLOW_LEGACY_TENANT=true`，既有文件和
任务会归入 `default` / `local-user`。迁移完成后应关闭。只有完全隔离的本机开发
环境才能用 `TOOLBOX_ALLOW_INSECURE_LOCAL=true` 跳过 token，生产或局域网部署
禁止开启。

## 商品白底图并发

Workbench 负责商品文件夹 FIFO 独占、每文件夹最多 6 张和全局公平分配；网关负责
最终全局保护。默认值为 `TOOLBOX_PRODUCT_CUTOUT_CONCURRENCY=12`，可向下调整，
但不要超过 12。Workbench 传入的 `productFolderKey` 是不可逆摘要，不含 UNC 路径。

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
