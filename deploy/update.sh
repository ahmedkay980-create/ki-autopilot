#!/bin/sh
# Täglich um 03:30: neue Version von GitHub holen und neu starten – nur wenn es Änderungen gibt.
set -e
cd /opt/ki-autopilot
git fetch -q origin main
if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]; then
  git reset -q --hard origin/main
  docker compose up -d --build
  docker image prune -f >/dev/null 2>&1 || true
  echo "$(date '+%F %T') aktualisiert auf $(git rev-parse --short HEAD)"
fi
