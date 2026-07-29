# UNIMPLEMENTED — 半截功能清单

> 状态：**手机端核心链路打通**（扫码 → 发消息 → 收回复 ✅）
> 下方为有待完善的功能，按重要性排列。

| 功能 | 文件 | 当前状态 | 验证方法 |
|------|------|---------|---------|
| SSE 问题通过弹窗处理 | index.html | 问题通过 SSE 事件或 polling 接收，弹窗 UI 完成但未在手机端实测 | 手机实测问答场景 |
| 工具调用结果展开/折叠 | index.html | tool-body 渲染完成，交互逻辑待验证 | 手机实测 |
| Session 会话消息同步 | index.html | 切换 session 时保存/加载 localStorage，但未做增量同步（全量覆盖） | 手机实测多个 session |
| **全局事件流推送** | index.html | **已实现，SSE 端点已验证可连通**（返回 server.connected 事件）。但前端 `connectGlobalEventStream()` 从未实际测试 | 打开浏览器控制台看 [Events] 日志 |
| **持久化数据层** | index.html | **已实现但未验证**：`_store` 跨目录切换保留 sessions/messages，`switchDirectory()` 有快速路径（store 命中时 0 API 调用）。**待实际测试目录切换性能** | 切目录看是否秒切、消息不丢失 |
| relay 启动稳定性 | server.js, opener.js | **已解决**：ServeError 崩溃是启动方式问题（bash timeout 杀进程），`Start-Process -WindowStyle Hidden` 启动正常 | relay 持续运行 10min+ 无 crash |
| 多目录支持 | server.js | 目前从 `/api/project` 自动发现所有 directory，但 relay-data/config.json 硬编码路径 | N/A |
| 连接状态心跳 | index.html | 无 keepalive 心跳，全局事件流自带 keepalive（30s） | 手机断网重连场景 |
