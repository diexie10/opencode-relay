# OpenCode Relay — API 接口文档

> 本文档供 UI 设计参考。所有接口已在 `/api/` 路由下，需 `X-Auth-Token` 头认证。

---

## 1. 后端 REST 接口

### 1.1 GET /api/models — 模型/代理/强度列表

由 Relay 自身处理（不转发到 opencode serve）。返回可用模型、代理类型、思考强度选项。

**Response:**
```json
{
  "models": [
    {
      "id": "deepseek-v4-flash",              // 模型 ID（provider 内唯一）
      "providerID": "deepseek",               // 提供者 ID
      "key": "deepseek/deepseek-v4-flash",    // opencode.jsonc 格式的完整 key
      "name": "deepseek (deepseek-v4-flash)", // 显示名称
      "providerName": "deepseek",             // 提供者显示名
      "reasoning": true,                      // 是否支持推理/思考
      "toolCall": true,                       // 是否支持工具调用
      "contextLimit": 128000,                 // 最大上下文 Tokens
      "outputLimit": 16384,                   // 最大输出 Tokens
      "attachment": true,                     // 是否支持附件
      "modalities": { "input": ["text"] },   // 支持的输入模态
      "isDefault": true,                      // 是否为 opencode.jsonc 中的默认模型
      "isSmallDefault": false
    }
    // ... 更多模型
  ],
  "agents": [
    { "id": "orchestrator", "name": "Orchestrator", "description": "Full workflow orchestration" },
    { "id": "general", "name": "General", "description": "General-purpose agent" },
    { "id": "build_plan", "name": "Build Plan", "description": "Plan-first implementation" },
    { "id": "explorer", "name": "Explorer", "description": "Codebase exploration" },
    { "id": "explore", "name": "Explore", "description": "Codebase search (alt name)" },
    { "id": "librarian", "name": "Librarian", "description": "External knowledge research" },
    { "id": "fixer", "name": "Fixer", "description": "Bounded implementation" },
    { "id": "designer", "name": "Designer", "description": "UI/UX design" },
    { "id": "oracle", "name": "Oracle", "description": "Architecture & review" }
  ],
  "variants": [
    { "id": "max", "name": "Max", "description": "Maximum reasoning effort" },
    { "id": "medium", "name": "Medium", "description": "Balanced reasoning effort" },
    { "id": "min", "name": "Min", "description": "Minimal reasoning effort" }
  ],
  "defaultModel": { "id": "deepseek-v4-flash", "providerID": "deepseek" },
  "defaultAgent": "orchestrator",
  "defaultVariant": "max"
}
```

**前端变量引用：** `_allModels`, `_allAgents`, `_allVariants`（`init()` 时自动填充）

---

### 1.2 GET /api/project — 项目列表

透传到 opencode serve 的 `/project` 端点。列出桌面端已知的项目目录。

**Response:**
```json
[
  {
    "id": "5837b19f26006010ca91df703110d35b2c7d1eee",  // 项目唯一 ID
    "worktree": "C:\\Users\\xxx\\Desktop\\opencode-relay",  // 项目路径
    "time": { "created": 1785252656466, "updated": 1785322322930 },
    "sandboxes": []  // 暂未使用
  }
]
```

**UI 用途：** 项目/会话分层选择器。用户选择一个项目（工作目录），然后在该项目下创建/查看会话。

---

### 1.3 POST /api/session — 创建会话

透传到 opencode serve 的 `/session` 端点。**必须在 query 中传 `directory=` 参数。**

**Query 参数：**
| 参数 | 必填 | 说明 |
|------|------|------|
| `directory` | 是 | 工作目录（如 `C:\Users\xxx\Desktop`） |

**Request Body**（可选）：
```json
{
  "model": {
    "id": "deepseek-v4-flash",
    "providerID": "deepseek",
    "variant": "max"        // 可选，默认由服务端决定
  },
  "agent": "orchestrator",  // 可选，默认由服务端决定
  "projectID": "..."        // 可选，关联到已有项目
}
```

**Response:**
```json
{
  "id": "ses_xxxxxxxxxxxx",
  "slug": "auto-slug",
  "title": "New session - 2026-07-29T10:00:00.000Z",
  "projectID": "5837b19f...",
  "directory": "C:\\Users\\xxx\\Desktop\\opencode-relay",
  "agent": "orchestrator",
  "model": { "id": "deepseek-v4-flash", "providerID": "deepseek", "variant": "max" },
  "version": "1.18.5",
  "time": { "created": 178532..., "updated": 178532... }
}
```

