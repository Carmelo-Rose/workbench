# Mono Web 直连对话 → 企业实用化差距分析

> 基于对 `mono-web/` 当前代码的逐文件审阅，对照真正落到生产的企业级对话产品（ChatGPT Enterprise / Dify / FastGPT / 阿里云百炼 / 腾讯混元接入）给出能力差距。

## 一、当前已具备的能力

| 能力 | 实现位置 | 成熟度 |
|------|----------|--------|
| 流式对话 (SSE) | `api/chat/route.ts` → `streamText` | 可用 |
| 双后端切换 (direct / hermes) | `lib/backends.ts` + `api/chat/route.ts` | 可用 |
| 会话线程管理 (列表/新建/切换) | `assistant.tsx` + `thread-history.tsx` | 可用，但仅 localStorage |
| 工具调用 (image_to_prompt) | `lib/tools/image-to-prompt.ts` | 单工具，链路通 |
| 后端健康探测 | `api/agent/status/route.ts` + 30s 轮询 | 可用 |
| 主题/样式/伴宠 | `components/mono/*` | 完整 |
| 设置面板 | `settings-dialog.tsx` | 完整 |

**一句话定位**：当前是一个**单用户、本地存储、无鉴权、无持久化、无可观测性**的对话前端原型。核心对话链路通了，但离"企业实用"还差一整层基础设施。

---

## 二、企业实用化必须补齐的能力（按优先级分层）

### P0 — 不做就不能上线

#### 1. 身份认证与访问控制
**现状**：`/api/chat` 无任何鉴权，任何人知道 URL 即可调用，直接消耗你的 DeepSeek/Hermes 额度。

**差距**：
- 无登录体系（SSO / OAuth / 企业账号）
- 无 session/JWT 机制
- 无 `middleware.ts` 保护 API 路由
- API Key 裸放在 `.env.local`，无 per-user 密钥管理

**参考落地**：
```
middleware.ts → 校验 session cookie，未登录拦截 /api/chat
auth/[provider]/route.ts → 接入企业 SSO (OIDC/SAML) 或自建账号
lib/session.ts → iron-session / next-auth 管理 JWT
```

#### 2. 服务端会话持久化
**现状**：所有对话历史只存在浏览器 `localStorage`（`mono:threads` / `mono:messages:*`）。换浏览器/清缓存即丢，无法跨设备，无法审计。

**差距**：
- 无数据库层（Postgres / Supabase / Turso）
- 消息不在服务端落库
- 线程元数据（标题、创建时间、所属用户）无服务端记录
- `thread-history.tsx` 的 `LocalStorageThreadHistoryAdapter` 需要替换为 `ExternalStoreAdapter` 对接后端 API

**参考落地**：
```
db/schema.ts → threads(id, user_id, title, created_at, backend, metadata)
db/schema.ts → messages(id, thread_id, role, content, parent_id, created_at, tokens, model)
api/threads/route.ts → CRUD 线程
api/threads/[id]/messages/route.ts → 消息读写
```

#### 3. 速率限制与用量管控
**现状**：零限流。一个用户可以无限调用，直接打爆 API 额度。

**差距**：
- 无 rate limiting（per-user / per-IP / global）
- 无 token 用量计量
- 无配额上限与超额熔断
- `message-timing.tsx` 前端展示了 tok/s，但服务端没有记录和累加

**参考落地**：
```
lib/rate-limit.ts → sliding window / token bucket (Redis 或内存)
api/chat/route.ts → 每请求校验 quota，超额返回 429
lib/usage.ts → 记录 token 消耗到 DB，按用户/团队聚合
```

#### 4. 多租户与权限模型 (RBAC)
**现状**：无租户概念，无角色区分。所有用户共享同一后端配置。

**差距**：
- 无 organization / team / user 三层模型
- 无角色（admin / member / viewer）
- 无权限粒度（谁能用 hermes、谁能调 vision 模型、谁能看清空操作）
- `useBackendChoice` 当前是纯前端 localStorage，任何人可切到任意后端

**参考落地**：
```
db/schema.ts → organizations, teams, memberships, roles
lib/abac.ts → 基于属性的访问控制（backend 选择、模型选择、工具调用均校验权限）
api/chat/route.ts → 按用户权限决定可用 model / backend / tools 白名单
```

---

### P1 — 不做就只是玩具

#### 5. 可观测性（日志 / 指标 / 追踪）
**现状**：零日志。`onError` 只返回一句文案，无结构化错误上报，无调用链追踪。

