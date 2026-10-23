#!/usr/bin/env bash
# =============================================================================
# 一键启动（macOS / Linux）：对应 F-01 的 T1 与 AC-1
# 等价于：node scripts/setup.mjs "$@"
# =============================================================================
set -euo pipefail

cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "[X] 未检测到 Node.js，请先安装 Node 22.6+：https://nodejs.org"
  exit 2
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "[X] Node.js 版本过低（$(node -v)），需要 22.6+"
  exit 2
fi

exec node scripts/setup.mjs "$@"
