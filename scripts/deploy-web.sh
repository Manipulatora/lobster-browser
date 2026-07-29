#!/usr/bin/env bash
#
# Build the marketing site and publish it to nginx.
#
#   ./scripts/deploy-web.sh
#
# The site is a pure static build (Angular SSG): every route is prerendered to its own
# index.html, so there is no server process to restart — publishing is just a file sync.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="$ROOT/apps/web"
SRC="$APP/dist/web/browser"
DST="/var/www/lobster"

echo "==> Building $APP"
cd "$APP"
npm run build

if [[ ! -f "$SRC/index.html" ]]; then
  echo "!! build produced no index.html at $SRC — aborting before touching the live site" >&2
  exit 1
fi

echo "==> Publishing to $DST"
# --delete removes files from previous deploys; the check above guards against syncing an
# empty/failed build over the live site.
sudo rsync -a --delete "$SRC"/ "$DST"/
sudo chown -R www-data:www-data "$DST"

echo "==> Reloading nginx"
sudo nginx -t
sudo systemctl reload nginx

echo "==> Verifying"
for path in / /pricing /auth/sign-in; do
  code=$(curl -s -o /dev/null -w "%{http_code}" -L --resolve "lobrowser.com:443:127.0.0.1" --resolve "lobrowser.com:80:127.0.0.1" "http://lobrowser.com$path")
  printf '    %-20s %s\n' "$path" "$code"
  [[ "$code" == "200" ]] || { echo "!! $path returned $code" >&2; exit 1; }
done

echo "==> Done."
