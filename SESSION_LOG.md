# SESSION LOG

## 2026-07-29 — 第4轮：可配置密码 + 登录页 UI

### 本轮做了什么
1. Web UI 设置密码功能：`POST /api/setup` + `GET /api/setup/status`
2. `lib/config.js` — 配置文件读写（`relay-data/config.json`），与 `OC_RELAY_PASSWORD` 环境变量共存
3. `lib/auth.js` 重构 — 优先从 config.json 读密码，导出 `deriveToken()` 供登录 API 复用
4. 登录页 UI — 无 token 时显示登录表单，输入密码 → `POST /api/login` → 获 token → 写入 `sessionStorage` → 自动进入聊天
5. `apiFetch()` 401 处理 — token 过期/密码变更时清除存储、跳回登录页
6. 设置页 UI — 首次配置时引导设密码，完成后提示重启
7. 流程闭环：首次访问 → 设置密码 → 重启 → 登录页 → 输密码 → 聊天

### 改动清单
| 文件 | 改动 | 原因 |
|------|------|------|
| lib/config.js | 新建 | 统一配置文件读写 |
| lib/auth.js | 导出 deriveToken + 支持 config.json 密码 | 登录 API 复用 + 配置化 |
| server.js | POST /api/login + POST /api/setup + GET /api/setup/status | 登录 + 密码设置 |
| public/index.html | 登录页 + 设置页 + 401 自动跳回登录 | 用户友好的登录流程 |

### 当前状态
- ✅ 固定 URL 访问 → 登录页 → 输密码 → 聊天
- ✅ 首次使用：设置密码 → 重启 → 登录
- ✅ 改密码后 token 过期 → 自动跳回登录
- ✅ 向后兼容 `?token=` URL 参数
- 📌 半截功能见 UNIMPLEMENTED.md

---

## 2026-07-28 — 第3轮：接管修复 + opencode serve 崩溃排查

### 本轮做了什么
1. 全面审查项目状态（git、进程、日志、文档体系）
2. 发现 3 个紧急问题：
   - `public/index.html` 编码损坏（UTF-8 被错误重编码，所有中文变乱码）
   - `relay.db` 损坏（`database disk image is malformed`）
   - 12 个残留 `opencode.exe` 进程 + 多个 relay node 进程
3. 清理残留进程 + 删除损坏的 relay-data
4. 用户手动恢复 index.html 编码（git checkout HEAD）
5. 启动 relay 后 opencode serve 闪退（exit code 4294967295 = `0xFFFFFFFB`）
6. 前端表现：relay 能启动 → opencode serve 崩溃 → 前端显示 "opencode unavailable"
7. 未完成：opencode serve 崩溃根因排查（需独立测试 `opencode serve --port 4098`）
8. **结论：项目处于"能启动但 opencode serve 不稳定"状态**

### 当前阻塞
- ⛔ opencode serve 启动后闪退，exit code 4294967295（疑似 access denied 或被外部进程 taskkill）
- ⛔ relay 无自动重启机制（opencode serve 崩了 relay 继续运行但 API 不可用）

### 发现记录
| 发现 | 详情 |
|------|------|
| index.html 编码损坏 | 工作副本 UTF-8 被错误重编码，git diff 115 行全是编码乱码，无实质改动 |
| relay.db malformed | 上次运行数据库已损坏，opencode.log 报 malformed |
| opencode serve exit 4294967295 | 启动后闪退，需 standalone 测试确认是 opencode serve 本身问题还是 relay 环境问题 |

### 改动清单
（本轮无代码改动 — 纯诊断 + 测试）

### 当前状态
- ✅ index.html 编码已恢复
- ✅ 残留进程已清理
- ✅ relay-data 已删除重建
- ✅ opencode serve 消息发送功能正常（E2E 测试通过）
- ✅ relay 全链路：health → session create → message send → LLM response
- ⚠️ 前端测试结果：待手机实测
- 📌 半截功能见 UNIMPLEMENTED.md

### 排查要点（供下轮参考）
- `opencode serve` 的 `POST /session/{id}/message` 在 PowerShell 测试时必须用 `--data-binary "@file"` 传 body，不能用 `-d '...'`（PowerShell 引号嵌套问题导致 JSON 被破坏）
- 前端 SPA 用 `JSON.stringify()` 无此问题，手机端可以直接测试
- standalone serve v1.18.7 的 API 格式与 relay 的 v1.18.5 不同（session 需要空 body `{}`，不是 `{"cwd":"..."}`）
- `OPENCODE_CLIENT=desktop` 环境变量不影响 serve 模式

---

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
