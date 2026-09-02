#!/usr/bin/env bash
#
# Build the backend and put a complete release on the box — or tell you whether the one that is
# running is healthy. Run it from a checkout on the box.
#
#   ./deploy/deploy-backend.sh              build, stage, verify, restart; rolls back by itself on failure
#   ./deploy/deploy-backend.sh --migrate    the same, applying pending Prisma migrations first
#   ./deploy/deploy-backend.sh --dry-run    print every step it would take; change nothing
#   ./deploy/deploy-backend.sh --check      health only: is the running backend ready?
#   ./deploy/deploy-backend.sh --rollback   put the previous release back and restart
#
# Also: --skip-install (no `npm ci` first), --allow-dirty (deploy uncommitted changes, marked as such).
#
# WHY A SCRIPT. The documented release used to be four lines: build, stop, rsync dist/, start. It
# shipped dist/ and nothing else. But dist/main.js loads @lobster/shared-types and @lobster/crypto
# from node_modules, and on the box those are COPIES of the workspace packages, not symlinks into a
# checkout; and `prisma migrate deploy` reads the migrations that sit beside dist/ on the box, not
# the ones in the repo. So a change to a shared package or to the schema built cleanly, deployed
# cleanly, passed the readiness probe, and failed on the first request that reached the stale copy.
# That happened on 2026-09-01. Everything the running process can load is now staged together as
# ONE release — dist/, prisma/, the workspace packages the backend depends on (derived from
# apps/backend/package.json, so a new one ships the first time it is used), and the generated
# Prisma client with its runtime — and the switch is atomic where the layout allows it.
#
# TWO LAYOUTS, detected from what $LOBSTER_DEPLOY_ROOT/backend is:
#   symlink    -> releases/<stamp>. Every release is a complete tree (third-party packages are
#                 hardlinked from the release before it, so a release costs only what changed); the
#                 flip is one `ln -sfn` and rollback is the same flip back.
#   directory  The layout the box has today: root-owned, dist/ owned by the deploying user. The
#                 release is staged exactly the same way and then rsynced INTO the directory — dist/
#                 without sudo, the rest with it — after keeping what it replaces in
#                 backend.previous/ for rollback. deploy/README.md has the one-time conversion.
#
# Overridable, for another box or the test harness (deploy/deploy-backend.test.mjs):
#   LOBSTER_DEPLOY_ROOT       /opt/lobster
#   LOBSTER_BACKEND_ENV_FILE  /etc/lobster/backend.env
#   LOBSTER_BACKEND_UNIT      lobster-backend
#   LOBSTER_HEALTH_ORIGIN     http://127.0.0.1:8080
#   LOBSTER_READY_TIMEOUT     60     seconds to wait for /health/ready after a restart
#   LOBSTER_KEEP_RELEASES     5
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND="$ROOT/apps/backend"
PRISMA="$ROOT/node_modules/.bin/prisma"

DEPLOY_ROOT="${LOBSTER_DEPLOY_ROOT:-/opt/lobster}"
LIVE="$DEPLOY_ROOT/backend"
RELEASES="$DEPLOY_ROOT/releases"
PREVIOUS="$DEPLOY_ROOT/backend.previous"
DEPLOY_LOG="$DEPLOY_ROOT/deploy.log"
ENV_FILE="${LOBSTER_BACKEND_ENV_FILE:-/etc/lobster/backend.env}"
UNIT="${LOBSTER_BACKEND_UNIT:-lobster-backend}"
ORIGIN="${LOBSTER_HEALTH_ORIGIN:-http://127.0.0.1:8080}"
READY_TIMEOUT="${LOBSTER_READY_TIMEOUT:-60}"
KEEP="${LOBSTER_KEEP_RELEASES:-5}"
STAMP="$(date -u +%Y%m%d%H%M%S)"

# What a release is made of, relative to its root. `stage` produces exactly this and `copy_set`
# moves exactly this between a release and a live directory, in either direction — one list, so
# the set that is deployed and the set that is rolled back cannot disagree. The generated Prisma
# client and its runtime are in it because they are the schema's compiled twin: a migration that
# adds a column is useless to a client generated before it. The workspace packages are appended
# once they have been derived from the manifests.
SET_DIRS=(dist prisma node_modules/.prisma/client node_modules/@prisma/client)
SET_FILES=(package.json RELEASE)
PKG_NAMES=()
PKG_DIRS=()
PKG_MAINS=()
PKG_PATHS=()

