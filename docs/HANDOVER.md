# OpenCode Relay — 交接手册

> 编写时间：2026-07-28
> 交接人：Claude（第1轮）/ 接管后修复（第2轮）
> 状态：**Phase 0–3 完成，手机端已验证通过 ✅**
> 归档说明：本手册写于 2026-07-28。第 3 节的 DB 复制方案与排查过程是当时状态 —— v2 已改为**独立持久 DB**（`OPENCODE_DB=relay-data/relay.db`），后续进展以 `docs/SESSION_LOG.md` 为准。

---

## 一、项目概览

### 目标
手机通过 HTTP API 远程使用 OpenCode，取代 v1 的 node-pty/WebSocket/xterm.js 方案。

### 架构

```
手机浏览器                           Windows Desktop
┌──────────────────┐     HTTP     ┌─────────────────────────────────┐
│  index.html      │─────────────▶│  relay (server.js, port 3456)   │
│  (SPA 聊天界面)   │◀────────────│  ├─ auth.js (Basic Auth 注入)   │
└──────────────────┘              │  ├─ proxy.js (REST pipe 代理)   │
                                  │  ├─ static.js (静态文件)        │
                                  │  ├─ opener.js (serve 进程管理)  │
                                  │  │                              │
                                  │  ├─ opencode serve (port 4097)  │
                                  │  │  env: relay-data/relay.db    │
                                  │  │  (Desktop DB 的副本)         │
                                  │  └─ relay-data/logs/            │
                                  └─────────────────────────────────┘
```

### 文件结构

```
opencode-relay/
├── server.js              # 主入口 — 启动时序 + HTTP 路由 + 优雅关闭
├── relay-start.js         # 一键启动（清理进程 + 健康检查）
├── lib/
│   ├── api-config.js      # API 端点路径（单一真源）
│   ├── auth.js            # Token 生成/校验 + Basic Auth 凭据源
│   ├── config.js          # 配置读写（relay-data/config.json）
│   ├── models.js          # 模型/代理列表
│   ├── proxy.js           # REST 代理 — 流式 pipe，不缓冲
│   ├── sse-tunnel.js      # SSE 隧道（未使用，见下文）
│   ├── static.js          # 静态文件服务 + 路径防护
│   ├── status.js          # 运行状态
│   └── opener.js          # opencode serve 生命周期 + 独立 DB 管理
├── public/
│   ├── index.html         # Preact SPA（SoftGlass 设计系统）
│   └── vendor/            # marked.min.js + purify.min.js (CDN 下线方案)
├── relay-data/            # 运行时数据（可删除，自动重建）
│   ├── relay.db           # 独立持久数据库（不碰桌面版）
│   ├── projects/          # 导入的项目
│   ├── backups/           # 回并备份
│   └── logs/              # 日志 + token.txt + opencode.log
├── docs/                  # 全部文档
│   ├── 方案.md            # 完整架构方案（1887 行）
│   ├── architecture/      # 架构摘要
│   ├── API-INTERFACES.md  # 接口契约
│   ├── SESSION_LOG.md     # 会话日志
│   ├── HANDOVER.md        # 本手册
│   ├── HANDOVER-round5.md # 第 5 轮交接
│   ├── KNOWN_TRAPS.md     # 已知陷阱日志
│   ├── 诚实声明与技术债务.md
│   ├── UNIMPLEMENTED.md   # 半截功能清单
│   ├── 移动端界面方案.md
│   ├── opencode-relay-prompt.md
│   └── CHANGELOG.html
├── CLAUDE.md              # 项目规则
└── package.json           # 依赖：qrcode-terminal
```

---

## 二、当前状态

### ✅ 已完成

| 阶段 | 内容 |
|------|------|
| Phase 0 | opencode serve API 契约验证（health, session, message, question） |
| Phase 1 | 代理后端 6 模块全部完成 |
| Phase 2 | 前端 SPA 完成（chat UI, SSE 流解析, 问题弹窗, 工具调用展示） |
| Phase 3 | 端到端测试+修复（Basic Auth 格式, SSE 连接方式, proxy pipe） |
| 安全审计 | CDN 脚本 → vendored, referrer 头, 文件名清理 |
| GitHub | 私人仓库 `diexie10/opencode-relay` |

