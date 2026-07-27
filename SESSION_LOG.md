# SESSION LOG

## 2026-07-27 — 第1轮：初始构建 + 修复

### 本轮做了什么
1. Phase 0：验证 opencode serve API 端点（health, session, message SSE, question）
2. Phase 1：构建代理后端（server.js + lib/*.js，共 6 模块）
3. Phase 2：构建前端 SPA（public/index.html，~2000 行）
4. Phase 3：端到端测试 → 发现并修复 3 个关键 bug
5. 建立 GitHub 私人仓库：diexie10/opencode-relay
6. 建立项目文档规范体系

### 关键发现
- opencode serve v1.18.7 API 设计：POST /session/{id}/message 返回 SSE 流，GET 返回消息列表
- Basic Auth 用户名必须是 `opencode`（不是空用户名）
- SSE 流必须 pipe，不能用 `response.text()` 缓冲
- Desktop DB 2.8GB，copyFileSync 复制 ~4s

### 改动清单
| 文件 | 改动 | 原因 |
|------|------|------|
| server.js | 新建 v2 | 完整重写，DB 复制 + serve 管理 + 路由 |
| lib/auth.js | 新建 | Token 认证 + Basic Auth 注入 |
| lib/proxy.js | 新建 → 修复 | 初始用 response.text() → 改为 pipe |
| lib/sse-tunnel.js | 新建 | SSE 隧道 + keepalive |
| lib/static.js | 新建 | 静态文件服务 + 路径防护 |
| lib/opener.js | 新建 | DB 生命周期 + 进程管理 |
| lib/api-config.js | 新建 | API 端点单一来源 |
| public/index.html | 新建 → 修复 | 初始 SSE 连接方式错误 → 改为从 POST 响应读 SSE |
| 方案.md | 保留 | v1 时期写的架构文档，更新了 DB 副本策略 |
| CLAUDE.md | 新建 | 项目规则 |
| UNIMPLEMENTED.md | 新建 | 半截功能清单 |
| SESSION_LOG.md | 新建 | 本文件 |

### Bug 修复记录
1. **Basic Auth 用户名错误**：auth.js/opener.js 用 `:` + password，改为 `opencode:` + password
2. **SSE 连接地址错误**：前端连 GET /sse/session/{id}/message（返回 JSON），改为从 POST 响应读 SSE
3. **proxy response.text() 缓冲**：阻塞 SSE 流式传输，改为 pipe

### 当前状态
- 已完成：核心架构、所有模块、基本 UI、GitHub 推送
- 待办/阻塞：手机端实测待用户验证
- 风险项：Desktop DB 2.8GB 影响启动速度
