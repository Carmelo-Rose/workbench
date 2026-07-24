# Workbench 最小多租户底座

## 边界与不变量

- 服务端只从 HttpOnly 会话 cookie 解析真实员工身份；浏览器提供的
  `userId`、`workspaceId` 或同名请求头不参与授权。
- 会话中的 workspace 必须同时存在组织成员关系和工作区成员关系。
- 所有业务 DAL 查询都包含 workspace 条件。会话历史进一步按员工私有；
  workspace 可见主体素材仍保留原有 `visibility` 语义。
- 异步任务持久化创建时的 `userId + workspaceId` 快照，后台执行只使用该快照，
  不从全局变量或请求参数重新推导租户。
- toolbox 的 token 只证明调用方是 Workbench 服务；文件和任务访问还必须匹配
  Workbench 注入的 workspace 身份。

## 持久化审计

| 存储 | 租户归属 | 隔离方式 |
| --- | --- | --- |
| `organizations` | 全局身份目录 | 组织主键 |
| `users` | 全局真实员工 | 邮箱唯一，密码仅保存 scrypt hash |
| `organization_members` | organization + user | 复合主键与组织角色 |
| `workspaces` | organization | `organization_id` |
| `workspace_members` | workspace + user | 复合主键与工作区角色 |
| `workbench_sessions` | user + active workspace | 随机 token 只保存 SHA-256 hash |
| `threads` | workspace + owner user | `(workspace_id, remote_id)` 复合主键 |
| `messages` | workspace + thread | 复合外键级联到 `threads` |
| `mono_assets` | workspace + creator | 所有读取按 workspace |
| `mono_subjects` | workspace + owner | 私有/工作区可见性保持不变 |
| `mono_jobs` | workspace + creator | 查询、收藏、取消、清理按 workspace |
| `mono_job_events` | job | 通过 job 外键继承 workspace |
| `collector_items` | workspace + importer | 导入、批次和搜索按 workspace |
| `api_config` | workspace | `(workspace_id, key)` 复合主键 |
| gateway `files` | workspace + uploader | 文件引用解析前校验 workspace |
| gateway `jobs` | workspace + submitter | 状态、取消、日志、产物和串联引用均校验 |

`services/luopan-api` 是外部采集库的只读 sidecar，不写 Workbench 数据库；进入
Workbench 的采集导入数据由 `collector_items.workspace_id` 隔离。

## 身份、角色与请求上下文

工作区角色权限如下：

| 角色 | 读取 | 写业务数据 | 管理配置/工作区/员工 |
| --- | --- | --- | --- |
| owner | 是 | 是 | 是 |
| admin | 是 | 是 | 是 |
| member | 是 | 是 | 否 |
| viewer | 是 | 否 | 否 |

`currentWorkspaceActor()` 完成 cookie、会话有效期、员工状态、组织成员和工作区成员
的联合校验。业务入口通过 `workspaceActorFromWorkbenchRequest()` 应用读写权限。
需要隐式读取 workspace 配置的调用链使用 `runWithTenantContext()`；上下文基于
Node `AsyncLocalStorage`，不会在并发请求间共享。

外部 `/api/mono/*` 继续使用服务端共享凭证，但该凭证只映射到服务器配置的固定
服务员工和固定工作区，不信任调用者身份头。

## API 面

- `/api/auth/session`：查询会话、登录、退出。
- `/api/auth/switch-workspace`：验证成员关系后签发新 workspace 会话。
- `/api/workspaces`、`/api/workspaces/current/members`：工作区与员工管理。
- `/api/tenant/organizations`：组织目录与最小组织创建。
- `/api/threads/*`：员工私有、workspace 有界的会话与消息。
- `/api/workbench/*`、`/api/toolbox/*`、`/api/chat`、`/api/config`：统一解析
  当前 workspace；viewer 的写请求返回 403。

## 迁移与兼容

数据库初始化为幂等迁移：

1. 创建稳定的 `org_default / default / local-user` 兼容身份。
2. 旧 `threads` 回填 workspace 与 owner，并重建为复合主键。
3. 旧 `messages` 通过 thread 回填 workspace，并建立复合外键。
4. 旧全局 `api_config` 归入默认 workspace。
5. 保留 Mono、素材、任务和采集表中已有的 workspace 值。

生产 bootstrap owner 首次接管默认 workspace 时，旧 `local-user` 的会话、素材、
主体、任务和采集记录会幂等转交给该真实员工，避免启用登录后历史数据“消失”。

非生产环境只有显式设置 `MONO_LOCAL_DEVELOPMENT=true` 才会沿用免登录的
`local-user/default` 体验。生产环境没有有效会话时一律返回 401；首次 owner
通过 `WORKBENCH_BOOTSTRAP_*` 幂等引导。原 localStorage 会话导入协议保持不变，
但数据只会导入发起请求的当前员工和 workspace。

本次底座不改变工具选择、提示词、Agent 循环或具体业务能力行为。