**差距**：
- 无请求级日志（谁、何时、用了哪个模型、耗时、token 数、成功/失败）
- 无指标采集（QPS、首字延迟 P50/P99、错误率、模型分布）
- 无分布式追踪（前端 → Next.js → DeepSeek / Hermes 全链路）
- 无告警（后端连续失败、额度快耗尽时无人知道）

**参考落地**：
```
lib/telemetry.ts → OpenTelemetry SDK，auto-instrument Next.js + fetch
lib/logger.ts → pino 结构化日志，每请求带 traceId / userId / threadId
lib/metrics.ts → Prometheus / Vercel Analytics 自定义指标
```

#### 6. 错误处理与韧性
**现状**：`route.ts` 的 `onError` 只返回字符串。上游超时/限流/宕机时用户只看到一句模糊提示。

**差距**：
- 无上游模型故障自动降级（DeepSeek 挂了 → 自动切 Hermes 或其他模型）
- 无重试机制（瞬时 529 / 429）
- 无超时分级（首字超时 vs 总超时）
- 无死信队列（失败的请求可回溯重放）
- `maxDuration = 60` 是写死的，无按模型/后端动态调整

**参考落地**：
```
lib/resilience.ts → 重试策略（指数退避 + jitter），仅对幂等请求
lib/fallback.ts → 模型降级链：deepseek → qwen → hermes
api/chat/route.ts → 超时分级，首字 15s / 总 120s
```

#### 7. 文件上传与多模态
**现状**：`image_to_prompt` 工具只接受 URL/data-URI，用户无法直接上传图片。composer 未接入文件附件。

**差距**：
- 无文件上传 API（图片、PDF、文档）
- 无对象存储（S3 / OSS / R2）
- 无文件类型/大小校验、病毒扫描
- 无多模态消息（音频、视频帧）
- assistant-ui 的 `AttachmentAdapter` 未启用

**参考落地**：
```
api/upload/route.ts → 签名上传直传 S3/R2
lib/storage.ts → presigned URL 生成 + 过期清理
components → 启用 assistant-ui AttachmentAdapter，composer 支持拖拽
lib/tools/ → 扩展 PDF 解析、文档摘要等工具
```

#### 8. 知识库与 RAG
**现状**：零。模型只用自身训练知识 + 当前会话上下文。

**差距**：
- 无文档导入 → 向量化 → 检索的管道
- 无 embedding 模型接入
- 无向量库（pgvector / Qdrant / DashVector）
- 无混合检索（关键词 + 语义）
- 无引用溯源（回答里标注来源文档段落）

**参考落地**：
```
db/schema.ts → documents, chunks, embeddings
api/knowledge/route.ts → 文档上传 + 分块 + embedding
lib/retrieval.ts → 检索 top-k，注入 system prompt
components → 消息内渲染引用角标 [1] [2]，点击跳转原文
```

---

### P2 — 做了才能叫"企业级"

#### 9. 管理后台
**现状**：无。所有配置靠 `.env` 和前端设置面板。

**差距**：
- 无用户管理（邀请、禁用、角色变更）
- 无模型/后端配置管理（当前写死在 env，无法运行时调整）
- 无用量看板（团队/个人的 token 消耗趋势）
- 无会话审计（管理员查看任意用户对话，合规要求）
- 无系统公告 / 维护模式开关

#### 10. 审计与合规
**现状**：无审计日志。谁调了什么模型、问了什么、得到什么回答——全无记录。

**差距**：
- 无审计事件流（登录、模型切换、工具调用、数据导出、删除操作）
- 无数据留存策略（对话保留多久、到期自动清理）
- 无 PII 检测与脱敏（用户输入里的身份证/手机号应在落库前脱敏）
- 无 GDPR/个保法要求的导出/删除接口
- 无水印（截图泄露追溯）

#### 11. 计费与配额
**现状**：无。API Key 额度是全局共享的。

**差距**：
- 无计费模型（按 token / 按次 / 包月）
- 无充值/扣费
- 无团队配额分配与预警
- 无账单导出
- 无多模型差异化定价（GPT-5.4 vs DeepSeek 成本差 10x）

#### 12. 协作能力
**现状**：纯单用户。`Share` 按钮是 `disabled` 状态。

**差距**：
- 无会话分享（只读链接 / 团队内协作）
- 无评论/批注
- 无 Prompt 模板库（团队共享）
- 无角色分工（运营用 image_to_prompt，技术用 hermes）

#### 13. 流式体验健壮性
**现状**：`streamText` → `toUIMessageStreamResponse` 基本可用，但边界场景未处理。

**差距**：
- 无断线重连 / 断点续传（`with-resumable-stream` 模式未启用）
- 无流式中断恢复（网络抖动后从断点继续）
- 无流式心跳保活（长时间工具执行时连接不被代理掐断）
- 长会话无上下文窗口管理（超过模型 context window 时无自动摘要/截断）
- 无流式取消的服务端清理（用户点停止后后端仍可能在跑）

