# OpenCode Relay — 项目规则

## 阅读顺序

1. `docs/方案.md` — 完整架构设计（1887 行）
2. `docs/architecture/1-架构设计.md` — 架构摘要
3. `server.js` — 主入口，启动时序 + 路由分发
4. `lib/*.js` — 各子模块
5. `public/index.html` — 前端 SPA

## 目录结构

```
opencode-relay/
├── server.js          # 代理服务器入口：路由 + 导入/回并 API
├── relay-start.js     # 一键启动（清理进程 + 健康检查）
├── lib/               # 后端模块
│   ├── api-config.js  # API 端点路径（单一真源）
│   ├── auth.js        # Token 认证 + Basic Auth
│   ├── config.js      # 配置读写（relay-data/config.json）
│   ├── models.js      # 模型/代理列表
│   ├── opener.js      # opencode serve 生命周期 + 独立 DB 管理
│   ├── proxy.js       # REST 代理（流式 pipe）
│   ├── sse-tunnel.js  # SSE 隧道
│   ├── static.js      # 静态文件服务
│   └── status.js      # 运行状态
├── public/
│   ├── index.html     # Preact SPA（SoftGlass）
│   └── vendor/        # marked + DOMPurify（CDN 下线方案）
├── relay-data/        # 运行时数据（已 gitignore，可删除自动重建）
│   ├── relay.db       # 独立持久数据库
│   ├── projects/      # 导入的项目
│   ├── backups/       # 回并备份
│   └── logs/          # 日志 + token.txt
├── docs/              # 全部文档（方案/交接/陷阱/债务/接口契约…）
└── package.json
```

## 铁律

1. **禁止修改 Desktop 的 opencode.db** — relay 用独立 DB：`opencode serve` 以 `OPENCODE_DB=relay-data/relay.db` 启动
2. **Windows 兼容** — `shell: true` 启动 opencode serve（.ps1 脚本），`taskkill /F /PID x /T` 停止
3. **Basic Auth 用户名必须是 `opencode`** — 不是空用户名
4. **SSE 流必须 pipe，不能 buffer** — `response.text()` 会阻塞流式输出
5. **端点在 `api-config.js` 中定义，禁止硬编码**
6. **同源部署，不加 CORS header**
7. **凭据不进仓库** — `relay-data/`（含 `config.json`、`logs/token.txt`）和启动日志一律不提交

## Commit 前自检

- [ ] 无硬编码的 API 路径
- [ ] 无 `response.text()` 替代 pipe
- [ ] Basic Auth 使用 `'opencode:' + password` 格式
- [ ] `docs/SESSION_LOG.md` 已更新
- [ ] `docs/UNIMPLEMENTED.md` 已检查
- [ ] 无新增凭据/内网地址进入暂存区