> **注意：** model/agent/variant **只能在创建时设置**，后续消息无法改变。每条消息不接收这些参数。

**前端函数：** `createSession(config)` — config 对象：
```js
{
  model: { id: "...", providerID: "..." },  // 可选
  agent: "orchestrator",                      // 可选
  variant: "max"                             // 可选
}
```

---

### 1.4 GET /api/session — 会话列表

透传。列出当前 directory 下的所有会话。

**Response:** 会话对象数组（同上结构）。每个会话的 `agent`、`model`、`title` 可用于 UI 展示。

---

### 1.5 POST /api/session/{id}/message — 发送消息

透传。返回 SSE 流或 JSON 响应。

**Request Body:**
```json
{
  "parts": [{ "type": "text", "text": "消息内容" }]
}
```

**Response:** SSE stream (`text/event-stream`) 或 JSON。
- SSE events: `text_delta`, `message`, `tool_call`, `tool_result`, `done`, `error`, `question`
- JSON: `{ parts: [{ type: "text", text: "..." }, ...] }`

**前端函数：** `sendMessage()` 已处理 SSE 解析和流式渲染。

---

### 1.6 GET /api/session/{id}/message — 获取消息历史

透传。返回消息数组，每条包含 `info.id`, `info.role`, `parts[]`。

---

### 1.7 GET /api/question / POST .../reply / POST .../reject — 问答交互

透传。用于处理 opencode 子代理的提问（选项选择/文本输入）。详见前端 `pollQuestions()` 和 `answerQuestion()`。

---

### 1.8 其他透传端点

| 端点 | 说明 |
|------|------|
| `GET /global/event` | SSE 事件流（状态变更通知） |
| `GET /health` | Relay 健康检查（无 auth） |
| `POST /api/login` | 用户登录（无 auth，返回 token） |
| `GET /api/setup/status` | 密码配置状态（无 auth） |
| `POST /api/setup` | 设置密码（无 auth） |

---

## 2. 前端状态变量（供 UI 组件引用）

```js
// ── 模型/代理/强度数据（init() 时从 /api/models 填充）──
_allModels   = [
  { id, providerID, key, name, providerName, reasoning, toolCall,
    contextLimit, outputLimit, attachment, modalities, isDefault, isSmallDefault }
]
_allAgents   = [
  { id: "orchestrator", name: "Orchestrator", description: "..." }
]
_allVariants = [
  { id: "max", name: "Max", description: "Maximum reasoning effort" }
]

// ── 当前会话配置（新建会话时使用）──
state.sessionConfig = {
  model:   { id: "deepseek-v4-flash", providerID: "deepseek" },  // null 表示默认
  agent:   "orchestrator",   // null 表示默认
  variant: "max"             // null 表示默认
}
```

**UI 修改 `state.sessionConfig` 后，调用 `createSession()` 即可用新配置创建会话。**

---

## 3. 会话数据结构（用于 UI 渲染）

```js
// state.sessions[] 中的每个元素
{
  id: "ses_xxxxxxxxx",       // 会话 ID
  slug: "auto-slug",
  title: "对话标题",          // 首条消息后服务端自动命名
  messages: [
    {
      id: "msg_xxx",
      role: "user" | "assistant" | "tool",
      content: "消息文本",
      isStreaming: false,
      timestamp: 1234567890,
      // 仅 tool 消息：
      toolName: "read_file",
      toolArgs: { path: "..." }
    }
  ],
  createdAt: 1234567890,
  lastActiveAt: 1234567890,
  agent: "orchestrator",     // 创建时指定的 agent
  model: { id: "...", providerID: "..." },  // 创建时指定的模型
  variant: "max"             // 创建时指定的变体
}
```

---

## 4. UI 对接指引

### 模型选择器
- 数据源：`_allModels`
- 显示：`providerName + " " + name`（如 "nvidia DeepSeek V4 Pro"）
- 值：`{ id, providerID }`
- 注意：`reasoning: true` 的模型才适合选 `variant`（max/medium/min）

### Agent 选择器
- 数据源：`_allAgents`
- 显示：`name`
- 提示：`description` 可作为 tooltip

### 思考强度选择器
- 数据源：`_allVariants`
- 仅在模型 `reasoning: true` 时可用
- 默认：`max`

### 项目选择器
- 数据源：`GET /api/project` → 取 `worktree` 字段
- 切换项目后，`createSession()` 的 `directory` query 参数应更新

### 会话侧栏
- `state.sessions` 按 `directory` 分组
- 每个会话显示：`title`、消息数、agent icon/badge、模型名
- 点击切换：`switchSession(id)`
