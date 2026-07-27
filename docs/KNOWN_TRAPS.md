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
