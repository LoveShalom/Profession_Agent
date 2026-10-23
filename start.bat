@echo off
REM ============================================================================
REM 一键启动（Windows）：对应 F-01 的 T1 与 AC-1
REM 等价于：node scripts/setup.mjs %*
REM ============================================================================
setlocal

where node >nul 2>nul
if errorlevel 1 (
  echo [X] 未检测到 Node.js，请先安装 Node 22.6+ ：https://nodejs.org
  exit /b 2
)

node "%~dp0scripts\setup.mjs" %*
exit /b %errorlevel%
