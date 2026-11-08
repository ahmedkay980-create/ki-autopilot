#!/bin/sh
# Neue Version von GitHub holen und neu starten – nur wenn es Änderungen gibt.
# Läuft nachts um 03:30 und sofort, wenn in der App „Update jetzt einspielen“ getippt wurde.
set -e
cd /opt/ki-autopilot
git fetch -q origin main
if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ] || [ ! -f data/version.txt ]; then
  git reset -q --hard origin/main
  docker compose up -d --build
  docker image prune -f >/dev/null 2>&1 || true
  mkdir -p data
  echo "$(git rev-parse --short=7 HEAD) $(date '+%d.%m.%Y %H:%M')" > data/version.txt
  echo "$(date '+%F %T') aktualisiert auf $(git rev-parse --short=7 HEAD)"
fi
