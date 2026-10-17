# OpenCode Relay — 前端重写任务

## 项目背景

这是一个 **OpenCode Relay** 项目。OpenCode 是一个 CLI 编程助手（类似 Claude Code / Codex），用 Go 编写，通过 `opencode serve` 提供 HTTP API 服务。

Relay 是在 OpenCode Serve 外面套的一个 Web 代理层，提供：
- **Web UI** — 取代 CLI 的浏览器聊天界面
- **认证** — 登录页面 + Token 鉴权
- **DB 副本** — 隔离的 SQLite 数据库
- **API 转发** — 把浏览器请求代理到 opencode serve

## 核心架构

```
浏览器 (http://localhost:3456)
    ↓ HTTP / SSE
Relay (Node.js: server.js + lib/*.js)
    ↓ HTTP / SSE (代理转发到)
opencode serve (localhost:4098)
    ↓
LLM API (DeepSeek / OpenAI / 等)
```

Relay 本身**不调用模型**，只是透明转发。

## 文件结构

| 文件 | 用途 |
|------|------|
| `server.js` | Express 主入口，路由注册 |
| `lib/auth.js` | 登录认证（密码 → Token） |
| `lib/proxy.js` | REST API 代理转发 |
| `lib/sse-tunnel.js` | SSE 流式隧道（核心！） |
| `lib/opener.js` | opencode serve 生命周期管理 |
| `lib/static.js` | 静态文件服务 |
| `lib/api-config.js` | API 端点路径统一管理 |
| `lib/config.js` | 配置读取 |
| `public/index.html` | **前端 SPA（需要重写的目标）** |

## 参考标的：OpenCode Desktop App

OpenCode 官方有一个桌面版（Electron + Solid.js），体验非常流畅精致。关键特征：

1. **流畅的流式输出** — 每个 token 到达时仅追加文本节点，不重新渲染整个消息气泡
2. **思考链展示** — 模型"思考"过程以可折叠灰块显示，与实际输出分离
3. **结构化消息** — 每条消息的 content 是数组 `[{type:"reasoning",text:"..."}, {type:"text",text:"..."}, {type:"tool_call",...}]`，不是平铺字符串
4. **虚拟滚动** — 长对话只渲染可见区域
5. **响应式框架** — Solid.js，数据绑定自动驱动 DOM 更新
6. **精致 UI** — 圆角、动效、字体、色彩、明暗主题

## 任务目标

用 **Solid.js**（优先）或 **Preact**，**重写 `public/index.html` 的前端部分**，达到 Desktop App 级别的流畅度和精致度。

### 具体要求

**功能性：**
- [ ] 完整的登录页（输入密码 → 获取 Token → 存储到 sessionStorage）
- [ ] 会话列表（从 `/api/chat/sessions` 加载，可切换/删除）
- [ ] 聊天主界面（消息列表 + 输入框 + 模型选择）
- [ ] 流式 SSE 输出（通过 `/api/chat/stream`，增量追加文本，不替换整个消息）
- [ ] reasoning（思考链）以折叠灰块独立显示，与实际回答分离
- [ ] 选模型下拉框（从 `/api/models` 获取，支持搜索/过滤）
- [ ] 支持连续对话（多轮）

**流畅度：**
- [ ] 增量 DOM 更新 — 收到 token 仅追加文本节点，不 innerHTML 整个消息
- [ ] 虚拟滚动或窗口化列表 — 100+ 条消息不卡
- [ ] Markdown 渲染（代码块高亮、数学公式、表格）— 可考虑异步渲染

**精致度：**
- [ ] 设计系统 — 字体、间距、颜色、圆角统一
- [ ] 暗色主题
- [ ] 微交互动效（hover、输入框 focus、消息入场）
- [ ] 自适应布局（桌面 + 平板）
- [ ] 打字机效果光标

**技术约束：**
- 必须保持同源部署，不能引入额外的构建步骤
- 如果用 JSX/TSX，使用 standalone Babel 浏览器内编译（或直接 hyperscript）
- 所有 API 调用使用 `X-Auth-Token` header 认证
- 最终产出是单个 HTML 文件或一个 HTML + 数个 JS 文件
- API 端点前缀见 `api-config.js`（`/api/chat/stream`, `/api/models`, `/api/chat/sessions` 等）

### API 接口文档

**`POST /api/login`** — 登录
```json
// Request: {"password": "xxx"}
// Response: {"ok": true, "token": "sha256hex..."}
```

**`GET /api/models?token=xxx`** — 获取模型列表

**`GET /api/chat/sessions?token=xxx`** — 获取会话列表

**`POST /api/session?token=xxx`** — 创建会话

**`GET /api/chat/stream?token=xxx&session=xxx` — SSE 流**
SSE 事件格式：
```
event: message
data: {"type":"text","content":"Hello"}

event: message
data: {"type":"reasoning","content":"Let me think..."}

event: done
data: [DONE]
```
每个 `message` 事件中的 `data.type` 取值：`text`（实际回答）、`reasoning`（思考过程）、`tool_use`（工具调用）、`tool_result`（工具结果）。

`event: done` 标记流结束。

## 现有代码限制

当前 `public/index.html` 是用纯 jQuery 手写 DOM 操作，每个 delta 都完整替换 `.bubble` 的 innerHTML，导致：
- 大量不必要的 DOM 操作
- Markdown 被反复重新渲染
- 列表增长后越来越卡
- reasoning 和 text 混在同一个字符串中

## 评价标准

1. 流式输出是否够顺滑（关键）
2. 思考链是否独立显示且可折叠
3. 长对话是否依然流畅
4. UI 整体观感是否接近桌面级应用
5. 代码是否可维护（模块化、响应式绑定）

## 交付物

一个或多个前端文件（HTML + JS/CSS），可以替换 `public/` 目录。优先输出单 HTML 文件方案（最简单部署）。

如果需要额外构建工具，说明需要安装什么以及如何集成到现有的 `node server.js` 启动流程中。

---

> **额外提示：** 如果你想先看 OpenCode Desktop 的实际效果，它的源码打在了 Electron asar 包里。但本质上，它的数据流就是上面描述的 SSE 事件 + 结构化 content 数组。我们的 relay 后端已经完全兼容这个数据模型（reasoning/text 已经分离），只是前端没有正确利用。
