#!/usr/bin/env bash
# Build and ship to https://thecampfire.elifrigo.com (host "william": nginx serves dist/ and
# proxies /ws to the thecampfire systemd service). The world save in ~/thecampfire/saves is kept.
#   ./deploy.sh          client + server (restarts the server: players reconnect)
#   ./deploy.sh client   client only (no restart)
set -euo pipefail
cd "$(dirname "$0")"
export PATH="$HOME/.local/node/bin:$PATH"
npx vite build
rsync -az --delete dist william:thecampfire/
[ "${1:-}" = client ] && { echo "client deployed"; exit 0; }
rsync -az --delete server shared package.json package-lock.json william:thecampfire/
ssh william 'cd ~/thecampfire && npm ci --omit=dev --silent && sudo systemctl restart thecampfire && sleep 1 && systemctl is-active thecampfire'
echo "deployed"