DRY_RUN=0
MIGRATE=0
SKIP_INSTALL=0
ALLOW_DIRTY=0
MODE=deploy

usage() {
    # The header comment is the usage text; keeping one copy means it cannot go stale.
    sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'
}

for arg in "$@"; do
    case "$arg" in
        --dry-run) DRY_RUN=1 ;;
        --check) MODE=check ;;
        --rollback) MODE=rollback ;;
        --migrate) MIGRATE=1 ;;
        --skip-install) SKIP_INSTALL=1 ;;
        --allow-dirty) ALLOW_DIRTY=1 ;;
        -h | --help)
            usage
            exit 0
            ;;
        *)
            usage >&2
            echo "!! unknown option: $arg" >&2
            exit 2
            ;;
    esac
done

log() { printf '==> %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }
warn() { printf '!! %s\n' "$*" >&2; }
die() {
    warn "$@"
    exit 1
}

# Every command that changes the box goes through here, so --dry-run is the real code path with the
# execution removed rather than a second script that drifts from the first.
run() {
    if ((DRY_RUN)); then
        printf '    $ %s\n' "$(printf '%q ' "$@")"
        return 0
    fi
    "$@"
}

SUDO=sudo
if [[ "$(id -u)" == 0 ]]; then SUDO=; fi

as_root() {
    if [[ -n "$SUDO" ]]; then run "$SUDO" "$@"; else run "$@"; fi
}

# sudo only where the filesystem demands it. Under the directory layout dist/ is owned by the
# deploying user precisely so it can be refreshed without root, and keeping that true keeps the
# blast radius of a wrong path to files that user owns. The decision is made on the first existing
# ancestor of the target, which is what decides whether a create or a replace there is allowed.
as_owner() {
    local target=$1 probe=$1
    shift
    while [[ ! -e "$probe" && "$probe" != / ]]; do probe=$(dirname "$probe"); done
    if [[ -w "$probe" ]]; then run "$@"; else as_root "$@"; fi
}

layout() {
    if [[ -L "$LIVE" ]]; then
        echo symlink
    elif [[ -d "$LIVE" ]]; then
        echo directory
    else
        echo absent
    fi
}

# One line per outcome in $DEPLOY_LOG: the box's own memory of what was deployed, by whom, and how
# it ended, for the day the journal has rotated and nobody remembers.
record() {
    local line
    line="$(date -u +%Y-%m-%dT%H:%M:%SZ) $(id -un) $*"
    if ((DRY_RUN)); then
        note "log: $line"
        return 0
    fi
    printf '%s\n' "$line" | $SUDO tee -a "$DEPLOY_LOG" >/dev/null || true
}

# --- health ----------------------------------------------------------------------------------------

http_code() {
    curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "$1" 2>/dev/null || true
}

# `systemctl restart` already blocks on the unit's ExecStartPost, which polls /health/ready itself;
# this poll is the second opinion from outside the unit, and the one whose failure triggers the
# rollback. Bounded, because a deploy that hangs is a deploy nobody can act on.
wait_ready() {
    if ((DRY_RUN)); then
        note "poll $ORIGIN/health/ready for up to ${READY_TIMEOUT}s"
        return 0
    fi
    local deadline=$((SECONDS + READY_TIMEOUT)) code=
    while ((SECONDS < deadline)); do
        code=$(http_code "$ORIGIN/health/ready")
        if [[ "$code" == 200 ]]; then
            note "ready: $ORIGIN/health/ready -> 200"
            return 0
        fi
        sleep 1
    done
    warn "$ORIGIN/health/ready did not answer 200 within ${READY_TIMEOUT}s (last answer: ${code:-none})"
    return 1
}

check_health() {
    local path code body ok=1
    log "Health of $UNIT at $ORIGIN"
    for path in /health /health/ready; do
        code=$(http_code "$ORIGIN$path")
        body=$(curl -sS --max-time 5 "$ORIGIN$path" 2>/dev/null || true)
        printf '    %-14s %s  %s\n' "$path" "$code" "$body"
        [[ "$code" == 200 ]] || ok=0
    done
    case "$(layout)" in
        symlink) note "live release: $(readlink -f "$LIVE")" ;;
        directory) note "live tree: $LIVE (directory layout)" ;;
        absent) note "no live tree at $LIVE" ;;
    esac
    if [[ -r "$LIVE/RELEASE" ]]; then sed 's/^/    /' "$LIVE/RELEASE"; fi
    ((ok)) || return 1
}

