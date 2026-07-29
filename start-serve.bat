@echo off
:: 本地调试脚本 — 仅供开发使用，请勿用于生产环境
if "%OPENCODE_SERVER_PASSWORD%"=="" set OPENCODE_SERVER_PASSWORD=%RANDOM%%RANDOM%%RANDOM%
opencode serve --port 4097 --hostname 127.0.0.1
