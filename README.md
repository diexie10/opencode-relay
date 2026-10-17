# OpenCode Relay

> 把桌面的 [opencode](https://opencode.ai) 变成手机上的聊天界面 —— 一个做着玩的项目。

## 这是什么

一个轻量代理服务器（Node.js，除 `qrcode-terminal` 外全用内置模块），让你用手机浏览器访问桌面端运行的 opencode：

- 手机浏览器打开一个 URL（扫终端二维码即可）就能和桌面上的 opencode 对话
- 自带登录认证、会话管理、流式输出（SSE）
- 支持把桌面项目「导入」到手机工作区，改完还能「回并」到源目录（带冲突检测与备份）
- 前端是重写的 Preact 单页应用，SoftGlass 风格，还挺好看的

```
手机浏览器  ⇄  Relay Server (node :3456)  ⇄  opencode serve (:4097)  ⇄  桌面 AI
```

## 环境要求

| 依赖 | 说明 |
|------|------|
| Node.js | 后端只依赖内置模块 + `qrcode-terminal` |
| opencode CLI | 版本基线 **1.18.x**，relay 按这一代的 REST/SSE 契约定制（见 `docs/API-INTERFACES.md`） |
| 操作系统 | 按 Windows 写的：进程管理用 `taskkill`，启动脚本为 `.bat` / `.ps1` |

## 快速开始

```bash
npm install
node relay-start.js          # 一键清理旧进程 + 启动 + 健康检查
node relay-start.js --reset  # 重置数据库后启动
```

启动后终端会打印带 token 的访问地址（局域网 / Tailscale），手机浏览器打开即可。

## 使用流程

1. **导入**：设置面板里输入桌面项目路径，relay 会把项目复制到 `relay-data/projects/`
2. **对话**：在手机工作区里正常和 opencode 对话
3. **回并**：手机上的改动可以通过回并功能写回源目录（带冲突检测和备份）

## 目录结构

```
opencode-relay/
├── server.js              # 主入口：启动时序 + HTTP 路由 + 导入/回并 API
├── relay-start.js         # 一键启动（清理进程 + 健康检查）
├── lib/                   # 后端模块
│   ├── api-config.js      # API 端点路径（单一真源）
│   ├── auth.js            # Token 认证 + Basic Auth 凭据源
│   ├── config.js          # 配置读写（relay-data/config.json）
│   ├── models.js          # 模型/代理列表
│   ├── opener.js          # opencode serve 生命周期 + 独立 DB 管理
│   ├── proxy.js           # REST 代理（流式 pipe，不缓冲）
│   ├── sse-tunnel.js      # SSE 隧道
│   ├── static.js          # 静态文件服务 + 路径防护
│   └── status.js          # 运行状态
├── public/
│   ├── index.html         # Preact SPA（SoftGlass 设计系统）
│   └── vendor/            # marked.min.js + purify.min.js（CDN 下线方案）
├── docs/                  # 全部文档，见下
├── relay-data/            # 运行时数据（已 gitignore，可删除自动重建）
│   ├── relay.db           # 独立持久数据库
│   ├── projects/          # 导入的项目
│   ├── backups/           # 回并备份
│   ├── config.json        # 密码等配置
│   └── logs/              # 日志 + token.txt
├── start.bat / start-serve.bat / start-serve.ps1
├── CLAUDE.md              # 项目规则（给 AI 协作用）
└── package.json
```

## 文档

| 文档 | 内容 |
|------|------|
| [`docs/方案.md`](docs/方案.md) | 完整架构设计（1887 行）—— 唯一一份「为什么这么设计」 |
| [`docs/architecture/1-架构设计.md`](docs/architecture/1-架构设计.md) | 架构摘要 |
| [`docs/API-INTERFACES.md`](docs/API-INTERFACES.md) | opencode serve 的 HTTP/SSE 接口契约 |
| [`docs/SESSION_LOG.md`](docs/SESSION_LOG.md) | 逐轮开发/排障全记录 |
| [`docs/HANDOVER.md`](docs/HANDOVER.md) | 交接手册（关键代码位置速查 + 测试方法） |
| [`docs/HANDOVER-round5.md`](docs/HANDOVER-round5.md) | 第 5 轮交接：Desktop 架构逆向 + 未验证改动清单 |
| [`docs/KNOWN_TRAPS.md`](docs/KNOWN_TRAPS.md) | 已知陷阱日志 |
| [`docs/诚实声明与技术债务.md`](docs/诚实声明与技术债务.md) | 技术债务清单 |
| [`docs/UNIMPLEMENTED.md`](docs/UNIMPLEMENTED.md) | 半截功能清单 |
| [`docs/移动端界面方案.md`](docs/移动端界面方案.md) | 移动端 UI 方案 |
| [`docs/opencode-relay-prompt.md`](docs/opencode-relay-prompt.md) | 最初用来生成这个项目的提示词 |
| [`docs/CHANGELOG.html`](docs/CHANGELOG.html) | 变更记录 |

## 项目失误自白

这个项目踩过不少坑，写下来供后来者参考：

- **DB 复制方案是错的**：最初每次启动都从桌面版 `opencode.db` 复制一份。但桌面版用 WAL 模式且一直在写，`copyFileSync` 复制出来的快照必然损坏，`node:sqlite` 备份也不可靠。后来改成独立持久 DB，彻底不碰桌面版 —— 早该这样。
- **SSE 流不能 buffer**：代理层最初用 `response.text()` 拿完整响应，流式输出直接卡死。必须 pipe 流，并且超时只能保护连接建立阶段，收到响应头后必须清掉，否则长对话会被 30 秒超时掐断。
- **Windows 进程管理是坑**：`spawn` 带 `shell: true` 会触发 deprecation warning；杀进程要用 `taskkill /F /PID x /T`；WAL/SHM 文件会被残留进程锁住导致重启失败。为此写了 `relay-start.js` 统一处理。
- **权限/认证想简单**：认证用 `X-Auth-Token` header 或 `?token=` query param，密码存 `relay-data/config.json`。做做玩可以，生产环境请换正经方案。
- **前端前后重写了两遍**：第一版原生 JS 直接操作 DOM，第二版迁移到 Preact 才算是能维护的样子。

## 安全须知

- 认证方式是最简形式（token 走 header 或 URL query），**不要暴露在公网**，建议只在局域网或 Tailscale 内使用。
- `relay-data/` 已在 `.gitignore` 中：里面有 `config.json`、`logs/token.txt` 等凭据，**不要提交**。
- 一旦 token 或内网地址被写进日志/二维码并公开，请立刻换密码并清理相关文件。

## 免责声明

本项目纯属个人做着玩，代码里充满个人习惯和临时决策，**不保证稳定、不保证安全、不提供任何支持**。

- 不要用于生产环境
- 不要暴露在公网
- 密码、token 都是你自己负责

需要的话随便拿去改，能帮到你一点就很好。

## 技术栈

- **后端**：Node.js（零依赖，仅用内置模块 + `qrcode-terminal`）
- **前端**：Preact + htm (ES Module CDN) + marked + DOMPurify
- **数据**：SQLite（opencode 自己的存储，relay 用独立副本）

## License

[MIT](./LICENSE)