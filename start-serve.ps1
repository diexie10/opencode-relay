# 本地调试脚本 — 仅供开发使用，请勿用于生产环境
if (-not $env:OPENCODE_SERVER_PASSWORD) {
  $env:OPENCODE_SERVER_PASSWORD = -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 32 | ForEach-Object { [char]$_ })
}
opencode serve --port 4097 --hostname 127.0.0.1