### ✅ 已修复（第2轮）

**阻塞项：opencode serve 崩溃 + 前端"等待回复" — 已全部解决**

共修复 3 个 bug：

| # | Bug | 根因 | 修复 |
|---|-----|------|------|
| 1 | opencode serve exit code 1 | `copyDesktopDB()` 只复制主 DB，漏了 `-wal` → `PRAGMA wal_checkpoint(PASSIVE)` 失败 | `opener.js` 三函数同步处理 WAL/SHM |
| 2 | 前端卡"等待回复" | opencode serve 返回 `application/json`，前端只解析 SSE 流 | `sendMessage()` 检测 Content-Type，JSON 直接解析 `parts` |
| 3 | 手机发消息 404 | localStorage 存了旧 session ID | 404 时自动重建 session 重试 |

详见 `SESSION_LOG.md` 第2轮记录。

### 🔴 已知阻塞（第3轮）

| 问题 | 现象 | 状态 |
|------|------|------|
| opencode serve 消息 API 500 | `POST /session/{id}/message` 返回 `UnknownError` | **已解决** — 原因是 PowerShell 测试时 `-d '{json}'` 引号嵌套导致 body 损坏，前端 `JSON.stringify()` 无此问题 |
| index.html 编码损坏 | 工作副本 UTF-8 被错误重编码，中文变乱码 | **已修复**（git checkout HEAD） |
| relay.db malformed | 上次运行遗留的损坏数据库 | **已清理**（删除 relay-data 重建） |

> **第3轮（2026-07-29）核心结论**：
> 1. opencode serve v1.18.5 消息发送功能正常 ❌→✅（Powershell curl 引号陷阱，前端无影响）
> 2. relay 全链路 E2E 验证通过：health → session → message → LLM response
> 3. E2E 测试通过后 relay 代码无变动，保持原始状态

### ⚠️ 已有但未实测

| 功能 | 说明 |
|------|------|
| 问题弹窗 | SSE event `question` 通过 polling `/api/question` 拉取，UI 已做但未在手机实测 |
| 工具调用展示 | 折叠/展开交互已实现，未在手机实测 |
| 多 Session 切换 | 本地存储 + 切换 UI 已实现，未实测 |
| 安全区域 | CSS `env(safe-area-inset-bottom)` 仅 iOS，Android 硬件屏未处理 |

### 🛑 未实现

见 `docs/UNIMPLEMENTED.md`：

- 全局 SSE 事件流（`/sse/global/event`）未连接
- 无自动重启（opencode serve 崩了就崩了）
- 目录硬编码 `C:\Users\xxx\Desktop`
- 连接状态心跳

---

## 三、已知问题详细分析

### 3.1 opencode serve 500 错误

**现象：** 所有 API 都正常（health ✅, session create ✅, questions ✅），唯独 `POST /session/{id}/message` 返回 500。

**排查路径：**

```
1. 确认 relay 是否正确代理（已确认：proxy.js pipe 正确，opencode serve 真的返回了 500）
   ↓
2. 确认是否为 DB 副本问题 → 启动 clean opencode serve（不设 OPENCODE_DB）测消息
   ↓
3. 如果 clean serve 也 500 → opencode serve bug
   如果 clean serve 正常 → DB 副本问题
```

**第 2 步没完成** — 之前的测试被超时中断了。需要新开 session 重做。

**建议方案：**
```bash
# 1. kill 所有
taskkill /F /IM node.exe
taskkill /F /IM opencode.exe

# 2. 启动干净 opencode serve（无 DB 覆盖，无密码）
cmd /c "start /B opencode serve --port 4098 --hostname 127.0.0.1"

# 3. 等 5 秒后创建 session
curl -s -X POST "http://127.0.0.1:4098/session?directory=C%3A%5CUsers%5Cxxx%5CDesktop"

# 4. 发消息
curl -s -N -X POST "http://127.0.0.1:4098/session/SESSION_ID/message" ^
  -H "Content-Type: application/json" ^
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"hi\"}]}"
```

### 3.2 token.txt 密码不同步

`auth.js` 的 `TOKEN` 和 `OPCODE_PASSWORD` 是 `require()` 时生成的，每次 `require('./lib/auth')` 会生成不同的值。