# --- what the backend is made of --------------------------------------------------------------------

# The @lobster packages the backend loads at runtime, dependencies before dependents. Derived from
# the manifests rather than listed here, so a new workspace dependency ships the first time it is
# used instead of the first time production fails without it.
workspace_closure() {
    node - "$ROOT" <<'JS'
const fs = require('node:fs');
const path = require('node:path');
const root = process.argv[2];
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const byName = new Map();
for (const dir of read(path.join(root, 'package.json')).workspaces) {
  const file = path.join(root, dir, 'package.json');
  if (fs.existsSync(file)) byName.set(read(file).name, { dir, pkg: read(file) });
}
const order = [];
const seen = new Set();
const visit = (name) => {
  if (seen.has(name)) return;
  seen.add(name);
  const entry = byName.get(name);
  if (!entry) throw new Error(`${name} is not a workspace of ${root}`);
  for (const dep of Object.keys(entry.pkg.dependencies ?? {})) if (dep.startsWith('@lobster/')) visit(dep);
  order.push(name);
};
const backend = read(path.join(root, 'apps/backend/package.json'));
for (const dep of Object.keys(backend.dependencies ?? {})) if (dep.startsWith('@lobster/')) visit(dep);
for (const name of order) {
  const { dir, pkg } = byName.get(name);
  process.stdout.write(`${name}\t${dir}\t${pkg.main ?? 'dist/index.js'}\n`);
}
JS
}

load_workspace_closure() {
    local name dir main
    while IFS=$'\t' read -r name dir main; do
        PKG_NAMES+=("$name")
        PKG_DIRS+=("$dir")
        PKG_MAINS+=("$main")
        PKG_PATHS+=("node_modules/$name")
    done < <(workspace_closure)
    ((${#PKG_NAMES[@]})) || die "apps/backend/package.json names no @lobster/* dependency; that is not the backend this script knows"
}

# Every third-party package the backend or a shipped workspace package imports, with the version
# this checkout builds against and the version the runtime tree holds. The runtime tree is not
# produced by this script (it is installed once, by hand — deploy/README.md), so it is the one
# thing a release can silently outgrow; missing is fatal, a different version is reported.
runtime_dependency_report() {
    node - "$ROOT" "$1" apps/backend ${PKG_DIRS[@]+"${PKG_DIRS[@]}"} <<'JS'
const fs = require('node:fs');
const path = require('node:path');
const [root, runtime, ...dirs] = process.argv.slice(2);
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
// Shipped inside the release itself, so its presence in the live tree is not a precondition.
const shipped = new Set(['@prisma/client']);
// Node's own lookup: the nearest node_modules walking up from the importer. npm nests a package
// under apps/backend/node_modules when the root tree holds a conflicting version, and that nested
// copy is the one the backend was built against — the flat runtime tree has to carry it too.
const resolveHere = (name, from) => {
  for (let dir = from; ; dir = path.dirname(dir)) {
    const file = path.join(dir, 'node_modules', name, 'package.json');
    if (fs.existsSync(file)) return read(file).version ?? '?';
    if (path.dirname(dir) === dir) return null;
  }
};
const wanted = new Map();
for (const dir of dirs) {
  for (const dep of Object.keys(read(path.join(root, dir, 'package.json')).dependencies ?? {})) {
    if (dep.startsWith('@lobster/') || shipped.has(dep) || wanted.has(dep)) continue;
    wanted.set(dep, path.join(root, dir));
  }
}
for (const [dep, from] of [...wanted].sort(([a], [b]) => a.localeCompare(b))) {
  const here = resolveHere(dep, from);
  const file = path.join(runtime, dep, 'package.json');
  const there = fs.existsSync(file) ? (read(file).version ?? '?') : null;
  const status =
    there === null ? 'missing' : here === null ? 'unresolved' : there === here ? 'ok' : 'differs';
  process.stdout.write(`${status}\t${dep}\t${here ?? '-'}\t${there ?? '-'}\n`);
}
JS
}

verify_runtime_dependencies() {
    local runtime="$LIVE_TARGET/node_modules" status name here there missing=0
    if [[ -z "$LIVE_TARGET" || ! -d "$runtime" ]]; then
        ((DRY_RUN)) && {
            note "runtime dependency check skipped: $runtime does not exist"
            return 0
        }
        die "$runtime does not exist; the third-party tree is installed once by hand (deploy/README.md, 'Third-party dependencies')"
    fi
    log "Checking third-party dependencies in $runtime"
    while IFS=$'\t' read -r status name here there; do
        case "$status" in
            missing)
                warn "$name is not in $runtime (this checkout builds against $here)"
                missing=1
                ;;
            differs) note "$name: $there on the box, $here in this checkout" ;;
            unresolved) note "$name: $there on the box; not resolvable from this checkout (has npm ci run here?)" ;;
        esac
    done < <(runtime_dependency_report "$runtime")
    ((missing == 0)) || die "the runtime tree lacks packages the backend loads; refresh it as deploy/README.md describes, then deploy again"
}

