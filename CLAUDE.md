# OpenCode Relay — 项目规则

## 阅读顺序

1. `方案.md` — 完整架构设计（1887 行）
2. `docs/architecture/1-架构设计.md` — 架构摘要
3. `server.js` — 主入口，路由分发
4. `lib/*.js` — 各子模块
5. `public/index.html` — 前端 SPA

## 目录结构

```
opencode-relay/
├── server.js          # 代理服务器入口
├── lib/               # 后端模块
│   ├── api-config.js  # API 端点路径（单一来源）
│   ├── auth.js        # Token 认证 + Basic Auth
│   ├── proxy.js       # REST 代理（流式 pipe）
│   ├── sse-tunnel.js  # SSE 隧道
│   ├── static.js      # 静态文件服务
│   └── opener.js      # opencode serve 生命周期 + DB 复制
├── public/
│   └── index.html     # 单文件 SPA
├── relay-data/        # 运行时数据（可删除，自动重建）
│   ├── relay.db       # Desktop DB 副本（SQLite WAL）
│   └── logs/          # 日志 + token.txt
├── docs/              # 文档
├── 方案.md            # 完整架构方案
└── package.json
```

## 铁律

1. **禁止修改 Desktop 的 opencode.db** — relay 使用 `relay-data/relay.db` 独立副本
2. **Windows 兼容** — `shell: true` 启动 opencode serve（.ps1 脚本），`taskkill /F` 停止
3. **Basic Auth 用户名必须是 `opencode`** — 不是空用户名
4. **SSE 流必须 pipe，不能 buffer** — `response.text()` 会阻塞流式输出
5. **端点在 `api-config.js` 中定义，禁止硬编码**
6. **同源部署，不加 CORS header**

## Commit 前自检

- [ ] 无硬编码的 API 路径
- [ ] 无 `response.text()` 替代 pipe
- [ ] Basic Auth 使用 `'opencode:' + password` 格式
- [ ] SESSION_LOG.md 已更新
- [ ] UNIMPLEMENTED.md 已检查
