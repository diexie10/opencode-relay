# SESSION LOG

## 2026-07-28 — 第2轮：接管 + WAL 修复 + JSON 响应处理

### 本轮做了什么
1. 全面审查项目状态（代码、文档、git diff）
2. 加载 project-docs-norm skill 审计文档体系，加载 systematic-debugging skill 定位阻塞
3. 根因调查（Phase 1）：排查 opencode serve 500 错误
   - 确认 `opencode.jsonc` 配置完整、API key 环境变量全部就位
   - 定位到 `copyFileSync` 漏复制 WAL 文件 → `PRAGMA wal_checkpoint(PASSIVE)` 失败 → serve exit code 1
4. 修复 `opener.js`：`cleanupOldDB()` / `copyDesktopDB()` / `removeRelayDB()` 同步处理 `-wal` / `-shm` 文件
5. 定位前端"等待回复"问题：opencode serve 返回 `application/json`，前端只解析 SSE 流
6. 修复 `index.html` `sendMessage()`：新增 Content-Type 检测，JSON 响应直接解析 `parts` 提取内容
7. 修复手机 404 错误（session 过期）：`sendMessage()` 遇到 404 自动重建 session 重试
8. **手机端端到端验证通过** — 手机扫码 → 加载界面 → 发送消息 → 收到 LLM 回复 ✅

### 改动清单
| 文件 | 改动 | 原因 |
|------|------|------|
| lib/opener.js | cleanupOldDB/copyDesktopDB/removeRelayDB 三函数 | WAL 文件缺失导致 opencode serve 崩溃 exit code 1 |
| public/index.html | sendMessage() 新增 JSON 响应处理 + 404 自动重试 | 前端忽略 JSON 响应 + 旧 session 404 |
| docs/KNOWN_TRAPS.md | 新增"把 JSON 当 SSE 解析"陷阱 | 记录新发现 |

### Bug 修复记录
4. **DB 副本缺少 WAL 文件**：opencode serve 启动即 exit code 1，`PRAGMA wal_checkpoint(PASSIVE)` 失败。修复：`copyDesktopDB()` 同时复制 `-wal` 文件
5. **前端忽略 JSON 响应**：opencode serve 返回 `Content-Type: application/json`，但前端只处理 SSE 流。修复：`sendMessage()` 新增 JSON 分支
6. **手机 404 发送失败（过期 session）**：localStorage 存了旧的 session ID，对当前 opencode serve 不可见。修复：404 时自动重建 session 重试

### 当前状态
- ✅ **手机端端到端可用** — 扫码 → 发消息 → 收回复
- ✅ 后端 API 链路：relay → opencode serve → LLM
- ✅ 前端：会话管理、JSON/SSE 双格式、过期 session 自动重建
- 📌 半截功能见 UNIMPLEMENTED.md

---

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
4. **DB 副本缺少 WAL 文件**：opencode serve 启动即 exit code 1，`PRAGMA wal_checkpoint(PASSIVE)` 失败。修复：`copyDesktopDB()` 同时复制 `-wal` 文件
5. **前端忽略 JSON 响应**：opencode serve 返回 `Content-Type: application/json`，但前端只处理 SSE 流。修复：`sendMessage()` 新增 JSON 分支

### 当前状态
- ✅ 已完成：后端 API 链路全部就绪、前端界面完整
- ✅ 关键阻塞已排除：WAL 复制 + JSON 响应处理
- ⏳ 待手机实测验证
- 📌 半截功能见 UNIMPLEMENTED.md