# --- preflight --------------------------------------------------------------------------------------

preflight() {
    LAYOUT=$(layout)
    LIVE_TARGET=
    PREVIOUS_TARGET=
    case "$LAYOUT" in
        symlink)
            LIVE_TARGET=$(readlink -f "$LIVE")
            PREVIOUS_TARGET=$LIVE_TARGET
            note "layout: symlink, $LIVE -> $LIVE_TARGET"
            ;;
        directory)
            LIVE_TARGET=$LIVE
            note "layout: directory, $LIVE (the replaced set is kept in $PREVIOUS)"
            ;;
        absent)
            if ((DRY_RUN)); then
                warn "$LIVE does not exist; a real run stops here. Printing the symlink-layout plan."
                LAYOUT=symlink
            else
                die "$LIVE does not exist. This script refreshes an installed backend; the first install (unit, env file, third-party node_modules) is in deploy/README.md"
            fi
            ;;
    esac

    REVISION=$(git -C "$ROOT" rev-parse --short=12 HEAD 2>/dev/null || echo unknown)
    BRANCH=$(git -C "$ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)
    local dirty
    dirty=$(git -C "$ROOT" status --porcelain --untracked-files=no 2>/dev/null || true)
    if [[ -n "$dirty" ]]; then
        REVISION="$REVISION-dirty"
        if ((ALLOW_DIRTY)); then
            warn "tracked files have uncommitted changes; the release is marked $REVISION"
        elif ((DRY_RUN)); then
            warn "tracked files have uncommitted changes; a real run refuses this without --allow-dirty"
        else
            # A release nobody can check out again is a release nobody can reason about when it
            # misbehaves. Commit or stash; --allow-dirty exists for the hotfix that cannot wait.
            die "tracked files have uncommitted changes; commit them, or pass --allow-dirty to ship them marked as such"
        fi
    fi
    note "revision: $REVISION ($BRANCH)"

    for tool in rsync curl node; do
        command -v "$tool" >/dev/null || die "$tool is required"
    done
    if [[ ! -x "$PRISMA" ]] && ((!DRY_RUN)); then
        die "$PRISMA is missing; run npm ci first"
    fi
    if [[ -n "$SUDO" ]] && ((!DRY_RUN)); then
        # One prompt up front, not one in the middle of a restart.
        # `sudo -v` asks for a password whenever ANY rule for this user could require one, even
        # when the commands the script runs are all NOPASSWD — and a non-interactive deploy has no
        # terminal to type it into. `-n true` proves the same thing without ever prompting: it
        # succeeds only when the rules let this user through unattended, and fails fast otherwise.
        sudo -n true 2>/dev/null || die "sudo needs a password for $(id -un); run from a terminal or grant NOPASSWD for the deploy commands"
    fi

    load_workspace_closure
    note "workspace packages: ${PKG_NAMES[*]}"
    local i
    for i in "${!PKG_NAMES[@]}"; do
        SET_DIRS+=("${PKG_PATHS[$i]}")
    done
}

# --- build ------------------------------------------------------------------------------------------

