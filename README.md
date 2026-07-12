# Workbench

面向创作者/运营的 AI 创作工作台：以 assistant-ui 为交互基座的 chat-first 工作面，
支持图片提示词逆向、视频分析、素材处理等工具流。企业级平台的主产品，
Mono Chrome 扩展等其他工具接入这里。

## 架构

```
Browser ──► Next.js (App Router, Turbopack)
              ├─ /api/chat             流式对话（AI SDK streamText）
              ├─ /api/threads/*        会话持久化（SQLite）
              └─ /api/agent/status     双后端健康探测
                        │
          ┌─────────────┴─────────────┐
      direct 模式                  hermes 模式
   OpenAI 兼容模型直连          Hermes Agent 网关
   + 本地工具（image_to_prompt）  （网关内完整 Agent 循环：
                                    工具/记忆/技能）
```

### 双后端模式

| 模式 | 链路 | 说明 |
|------|------|------|
| `direct` | Next.js → OpenAI 兼容 API | 模型直连 + 本地工具调用，system prompt 本地注入 |
| `hermes` | Next.js → Hermes 网关 | 网关内完整 Agent 循环，`X-Hermes-Session-Id` 保持会话连续性 |

服务端默认模式由 `WORKBENCH_AGENT_BACKEND` 决定，前端可随时按请求切换。

### 会话持久化

会话与消息存服务端 SQLite（Node 内置 `node:sqlite`，零原生依赖）：

- DB 文件：`data/workbench.db`（可用 `WORKBENCH_DB_PATH` 覆盖），已 gitignore
- 旧版 localStorage（`wb:threads` / `wb:messages:*`）首次加载自动静默迁移，
  本地数据保留作冻结备份
- 设置 → 数据：查看计数、导出 JSON 备份、清空全部会话
- 备份：直接拷贝 `data/` 目录，或设置页导出 JSON

## 快速开始

```bash
cp .env.example .env.local   # 填入你的 API Key
npm install
npm run dev                  # http://localhost:3000
```

### 环境变量

见 [.env.example](.env.example)。必填 `CHAT_API_KEY`；
Hermes / 视觉模型按需配置。

### Mono Creative Service

Mono 的图片反推、视频分析和 Image2 生成现在由 Workbench 的服务端 API 承载：

- `GET /mono/image2` 兼容旧入口并跳转到聊天内 Image2 创建图片模式
- `POST /api/mono/assets` 登记 URL 或 data URL 素材
- `POST /api/mono/analyze/image` 同步图片反推
- `POST /api/mono/analyze/video`、`POST /api/mono/generate/image` 创建异步任务
- `GET` / `DELETE /api/mono/jobs/:id` 查询或取消任务
- `GET` / `POST /api/mono/subjects` 管理可复用主体，单条路由支持读取、修改和删除

Image2 作为聊天 composer 模式运行，支持插件迁移来的 6 个模板、最多 6 张参考图，
以及一次生成 1、2、4、6 张图片。工作区主体库支持默认私有、按需共享、普通模板
内联 `@主体` 和结构化模板槽位选择；主体引用由服务端编译并在任务提交时冻结快照。
聊天、direct Agent 工具和 MCP adapter 共用同一批次任务契约。

外部平台 API 默认拒绝访问，必须设置 `MONO_PLATFORM_API_KEY`。本地开发时由
`MONO_LOCAL_DEVELOPMENT=true` 显式启用 Workbench 单用户身份桥；生产环境不会
接受该开关。供应商凭据仅保存在服务端环境变量中。运行独立 Streamable HTTP MCP adapter：

```bash
MONO_MCP_API_KEY=client-token \
MONO_PLATFORM_API_KEY=platform-token \
npm run mono:mcp
```

MCP 默认监听 `http://127.0.0.1:8787/mcp`，并转发至 Workbench 的
`http://127.0.0.1:3000`。Hermes 只有确认支持远程 Streamable HTTP MCP 后才应配置该地址。

## 常用命令

```bash
npm run dev     # 开发（Turbopack）
npm run build   # 生产构建
npm run start   # 生产启动
npm run lint    # ESLint
npm test        # Image2 契约与 API 集成测试
```

## 目录速览

```
src/
├── app/
│   ├── api/chat/            对话入口（direct / hermes 分流）
│   ├── api/threads/         会话 CRUD + 消息 + 导入导出
│   ├── api/agent/status/    后端健康探测
│   └── assistant.tsx        运行时装配（RemoteThreadList + AI SDK）
├── components/
│   ├── assistant-ui/        assistant-ui 定制组件
│   ├── workbench/           工作台组件（设置、后端切换、风格、伴宠）
│   └── ui/                  shadcn 基础组件
└── lib/
    ├── server/              SQLite 持久层（db.ts / thread-store.ts）
    ├── server-threads.ts    RemoteThreadListAdapter（客户端，含迁移）
    ├── thread-history.tsx   消息历史 adapter（withFormat / ai-sdk/v6）
    ├── backends.ts          双后端定义
    └── models.ts            模型工厂 + Hermes SSE 转译
```

## 注意

本项目使用的 Next.js 版本与常见文档可能存在差异，改动前先读
`node_modules/next/dist/docs/` 里的对应指南（见 AGENTS.md）。
