#!/bin/bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "请先安装 Node.js（包含 npm），然后重新双击 start.command。" >&2
  exit 1
fi

if [ ! -x node_modules/.bin/esbuild ] || [ ! -d node_modules/puppeteer-core ]; then
  npm install
fi

npm run build
exec node tools/serve.mjs --open
