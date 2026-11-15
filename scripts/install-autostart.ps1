# Enable / disable auto-start at user logon (hidden window).
# Usage:
#   npm run autostart                # install
#   npm run autostart -- --remove    # uninstall
#
# NOTE: ASCII-only on purpose: Windows PowerShell 5.1 reads .ps1 as ANSI and
# non-ASCII characters can break parsing without a UTF-8 BOM.

param([switch]$remove)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$taskName = 'ProfessionSearchAgent'

if ($remove) {
  schtasks /Delete /TN $taskName /F 2>$null | Out-Null
  Write-Host "[OK] Auto-start removed ($taskName)" -ForegroundColor Green
  exit 0
}

$bat = Join-Path $root 'start.bat'
if (-not (Test-Path $bat)) {
  Write-Host "[X] start.bat not found: $bat" -ForegroundColor Red
  exit 1
}

# Wrap in a hidden-window VBS so logon does not pop a console window.
$vbs = Join-Path $root 'scripts\start-hidden.vbs'
$content = @"
Set WshShell = CreateObject("WScript.Shell")
WshShell.Run """" & "$bat" & """", 0, False
"@
Set-Content -Path $vbs -Value $content -Encoding ASCII

$command = "wscript.exe ""$vbs"""
schtasks /Create /TN $taskName /TR $command /SC ONLOGON /RL LIMITED /F | Out-Null

Write-Host "[OK] Auto-start installed: app starts hidden at logon." -ForegroundColor Green
Write-Host "     Open http://localhost:3000 manually."
Write-Host "     Remove with: npm run autostart -- --remove"
