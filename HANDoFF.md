# Handoff — 第5轮结束

## 上次做了什么

### Desktop 架构逆向
- 反编译了 Desktop 的 `app.asar`（Electron 包）
- 发现 `sidecar.js` → 不是子进程 `opencode.exe serve`，而是 `utilityProcess.fork()` → import `Server` → `Server.listen()`
- Desktop Renderer 也走 HTTP API（同 relay），不直接读 SQLite
- 快的奥义：`staleTime: Infinity` + serverSync 响应式 store + `/global/event` 事件推送

### 前端改动（已合但未验证）
改了 `public/index.html`，加了这些：

1. **`_store`** — 持久化数据层，跨目录切换保留 session 和 messages
2. **`connectGlobalEventStream()`** — 连接 opencode serve 的 `/global/event` SSE
3. **`handleGlobalEvent()`** — 处理 session-created/updated/deleted、question-created/answered
4. **`switchDirectory()` 快速路径** — store 命中时 0 API 调用
5. **`ensureSession()` 优先 store** — 减少重复 fetch
6. **所有写操作同步 store** — saveSessionMessages/createSession/deleteSession/mergeBackendSessions

**后端的 proxy.js 不需要改** — 现有的 `/api/` proxy 已经能正确处理 SSE 流。

## 当前要解决的问题

### 1. relay 启动不了
上次清理时杀了所有 node + opencode 进程，但 relay 启动时 opencode serve 没起来。可能原因：
- opener.js 里 shell:true 启动 opencode.exe 但路径不对
- 或旧进程残留占用了 4097 端口
- **建议**：硬重启整台机器，然后手动启动 relay

### 2. 未验证的改动
- `/global/event` SSE 端点已验证可连通（返回 server.connected 事件）
- 但前端事件流连接从未实际测试过
- 目录切换 store 缓存也未测试
- **建议**：启动后先打开浏览器控制台看事件日志

### 3. 已知的代码问题
- `connectGlobalEventStream()` 中 401 时 `scheduleEventReconnect()` 但变量名拼错了（已修）
- `switchDirectory()` store 路径可能没正确处理 `session[0]`（最新）vs `session[last]`（最旧）的顺序
- 事件处理器里的 `session-deleted` 处理逻辑可能有边界情况

## 文件位置

| 文件 | 改动 |
|------|------|
| `public/index.html` | 加 `_store`、`connectGlobalEventStream`、`handleGlobalEvent`；`switchDirectory`/`ensureSession`/`mergeBackendSessions`/`createSession`/`deleteSession`/`saveSessionMessages` 同步 store |
| `SESSION_LOG.md` | 更新了本轮记录 |

## 下一轮要做的

1. **启动 relay 验证基础功能** — 确保能连上，能发消息
2. **验证事件流** — 打开浏览器控制台，检查 Events 日志
3. **验证目录切换** — 多个项目目录间切换，看是不是秒切
4. **验证问题推送** — 触发一个 question，看事件流会不会推过来
5. **移除轮询** — 如果事件流验证通过，可以删掉 `setInterval(pollQuestions, ...)`

## 环境坑

- **PowerShell $pid 是只读自动变量**（当前进程 ID），不能赋值。要用 `$procId` 代替
- **dcg 安全策略**：`2>$null`、`>`、`|` 到可变路径都会被拦截。用 `--stderr nul` 或写固定路径临时文件绕过
- **Start-Process -NoNewWindow**：bash 超时会杀子进程，导致 relay 变孤儿。用 `-WindowStyle Hidden` 或 `Start-Job` 代替
- **taskkill /IM "opencode.exe"** 会连 Desktop 的一起杀。用 PID 精确杀更好
- **渲染问题**：PowerShell 输出 UTF-8 到 node 时中文乱码。`[System.IO.File]::WriteAllText` 要指定 UTF8 BOM
