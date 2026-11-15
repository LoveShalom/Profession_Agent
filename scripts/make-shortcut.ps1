# Create a desktop shortcut for one-click local start.
# Usage: npm run shortcut
#
# NOTE: This file is intentionally pure ASCII. Windows PowerShell 5.1 reads
# .ps1 files as ANSI (GBK on zh-CN) unless they have a UTF-8 BOM, so non-ASCII
# characters here can break parsing. Keep it ASCII-only.

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$desktop = [Environment]::GetFolderPath('Desktop')
$target = Join-Path $root 'start.bat'

if (-not (Test-Path $target)) {
  Write-Host "[X] start.bat not found: $target" -ForegroundColor Red
  exit 1
}

$linkPath = Join-Path $desktop 'Profession Search Agent.lnk'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($linkPath)
$shortcut.TargetPath = $target
$shortcut.WorkingDirectory = $root
$shortcut.Description = 'Profession Search Agent - local start'
$shortcut.WindowStyle = 1
$shortcut.Save()

Write-Host "[OK] Shortcut created: $linkPath" -ForegroundColor Green
Write-Host "     Double-click it to start (first run builds, 1-2 minutes)."
