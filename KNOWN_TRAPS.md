# 已知陷阱

## Basic Auth 用户名留空

**错误表现**：`opencode serve` 返回 401 Unauthorized

**错误代码**：
```javascript
// ❌
'Basic ' + Buffer.from(':' + password).toString('base64')
```

**正确代码**：
```javascript
// ✅
'Basic ' + Buffer.from('opencode:' + password).toString('base64')
```

**原因**：opencode serve 的 Basic Auth 要求用户名是 `opencode`，空用户名无法通过验证。

**发现于**：Phase 3 测试，2026-07-27

---

## SSE 响应用 `response.text()` 缓冲

**错误表现**：前端一直"等待回复"，SSE 事件无法实时到达

**错误代码**：
```javascript
// ❌
const text = await response.text();
res.end(text);
```

**正确代码**：
```javascript
// ✅
const reader = response.body.getReader();
while (true) {
  const { done, value } = await reader.read();
  if (done) { res.end(); break; }
  res.write(value);
}
```

**原因**：`response.text()` 等待整个响应体完成后才返回，SSE 流式响应被完全缓冲，前端收不到增量事件。

**发现于**：Phase 3 用户反馈"一直重连中/等待回复"，2026-07-27

---

## SSE 连接用 GET 而非从 POST 响应读

**错误表现**：SSE 客户端连接 `/sse/session/{id}/message` 始终建立不了

**错误代码**：
```javascript
// ❌ 前端单独开 SSE 连接，GET 请求
const url = '/sse/session/' + sessionId + '/message';
// GET 请求返回的是 JSON 消息列表，不是 SSE
```

**正确做法**：
```javascript
// ✅ 从 POST 消息的响应体读 SSE
const response = await fetch(url, { method: 'POST', ... });
await readSSEFromResponse(response, handlers);
```

**原因**：opencode serve 的 GET `/session/{id}/message` 返回消息列表 JSON，SSE 流只在 POST 响应体中。

**发现于**：Phase 3 测试，2026-07-27

---

## SSE 解析器假定所有响应都是 SSE 流

**错误表现**：前端一直"等待回复"，尽管后端返回了 200 OK 且在 opencode.log 中可以看到 LLM 回复完成。

**错误代码**：
```javascript
// ❌ 只处理 SSE，忽略 JSON 响应
const response = await fetch(url, { method: 'POST', ... });
await readSSEFromResponse(response, handlers);
```

**正确做法**：
```javascript
// ✅ 先检查 Content-Type，区分 JSON 和 SSE
const ct = response.headers.get('content-type') || '';
if (ct.includes('application/json')) {
  const data = await response.json();
  // 从 data.parts 提取 text 内容
} else {
  await readSSEFromResponse(response, handlers);
}
```

**原因**：opencode serve 的 `POST /session/{id}/message` 返回格式取决于消息长度和流式状态 —
短消息返回完整的 `application/json`，长消息/流式返回 `text/event-stream`。前端只实现了 SSE 解析器，
导致 JSON 响应被静默丢弃。

**发现于**：第 2 轮接管测试，2026-07-28