build() {
    log "Building in $ROOT"
    cd "$ROOT"
    if ((SKIP_INSTALL)); then
        note "npm ci skipped (--skip-install)"
    else
        run npm ci --no-audit --no-fund
    fi
    # `nest build` compiles against the generated Prisma client, and nothing in the build script
    # generates it: without this a schema change either fails the build or, worse, builds against a
    # client generated from an older schema that happens to be lying in node_modules.
    run env CHECKPOINT_DISABLE=1 "$PRISMA" generate --schema "$BACKEND/prisma/schema.prisma"
    local i
    for i in "${!PKG_NAMES[@]}"; do
        run npm run build --workspace "${PKG_NAMES[$i]}"
    done
    run npm run build --workspace @lobster/backend
    ((DRY_RUN)) && return 0
    [[ -f "$BACKEND/dist/main.js" ]] || die "the build produced no $BACKEND/dist/main.js; nothing was touched on the box"
    for i in "${!PKG_NAMES[@]}"; do
        [[ -f "$ROOT/${PKG_DIRS[$i]}/${PKG_MAINS[$i]}" ]] || die "${PKG_NAMES[$i]} built no ${PKG_MAINS[$i]}; nothing was touched on the box"
    done
    [[ -d "$ROOT/node_modules/.prisma/client" ]] || die "prisma generate left no node_modules/.prisma/client"
}

# --- staging ----------------------------------------------------------------------------------------

# rsync SRC/ over DST/: create DST, replace a symlink at DST first (an @lobster entry copied out of a
# checkout's node_modules is a symlink into a packages/ dir that does not exist on the box, and
# rsync would follow it nowhere), and delete what SRC does not have — including entries the filter
# hides, so a stale src/ or node_modules/ copy inside a package goes too. --checksum because the
# default quick check (same size, same mtime to the second) is a heuristic, and a deploy is not
# the place for one: a rebuilt file of the same length in the same second as the copy on the box
# would be left as it was. The trees here are small enough that reading both sides costs nothing.
place_dir() {
    local src=$1 dst=$2
    shift 2
    if ((!DRY_RUN)) && [[ ! -d "$src" ]]; then die "$src is missing"; fi
    if [[ -L "$dst" ]]; then as_owner "$(dirname "$dst")" rm -f "$dst"; fi
    as_owner "$dst" install -d "$dst"
    as_owner "$dst" rsync -a --checksum --delete --delete-excluded "$@" "$src/" "$dst/"
}

place_file() {
    local src=$1 dst=$2
    as_owner "$dst" install -m 644 "$src" "$dst"
}

# Move the release set from one tree to another. Used for release -> live (deploy, directory
# layout), live -> backend.previous (keep what is being replaced) and backend.previous -> live
# (rollback); the same function in all three directions is what makes the rollback trustworthy.
copy_set() {
    local src=$1 dst=$2 item
    for item in "${SET_DIRS[@]}"; do
        if ((DRY_RUN)) || [[ -d "$src/$item" ]]; then
            place_dir "$src/$item" "$dst/$item"
        else
            note "$src/$item is absent; skipped"
        fi
    done
    for item in "${SET_FILES[@]}"; do
        if ((DRY_RUN)) || [[ -f "$src/$item" ]]; then place_file "$src/$item" "$dst/$item"; fi
    done
}

write_release_file() {
    local content
    content=$(printf 'release=%s\nrevision=%s\nbranch=%s\nlayout=%s\ndeployed_at=%s\ndeployed_by=%s@%s\npackages=%s\n' \
        "$STAMP" "$REVISION" "$BRANCH" "$LAYOUT" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        "$(id -un)" "${HOSTNAME:-unknown}" "$(
            IFS=,
            echo "${PKG_NAMES[*]}"
        )")
    if ((DRY_RUN)); then
        note "write $RELEASE/RELEASE:"
        printf '%s\n' "$content" | sed 's/^/        /'
        return 0
    fi
    printf '%s\n' "$content" | $SUDO tee "$RELEASE/RELEASE" >/dev/null
}

