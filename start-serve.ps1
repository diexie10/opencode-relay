# 本地调试脚本 — 仅供开发使用，请勿用于生产环境
$env:OPENCODE_SERVER_PASSWORD = 'CHANGEME'
opencode serve --port 4097 --hostname 127.0.0.1