---

## 三、架构演进路线图

```
当前                          P0 完成后                    P1+P2 完成后
─────────────────────────────────────────────────────────────────────
Browser                       Browser                      Browser
  │ localStorage                │ Session Cookie               │ Session Cookie
  │                             │                              │
  ▼                             ▼                              ▼
Next.js API                    Next.js API (+middleware)     Next.js API (+middleware)
  │ streamText                  │ streamText                   │ streamText
  │                             │ + auth                       │ + auth + RBAC
  │                             │ + rate limit                 │ + rate limit + quota
  │                             │ + DB persistence             │ + RAG retrieval
  ▼                             ▼                              │ + audit log
DeepSeek / Hermes              DeepSeek / Hermes             ▼
                                + Postgres                   Postgres + Vector + S3
                                + Redis (限流)                + OTel → Grafana
                                                             DeepSeek / Hermes / 多模型降级
```

---

## 四、优先级排序建议

| 优先级 | 能力 | 工作量估算 | 阻塞性 |
|--------|------|-----------|--------|
| **P0** | 身份认证 | 2-3 天 | 不做不能上线 |
| **P0** | 服务端持久化 (DB) | 3-5 天 | 不做数据会丢 |
| **P0** | 速率限制 | 1-2 天 | 不做会被刷爆 |
| **P0** | 多租户 RBAC | 3-4 天 | 不做无法区分用户 |
| **P1** | 可观测性 | 2-3 天 | 不做出问题查不到 |
| **P1** | 错误韧性/降级 | 2 天 | 不做体验差 |
| **P1** | 文件上传 | 2-3 天 | 不做多模态用不了 |
| **P1** | 知识库 RAG | 5-7 天 | 企业对话核心需求 |
| **P2** | 管理后台 | 5-7 天 | 运营必需 |
| **P2** | 审计合规 | 3-4 天 | 大客户必需 |
| **P2** | 计费配额 | 3-5 天 | 商业化必需 |
| **P2** | 协作能力 | 3-5 天 | 团队场景必需 |
| **P2** | 流式健壮性 | 2-3 天 | 体验打磨 |

**最小可上线版本（MVP for Enterprise）= P0 全部 + P1 的可观测性 + 错误韧性 ≈ 2 周。**

---

## 五、代码层面需要改动的关键文件

```
mono-web/
├── src/
│   ├── app/
│   │   ├── api/
│   │   │   ├── chat/route.ts        ← 加 auth 校验 + rate limit + 降级链 + token 计量
│   │   │   ├── threads/             ← 新增：线程 CRUD
│   │   │   ├── upload/              ← 新增：文件上传
│   │   │   └── knowledge/           ← 新增：知识库管理
│   │   └── assistant.tsx            ← threadListAdapter 从 localStorage 换成 fetch 后端
│   ├── lib/
│   │   ├── thread-history.tsx       ← LocalStorageThreadHistoryAdapter → ExternalStoreAdapter
│   │   ├── auth.ts                  ← 新增：session/JWT
│   │   ├── rate-limit.ts            ← 新增：限流
│   │   ├── usage.ts                 ← 新增：token 计量
│   │   ├── rbac.ts                  ← 新增：权限校验
│   │   ├── telemetry.ts             ← 新增：OTel + 日志
│   │   ├── resilience.ts            ← 新增：重试 + 降级
│   │   └── retrieval.ts             ← 新增：RAG 检索
│   ├── middleware.ts                ← 新增：路由级鉴权
│   └── db/
│       └── schema.ts                ← 新增：数据库 schema
├── .env.local                       ← 拆分 per-user 配置到 DB
└── package.json                     ← 加 drizzle-orm / next-auth / @opentelemetry/api
```

---

## 六、总结

当前 mono-web 的直连对话**链路是通的**——流式、双后端、工具调用、线程管理都跑起来了。但它是一个**面向单用户的本地原型**，缺少企业落地需要的整层"中间件"：

1. **安全层**：认证、授权、限流、审计——完全空白
2. **持久层**：数据库、向量库、对象存储——完全空白
3. **运维层**：日志、指标、追踪、告警——完全空白
4. **业务层**：知识库、计费、管理后台——完全空白
5. **韧性层**：降级、重试、断线恢复——完全空白

**建议路径**：先做 P0（认证 + DB + 限流 + RBAC），约 2 周，拿到一个"多人可用、数据不丢、不被刷爆"的版本；再按业务需要逐步补 P1/P2。
