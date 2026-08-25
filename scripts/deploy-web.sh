#!/usr/bin/env bash
#
# Build the marketing site and publish it to nginx.
#
#   ./scripts/deploy-web.sh              build, publish, verify
#   ./scripts/deploy-web.sh --rollback   repoint at the previous release
#
# The site is a pure static build (Angular SSG): every route is prerendered to its own
# index.html, so there is no server process to restart — publishing is just a file sync.
#
# Releases are staged into their own directory and the live path is a SYMLINK that gets swapped.
# `rsync --delete` straight over the live root, which is what this did before, is not atomic: for
# the length of the sync the site is a mix of two builds, and an index.html that references asset
# hashes not yet written is a blank page for every visitor who lands in that window. It also leaves
# nothing to go back to — a bad build had to be fixed forward with another full build.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="$ROOT/apps/web"
SRC="$APP/dist/web/browser"
# The `root` in deploy/nginx/lobster-site.conf. nginx resolves it per request and keeps no open-file
# cache by default, so replacing the symlink switches every subsequent request at once.
LIVE="/var/www/lobster"
RELEASES="/var/www/lobster-releases"
# Enough history to step back past a bad release without unbounded growth on a small VPS.
KEEP=5

verify() {
    echo "==> Verifying"
    # /download is prerendered like the rest and is the navbar's primary call to action,
    # so a release that 404s it is a broken release even though the home page serves.
    for path in / /pricing /download /auth/sign-in; do
        code=$(curl -s -o /dev/null -w "%{http_code}" -L --resolve "lobrowser.com:443:127.0.0.1" --resolve "lobrowser.com:80:127.0.0.1" "http://lobrowser.com$path")
        printf '    %-20s %s\n' "$path" "$code"
        [[ "$code" == "200" ]] || return 1
    done
}

reload_nginx() {
    sudo nginx -t
    sudo systemctl reload nginx
}

if [[ "${1:-}" == "--rollback" ]]; then
    current="$(readlink -f "$LIVE" || true)"
    # Second-newest by name; the directories are timestamp-named, so lexical order is chronological.
    previous="$(find "$RELEASES" -maxdepth 1 -mindepth 1 -type d | sort -r | sed -n 2p)"
    if [[ -z "$previous" ]]; then
        echo "!! no previous release under $RELEASES — nothing to roll back to" >&2
        exit 1
    fi
    echo "==> Rolling back"
    echo "    from $current"
    echo "    to   $previous"
    sudo ln -sfn "$previous" "$LIVE"
    reload_nginx
    verify || { echo "!! the previous release does not serve either — the fault is not in the build" >&2; exit 1; }
    echo "==> Done."
    exit 0
fi

echo "==> Building $APP"
cd "$APP"
npm run build

if [[ ! -f "$SRC/index.html" ]]; then
    echo "!! build produced no index.html at $SRC — aborting before touching the live site" >&2
    exit 1
fi

release="$RELEASES/$(date -u +%Y%m%d%H%M%S)"
echo "==> Staging $release"
sudo install -d "$RELEASES"
sudo rsync -a --delete "$SRC"/ "$release"/
sudo chown -R www-data:www-data "$release"

# One-time migration off the pre-symlink layout: if $LIVE is still a real directory, keep it as the
# rollback target rather than deleting a site that is currently serving.
if [[ -d "$LIVE" && ! -L "$LIVE" ]]; then
    echo "==> Converting $LIVE from a directory to a release symlink"
    sudo mv "$LIVE" "$RELEASES/00000000000000-preexisting"
fi

previous="$(readlink -f "$LIVE" 2>/dev/null || true)"
echo "==> Publishing"
# ln -sfn writes the new symlink to a temp name and renames it over the old one, so there is no
# instant where $LIVE does not exist.
sudo ln -sfn "$release" "$LIVE"
reload_nginx

if ! verify; then
    echo "!! the new release does not serve — rolling back" >&2
    if [[ -n "$previous" && -d "$previous" ]]; then
        sudo ln -sfn "$previous" "$LIVE"
        reload_nginx
        echo "!! reverted to $previous" >&2
    else
        echo "!! no previous release to revert to; $LIVE still points at $release" >&2
    fi
    exit 1
fi

# Prune only after a verified publish, and never the release that is live.
mapfile -t stale < <(find "$RELEASES" -maxdepth 1 -mindepth 1 -type d | sort -r | tail -n +$((KEEP + 1)))
for d in "${stale[@]:-}"; do
    [[ -n "$d" && "$d" != "$release" ]] || continue
    echo "==> Pruning $d"
    sudo rm -rf "$d"
done

echo "==> Done."
