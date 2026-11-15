@echo off
chcp 65001 >nul
title Profession Search Agent
setlocal
cd /d "%~dp0"
REM ============================================================================
REM One-click local start (Windows). Keep this file ASCII-only + CRLF:
REM   cmd parses batch files byte-wise using the console code page; UTF-8 CJK
REM   bytes break parsing (seen: fragments like own / vel / https:).
REM
REM   start.bat              : db + migrate + build(first run) + open browser
REM   start.bat --lan        : allow LAN access (phone/tablet)
REM   start.bat --rebuild    : force rebuild after code changes
REM   start.bat --setup-only : prepare environment only, do not start app
REM ============================================================================

where node >nul 2>nul
if errorlevel 1 goto no_node

echo.
echo   Profession Search Agent - local start
echo   ------------------------------------------------
node "%~dp0scripts\local-start.mjs" %*
set "EXIT_CODE=%errorlevel%"

if not "%EXIT_CODE%"=="0" goto failed
exit /b 0

:no_node
echo [X] Node.js not found. Install Node 20+ from https://nodejs.org
pause
exit /b 2

:failed
echo.
echo [X] Start failed. See the error above, or run: npm run preflight
pause
exit /b 1
