# UNIMPLEMENTED — 半截功能清单

| 功能 | 文件 | 当前状态 | 验证方法 |
|------|------|---------|---------|
| SSE 问题通过弹窗处理 | index.html | 问题通过 SSE 事件或 polling 接收，弹窗 UI 完成但未在手机端实测 | 手机实测 |
| 工具调用结果展开/折叠 | index.html | tool-body 渲染完成，交互逻辑待验证 | 手机实测 |
| Session 会话消息同步 | index.html | 切换 session 时保存/加载 localStorage，但未做增量同步（全量覆盖） | 手机实测多个 session |
| 全局事件流推送 | index.html | 未连接 `/sse/global/event`，仅靠 polling 拉取问题 | 手机测试问答场景 |
| DB 副本压缩 | opener.js | Desktop DB 2.8GB 直接 copyFileSync，无 VACUUM 或压缩 | 观察 relay-data 大小 |
| 重启自动恢复 | server.js | 优雅关闭已实现，但无自动重启逻辑（崩了就崩了） | 模拟 serve 崩溃 |
| 多目录支持 | server.js | 目前硬编码 `C:\Users\xxx\Desktop`，未做成配置项 | N/A |
| 连接状态心跳 | index.html | 移除旧 SSE 后无 keepalive 心跳，仅靠 fetch 超时 | 手机断网重连场景 |