stage() {
    RELEASE="$RELEASES/$STAMP"
    log "Staging $RELEASE"
    as_root install -d -m 755 "$RELEASES" "$RELEASE"
    if [[ "$LAYOUT" == symlink ]]; then
        if [[ -d "$LIVE_TARGET/node_modules" ]]; then
            # A complete tree per release, so one flip switches everything and rollback copies
            # nothing. Third-party packages are hardlinked from the live release (same inodes, no
            # extra space; both trees are under $DEPLOY_ROOT, hence one filesystem). rsync writes a
            # changed file under a temporary name and renames it over the link, so refreshing a
            # package here never reaches into the release that is still serving.
            as_root cp -al "$LIVE_TARGET/node_modules" "$RELEASE/node_modules"
        else
            note "no live node_modules at $LIVE_TARGET/node_modules to clone; the release gets only what this script ships"
        fi
    fi
    as_root install -d -m 755 "$RELEASE/node_modules/@lobster" "$RELEASE/node_modules/.prisma" "$RELEASE/node_modules/@prisma"
    place_dir "$BACKEND/dist" "$RELEASE/dist"
    place_dir "$BACKEND/prisma" "$RELEASE/prisma"
    place_file "$BACKEND/package.json" "$RELEASE/package.json"
    local i
    for i in "${!PKG_NAMES[@]}"; do
        # What `npm pack` would ship: the manifest and the build output, nothing from src/.
        place_dir "$ROOT/${PKG_DIRS[$i]}" "$RELEASE/${PKG_PATHS[$i]}" \
            --include='/package.json' --include='/dist/***' --exclude='*'
    done
    place_dir "$ROOT/node_modules/.prisma/client" "$RELEASE/node_modules/.prisma/client"
    place_dir "$ROOT/node_modules/@prisma/client" "$RELEASE/node_modules/@prisma/client"
    write_release_file
}

# --- migrations -------------------------------------------------------------------------------------