- `TOKEN` 写文件加了 `existsSync` 守卫 → OK
- `OPCODE_PASSWORD` **没有**写文件保护 → 重启后如果 `startup.log` 里记录了旧密码就没法找回
- relay 把 `password` 传给 `startOpencode(password)` → serve 用这个密码，但 later `getBasicAuthHeader()` 可能用不同的 `OPCODE_PASSWORD`

**这是个 race condition / 单例问题。** 实际中因为 Node.js 模块缓存，`require('./lib/auth')` 只执行一次，所以问题不大。但如果在同一个进程中手动 `delete require.cache` 再 require 就会有问题。

### 3.3 relay.db SQLite WAL 锁

Desktop 的 `opencode.db` 约 2.8GB，用 SQLite WAL 模式。`copyFileSync` 直接复制：
- Desktop 可能正在写入 → relay.db 可能处于不一致状态
- `copyFileSync` 不复制 `-wal` 和 `-shm` 文件 → 打开 relay.db 时 SQLite 可能认为需要 WAL recovery

**潜在修复：** 复制前先 `PRAGMA wal_checkpoint(TRUNCATE)` 或 `VACUUM INTO` 但这是 Desktop DB，我们不能改。可以考虑复制完后对 relay.db 执行 `PRAGMA wal_checkpoint`。

---

## 四、快速启动

```bash
cd C:\Users\xxx\Desktop\opencode-relay
node server.js
```

启动后：
- 控制台打印二维码 URL
- 手机拍照扫码即可访问
- Token 保存在 `relay-data/logs/token.txt`
- opencode serve 日志在 `relay-data/logs/opencode.log`

### 启动问题排查

| 现象 | 原因 | 处理 |
|------|------|------|
| `opencode serve did not become ready` | opencode serve 没启动起来 | 检查 `opencode serve --port 4097 --hostname 127.0.0.1` 是否能单独启动 |
| `Unauthorized` | token 不匹配 | 重新扫描二维码或手动复制 token URL |
| 先启动 relay 再启动 Desktop | 先启动 Desktop 再启动 relay | Desktop 和 relay 使用独立 DB 副本，互不冲突 |

---

## 五、后续开发方向

### 优先级 1：突破阻塞（应该先做）

1. **确认 opencode serve 500 根因**（如上 3.1 所述）
2. **如果 500 是 opencode serve bug**：联系 opencode 作者 / 降级 / 寻找 workaround
3. **如果 500 是 DB 副本问题**：修复 `copyDesktopDB()` — 加 `PRAGMA wal_checkpoint` 或改用 `VACUUM INTO`

### 优先级 2：前端的 500 兜底

现在 `sendMessage()` 的 catch 分支（第 1763 行）可以抓到网络错误，但如果 `readSSEFromResponse` 内部收到 500，错误处理可能不到位。

需要验证：`POST /session/{id}/message` 返回 500 时，`readSSEFromResponse` 是否能正确触发 `onError` 回调？

### 优先级 3：交付功能

1. 全局 SSE 事件流连接（`/sse/global/event`）
2. 自动重启（opencode serve 崩了自动拉起来）
3. 目录配置化
4. 心跳保活
5. Android 刘海屏适配

### 安全 & 质量

- P1（已修）：CDN 脚本 → vendored + referrer 头
- P2（已修）：auth token timing-safe 比较 + 长度预检
- P2（已修）：proxy body size limit + timeout
- P2（已修）：shutdown 清理 token 文件
- P3（待修）：对 opencode serve stdout 做日志轮转，防止无限增长

---

## 六、关键代码位置速查

| 功能 | 文件:行号 |
|------|-----------|
| config-bar（model/agent 选择器）| `index.html` 搜 `config-bar` |
| 启动时序 | `server.js:28-150` |
| DB 复制 | `opener.js:40-55` |
| opencode serve 启动 | `opener.js:68-104` |
| HTTP 路由分发 | `server.js:64-96` |
| REST 代理 / message 管道 | `proxy.js:9-83` |
| Token 生成 + Basic Auth | `auth.js:1-38` |
| 前端发消息 | `index.html:1630-1769`（`sendMessage`） |
| 前端 SSE 解析 | 搜 `readSSEFromResponse` |
| 问题弹窗 | 搜 `pollQuestions` |
| 前端扫码 | `index.html` 二维码展示区域 |
| 工具调用展开/折叠 | 搜 `tool-call` |
| 前端状态管理 | 搜 `state.currentSessionId` |
| 优雅关闭 | `server.js:138-146` |
| 技术债务清单 | `docs/诚实声明与技术债务.md` |
| 半截功能 | `UNIMPLEMENTED.md` |

