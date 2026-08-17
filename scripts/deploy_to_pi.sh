#!/usr/bin/env bash
# Sync this repo to the Raspberry Pi and restart the backend service.
#
# Usage: scripts/deploy_to_pi.sh [host] [remote_dir]
#   host        SSH host/alias (default: rpi2b.local -- the bare `rpi2b`
#               alias is not network-resolvable, per the first Pi deployment)
#   remote_dir  destination path on the Pi (default: /home/seondizon/fpv-tuner)
set -euo pipefail

HOST="${1:-rpi2b.local}"
REMOTE_DIR="${2:-/home/seondizon/fpv-tuner}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

rsync -avz --delete \
  --exclude '.venv' \
  --exclude 'vendor' \
  --exclude 'backend/data' \
  --exclude '__pycache__' \
  --exclude '.pytest_cache' \
  --exclude '.git' \
  --exclude '.DS_Store' \
  --exclude '.claude' \
  "$REPO_ROOT/" "$HOST:$REMOTE_DIR/"

echo "Synced to $HOST:$REMOTE_DIR"
echo "Restarting fpv-tuner.service..."
ssh "$HOST" "sudo systemctl restart fpv-tuner.service && systemctl is-active fpv-tuner.service"