# One value out of the unit's EnvironmentFile. The file is root:lobster 0640 on purpose, so reading
# it takes sudo; only the requested value is kept, in this shell's memory, and it reaches Prisma
# through its environment, never on a command line where `ps` could show it. The file is never
# sourced: an EnvironmentFile is not shell, and executing it as one would be the wrong surprise.
env_value() {
    local name=$1 content value
    content=$($SUDO cat "$ENV_FILE")
    value=$(sed -n "/^${name}=/{s/^${name}=//;p;q}" <<<"$content")
    value=${value%$'\r'}
    if [[ $value == \"*\" && $value == *\" ]]; then
        value=${value#\"}
        value=${value%\"}
    elif [[ $value == \'*\' && $value == *\' ]]; then
        value=${value#\'}
        value=${value%\'}
    fi
    printf '%s' "$value"
}

# Migrations run against the schema and migrations dir of the release being deployed, BEFORE the
# switch, so the new code finds its columns the moment it starts. Without --migrate the database is
# only checked: code that expects a column the database does not have is exactly the failure this
# script exists to prevent, and it must stop here, before anything is published.
migrate() {
    local schema="$RELEASE/prisma/schema.prisma" url
    if ((DRY_RUN)); then
        note "read DATABASE_URL from $ENV_FILE (sudo)"
        if ((MIGRATE)); then
            note "\$ $PRISMA migrate deploy --schema $schema"
        else
            note "\$ $PRISMA migrate status --schema $schema   (stop if migrations are pending)"
        fi
        return 0
    fi
    url=$(env_value DATABASE_URL)
    [[ -n "$url" ]] || die "DATABASE_URL is not set in $ENV_FILE"
    if ((MIGRATE)); then
        log "Applying migrations from $RELEASE/prisma"
        DATABASE_URL="$url" CHECKPOINT_DISABLE=1 "$PRISMA" migrate deploy --schema "$schema" ||
            die "migrate deploy failed; nothing was published. Resolve the migration state (prisma migrate resolve) before deploying again"
    else
        log "Checking the database is at this release's schema"
        DATABASE_URL="$url" CHECKPOINT_DISABLE=1 "$PRISMA" migrate status --schema "$schema" ||
            die "the database is not at this release's schema; run npm run gate:migrations, then deploy again with --migrate"
    fi
}

# --- publish ----------------------------------------------------------------------------------------

restart_and_wait() {
    log "Restarting $UNIT"
    # A start-limit hit from an earlier failure would otherwise refuse the restart outright.
    as_root systemctl reset-failed "$UNIT" || true
    if ! as_root systemctl restart "$UNIT"; then
        warn "systemctl restart $UNIT failed (journalctl -u $UNIT -n 50 has the reason)"
        return 1
    fi
    wait_ready
}

rollback_after_failure() {
    warn "the new release is not serving; rolling back"
    local target
    if [[ "$LAYOUT" == symlink ]]; then
        if [[ -z "$PREVIOUS_TARGET" || ! -d "$PREVIOUS_TARGET" ]]; then
            warn "no previous release to revert to; $LIVE still points at $RELEASE"
            record "FAILED $RELEASE rev=$REVISION (no rollback target)"
            return 0
        fi
        target=$PREVIOUS_TARGET
        as_root ln -sfn "$target" "$LIVE"
    else
        target=$PREVIOUS
        copy_set "$target" "$LIVE"
    fi
    if restart_and_wait; then
        warn "reverted to $target; the failed release is kept at $RELEASE for inspection"
        record "FAILED $RELEASE rev=$REVISION; rolled back to $target"
    else
        warn "the previous release does not serve either; the fault is not in this build (env file, Postgres, journal)"
        record "FAILED $RELEASE rev=$REVISION; rollback to $target did not come up"
    fi
}

publish() {
    if [[ "$LAYOUT" == symlink ]]; then
        log "Publishing $RELEASE (was: ${PREVIOUS_TARGET:-none})"
        # ln -sfn writes the new link under a temporary name and renames it over the old one, so
        # there is no instant at which $LIVE does not resolve.
        as_root ln -sfn "$RELEASE" "$LIVE"
    else
        log "Keeping the set $RELEASE replaces in $PREVIOUS"
        copy_set "$LIVE" "$PREVIOUS"
        # The directory layout cannot switch atomically. Stop first so the old process cannot
        # lazy-load half of the new tree; the restart below starts it on the whole of it.
        log "Stopping $UNIT"
        as_root systemctl stop "$UNIT"
        log "Syncing $RELEASE into $LIVE"
        copy_set "$RELEASE" "$LIVE"
    fi
    if restart_and_wait; then
        record "deployed $RELEASE rev=$REVISION layout=$LAYOUT"
        return 0
    fi
    rollback_after_failure
    exit 1
}

# Only after a verified publish, and never the release that is live, the one it replaced, or the
# one just deployed. Enough history to step back past a bad release without unbounded growth.
prune_releases() {
    [[ -d "$RELEASES" ]] || return 0
    local live d
    live=$(readlink -f "$LIVE" 2>/dev/null || true)
    mapfile -t stale < <(find "$RELEASES" -maxdepth 1 -mindepth 1 -type d -name '[0-9]*' | sort -r | tail -n +$((KEEP + 1)))
    for d in ${stale[@]+"${stale[@]}"}; do
        [[ "$d" == "$RELEASE" || "$d" == "$live" || "$d" == "${PREVIOUS_TARGET:-}" ]] && continue
        log "Pruning $d"
        as_root rm -rf "$d"
    done
}

manual_rollback() {
    local target
    case "$LAYOUT" in
        symlink)
            # The newest release older than the live one, by name; stamps sort chronologically.
            target=$(find "$RELEASES" -maxdepth 1 -mindepth 1 -type d -name '[0-9]*' 2>/dev/null | sort -r |
                awk -v live="$LIVE_TARGET" 'found && !done { print; done = 1 } $0 == live { found = 1 }')
            [[ -n "$target" ]] || die "no release older than $LIVE_TARGET under $RELEASES"
            log "Rolling back $LIVE -> $target (was $LIVE_TARGET)"
            as_root ln -sfn "$target" "$LIVE"
            ;;
        directory)
            target=$PREVIOUS
            if ((!DRY_RUN)) && [[ ! -d "$target" ]]; then die "nothing to roll back to: $target does not exist"; fi
            log "Rolling back: restoring $target into $LIVE"
            as_root systemctl stop "$UNIT"
            copy_set "$target" "$LIVE"
            ;;
    esac
    if restart_and_wait; then
        record "rolled back to $target"
        log "Done: $target is live"
    else
        record "rollback to $target did not come up"
        die "$UNIT is not ready after the rollback"
    fi
}

# --- main -------------------------------------------------------------------------------------------

main() {
    if ((DRY_RUN)); then log "DRY RUN: nothing below is executed"; fi
    case "$MODE" in
        check)
            check_health
            ;;
        rollback)
            log "Rollback of $UNIT"
            preflight
            manual_rollback
            ;;
        deploy)
            log "Deploying the backend ($UNIT) to $LIVE"
            preflight
            note "migrations: $( ((MIGRATE)) && echo 'apply pending (--migrate)' || echo 'check only')"
            build
            verify_runtime_dependencies
            stage
            migrate
            publish
            prune_releases
            log "Done: $RELEASE is live (revision $REVISION)"
            ;;
    esac
}

main
