# video-toolbox-gateway

跑在 AILAB 服务机（192.168.1.198）上的视频工具箱 Job 网关：为 workbench 提供统一的异步视频处理协议。每个能力独立 venv、以子进程方式执行；`product_cutout` 可由 Workbench 的公平调度并行运行，网关仍以 12 个任务作为最终 GPU 硬上限。

源码在 workbench 仓库 `gateway/` 目录维护。**服务机上真正跑的部署目录是
`D:\hyk_sort\workspace\workbench-prod\gateway`**——`workbench-prod` 是整个
workbench 仓库的一份完整 git clone（`origin` 指向 GitHub `Carmelo-Rose/workbench`），
不只放 gateway，同一目录下还有 `next start` 跑着的生产前端。更新网关代码的方式是
在服务机对 `workbench-prod` 执行 `git pull`，然后跑 `gateway\restart.bat`
重启 uvicorn（脚本细节见下面「部署（服务机）」）——**没有任何自动同步机制**
（没有对应的计划任务、没有 robocopy/rsync），改了本地代码不 pull 到服务机、
或 pull 了不重启，都不会生效。

`D:\hyk_sort\apps\video-toolbox\gateway` 和
`D:\hyk_sort\prod-data\video-toolbox-gateway\persistent` 是这套 `workbench-prod`
部署方式启用之前的旧网关目录/旧数据目录，**已废弃，待清理**：两边的任务记录
都停在 2026-08-07 16:42 前后（那是切换到 `workbench-prod` 的时间点），之后再没有
新任务写入过。不要在这两个位置改代码或查最新数据。

**这条「已废弃」只针对网关自身**（`gateway/` 下的 `app.py` / `store.py` /
`capabilities.json` 等）。各能力的 adapter 工作目录——`capabilities.json` 里
`cwd` 指向的 `D:/hyk_sort/apps/video-toolbox/enhance`、`erase`、`matting` 等——
是独立于网关部署位置的共享路径，一直有效、没有搬动；改这些能力脚本本身照旧
直接改 `apps/video-toolbox/<capability>/` 下的文件，网关以子进程方式调用，
改完即生效、无需重启网关。但如果要改 `capabilities.json` 本身（新增能力、
调整某个能力的 adapter 配置），必须改
`D:\hyk_sort\workspace\workbench-prod\gateway\capabilities.json` 才是线上真正
读取的那份——`apps\video-toolbox\gateway\capabilities.json` 早就是死文件，
改了不会生效。

## 模型许可

每个能力用的都是第三方预训练模型，许可条款不一样，接新能力或对外交付前先看这张表。

| 能力 | 模型 | 许可 | 注意 |
|------|------|------|------|
| `smart_erase` | ProPainter / LaMa | 各自上游条款 | — |
| `video_enhance` | Real-ESRGAN | BSD-3-Clause | 宽松 |
| `matting`（human） | RobustVideoMatting | **GPL-3.0** | 模型定义 vendor 在 `capabilities/matting/model/`，有传染性；目前以独立子进程调用，未与主程序链接 |
| `matting`（general） | MatAnyone | **NTU S-Lab License 1.0** | **仅非商用**，商用需另行联系作者取得授权 |
| `matting`（general 首帧） | BiRefNet_HR-matting | MIT | 宽松 |
| `product_cutout` | BiRefNet_HR-matting | MIT | 宽松 |

MatAnyone 这条是 2026-08-07 启用 general 模式时确认并接受的：使用场景按内部自用
处理。如果这个能力将来要对外提供或进入商业交付链路，需要先回头解决授权问题。

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
最终全局保护。默认值为 `TOOLBOX_PRODUCT_CUTOUT_CONCURRENCY=1`，上限 2。
Workbench 传入的 `productFolderKey` 是不可逆摘要，不含 UNC 路径。

这两个数由显存实测决定，不是拍脑袋定的：抠图在 2080 Ti 上单进程占约
14.8 GiB / 22 GiB，两个并发峰值 22.1 GiB（只剩 432 MiB），三个直接 CUDA 崩溃。
默认取 1 是因为第二个进程只换来约 20% 提速（单张 9.9s → 8.0s）——一个进程就
已经把 GPU 喂饱，多开只是排队——却要吃掉整张卡的余量，共用这张卡的其他能力
会被挤崩。Workbench 那边仍可提交更多，多出来的在网关排队，正好让显卡在两张图
之间不空转。

旧的默认值 12 只在抠图跑 CPU 版 torch 时才安全；换成 CUDA 版后必须下调，否则
一次批量出图会把显卡打爆，并且连累共用这张卡的其他能力。

## 部署（服务机）

```bat
cd D:\hyk_sort\workspace\workbench-prod
git pull
cd gateway
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt
restart.bat
```

日常改代码后只需要 `git pull` + `restart.bat`，不必重建 venv。`restart.bat` 用
WMI `Win32_Process.Create` 停旧进程、拉起新的 `launch-hidden.ps1`：这是因为服务机
上从未注册过 `video-toolbox-gateway` 这个计划任务，`schtasks /run` 会失败；用
`Start-Process` 也不行——SSH 会话一断，那样启动的子进程就跟着退出，只有 WMI 拉起
的进程能在 WMI 服务下存活。`start.bat` 仍保留，供手工前台调试用。

`matting` 的 general 模式另有一个独立 venv（`.venv-general`，MatAnyone 的依赖树
与 RVM 没有交集，分开装以免动到已上线的 human 模式），一次性安装：

```bat
D:\hyk_sort\apps\video-toolbox\matting\general-install.bat
```

它会建 `.venv-general`、装推理所需依赖（刻意 `--no-deps` 装 MatAnyone 本体，跳过
上游 pyproject 里 PySide6 / gradio / cchardet 那些只有演示 GUI 和训练才用的包），
经本机 Clash 代理（`127.0.0.1:7890`）下载 `matanyone.pth`——GitHub release 资产走的
`objects.githubusercontent.com` 在这台机器上被墙，仓库本身和 PyPI 则直连可用——
最后跑 `prewarm_backbones.py` 预热 MatAnyone 要的 torchvision resnet18/50 骨干。

**最后那步不是可选的优化**：`model_zoo.load_url` 默认不校验哈希，下载被截断也会把
文件重命名进缓存，之后每次加载都炸在 `UnpicklingError: unpickling stack underflow`，
而且因为已经"缓存命中"，重跑任务也不会自愈。这个坑实际踩过一次（resnet18 下到
41.4M/44.7M 断掉）。`prewarm_backbones.py` 统一用 `check_hash=True`，校验不过就删掉重下。

显存（2026-08-07 实测，736×960 / 150 帧）：general 模式的两段是**串行子进程**，先跑
首帧 BiRefNet（峰值约 15 GiB，与 `product_cutout` 同一个模型，见上面「商品白底图并发」
的实测），那个进程退出之后才启动 MatAnyone 传播段（峰值约 2.8 GiB）。所以本能力自身
的峰值是二者取大而不是相加，约 15 GiB，瓶颈完全在首帧那一下。

要注意的是它和 `product_cutout` 会互相挤：两个 15 GiB 的进程同时压在这张 22 GiB 的卡
上就会 OOM。真正长时间占卡的传播段只要 2.8 GiB，冲突窗口只有首帧那几秒。

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
