@echo off
echo [relay] Starting OpenCode Relay v2...
node server.js
if %errorlevel% neq 0 (
  echo [relay] Relay exited with code %errorlevel%
  pause
)