---

## 七、测试方法

### 7.1 本地测试（不需要手机）

```bash
# 启动 relay
cd C:\Users\xxx\Desktop\opencode-relay
node server.js

# 另开终端
# 获取 token
$token = (Get-Content "relay-data/logs/token.txt" -Raw).Trim()

# 测试 health
curl.exe -s "http://127.0.0.1:3456/health"
# → {"ok":true,"opencode":"healthy"}

# 创建 session
$session = curl.exe -s -X POST "http://127.0.0.1:3456/api/session?token=$token&directory=C%3A%5CUsers%5Cxxx%5CDesktop"
# → {"id":"ses_xxxx"}

# 发送消息（会卡住 — 正常，SSE 流在等 LLM 回复）
curl.exe -s -N -X POST "http://127.0.0.1:3456/api/session/SESSION_ID/message?token=$token" -H "Content-Type: application/json" -d '{"parts":[{"type":"text","text":"hello"}]}'
```

> ⚠️ **PowerShell 注意**：`-d '{json}'` 内嵌双引号在 PowerShell 中可能被错误解析，导致 `JSON Parse error`。如果发消息报 500，改用文件传 body：
> ```powershell
> '{"parts":[{"type":"text","text":"hello"}]}' | Set-Content -Path msg-body.json -Encoding ASCII
> curl.exe -s -N "http://127.0.0.1:3456/api/session/SESSION_ID/message?token=$token" -H "Content-Type: application/json" --data-binary "@msg-body.json"
> ```
> 前端 SPA 用 `JSON.stringify()` 无此问题。

### 7.2 手机测试（需要同网段）

- Tailscale：`http://<tailscale-ip>:3456?token=xxxx`
- LAN：`http://<lan-ip>:3456?token=xxxx`

扫描二维码或手动输入 URL。

### 7.3 关键 pass 条件

- [ ] relay 启动 → 控制台显示 URL + QR code
- [ ] 手机访问 → 看到界面（无白屏/404）
- [ ] 创建 session → 界面显示会话
- [ ] 发送消息 → 收到 LLM 回复（目前阻塞在这里）
- [ ] 多个 session 切换 → 消息隔离
- [ ] 问题弹窗 → 手机选择后继续对话
- [ ] 重启 relay → 会话记录持久化

---

## 八、常见命令

```powershell
# 启动
cd C:\Users\xxx\Desktop\opencode-relay; node server.js

# 强制杀干净
taskkill /F /IM node.exe; taskkill /F /IM opencode.exe

# 查看 opencode serve 日志
Get-Content "relay-data/logs/opencode.log"

# 查看 token
Get-Content "relay-data/logs/token.txt"

# 清空重来（删除 relay-data）
Remove-Item -Recurse -Force "relay-data"

# 直测 opencode serve（过 relay）
curl.exe -s "http://127.0.0.1:3456/health"

# 通过 relay 测 API
$token = (Get-Content "relay-data/logs/token.txt" -Raw).Trim()
curl.exe -s "http://127.0.0.1:3456/api/session?token=$token&directory=C%3A%5CUsers%5Cxxx%5CDesktop"
```

---

## 九、Git

```
5408812 docs: project-docs-norm — 6文件文档体系
a27f41d fix: pipe proxy response body instead of buffering (SSE streaming)
2f65d3a v2: opencode relay — REST/SSE proxy + chat UI
```

远程：`origin` → `git@github.com:diexie10/opencode-relay.git`

---

*这份手册的目的是让新会话能在 10 分钟内理解项目全貌并开始工作。关键阻塞点是 opencode serve 500 错误，建议新会话的第一件事就是完成 clean serve 的 message 测试。*
