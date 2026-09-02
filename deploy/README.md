# Deployment

The production layout for `lobrowser.com` (marketing site + dashboard) and `api.lobrowser.com` (the
backend the desktop app and the dashboard both call). Everything the box runs is in this directory;
the point is that a lost host can be rebuilt from the repo instead of from memory.

## What talks to what

`api.lobrowser.com` is not a deployment detail — it is compiled into the shipped clients:

- the desktop app's `DEFAULT_API_ORIGIN` (`apps/desktop/src-tauri/src/cloud_auth.rs`)
- the web dashboard's `apiBaseUrl`, derived as `api.<hostname>` (`apps/web/src/app/app.config.ts`)

Changing the API hostname therefore requires a desktop release, not an nginx reload. `158-220-91-217.nip.io`
is still served because it is the backend's own `PUBLIC_BASE_URL`: verification and password-reset
links minted against it are live in inboxes, and it is the NOWPayments IPN callback registered with
the processor. Both vhosts proxy to the same service.

## Files

| Repo path                          | Installed as                                | Notes                                                    |
| ---------------------------------- | ------------------------------------------- | -------------------------------------------------------- |
| `nginx/lobster-limits.conf`        | `/etc/nginx/conf.d/lobster-limits.conf`     | http context — `limit_req_zone` and `server_tokens` are invalid inside a `server` block |
| `nginx/upgrade-map.conf`           | `/etc/nginx/conf.d/upgrade-map.conf`        | http context — defines `$connection_upgrade`             |
| `nginx/lobster-proxy.conf`         | `/etc/nginx/snippets/lobster-proxy.conf`    | included by every backend `location`                     |
| `nginx/lobster-backend.conf`       | `/etc/nginx/sites-available/lobster-backend`| symlink into `sites-enabled`                             |
| `nginx/lobster-site.conf`          | `/etc/nginx/sites-available/lobster-site`   | symlink into `sites-enabled`                             |
| `systemd/lobster-backend.service`  | `/etc/systemd/system/lobster-backend.service`| the unit both vhosts proxy to                           |

The two `conf.d` files must load before the vhosts that reference them; nginx reads `conf.d/*.conf`
from the http block in `nginx.conf` before `sites-enabled`, so the default Debian/Ubuntu layout does
this already. `nginx -t` catches the ordering if it does not.

## Backend

Runtime layout, matching the paths in `systemd/lobster-backend.service`:

| Path                            | Owner            | Holds                                              |
| ------------------------------- | ---------------- | -------------------------------------------------- |
| `/opt/lobster/backend`          | `root`           | the live release: a symlink into `releases/`, or — the layout the box has today — a real directory with `dist/` owned by the deploying user (see *Layouts* below) |
| `/opt/lobster/releases/<stamp>` | `root`           | one directory per deploy: `dist/`, `prisma/`, `package.json`, `node_modules/`, `RELEASE` |
| `/opt/lobster/backend.previous` | `root`           | directory layout only: the set the last deploy replaced, for rollback |
| `/opt/lobster/deploy.log`       | `root`           | one line per deploy, rollback and failure — who, when, which revision |
| `/etc/lobster/backend.env`      | `root:lobster` 0640 | every secret — see `apps/backend/.env.example`   |
| `/var/lib/lobster`              | `lobster`        | the profile blob store (`BLOB_STORE_PATH`)          |

Secrets live in `/etc`, never in the repo tree. A `.env` under `apps/backend` is a development
convenience only: the unit does not read it, and a directory backup of a working tree that contains
one carries `JWT_SECRET` and `DATABASE_URL` off the box with it.

First install:

```sh
sudo useradd --system --home /var/lib/lobster --shell /usr/sbin/nologin lobster
sudo install -d -o lobster -g lobster /var/lib/lobster
sudo install -d -o root -g lobster -m 750 /etc/lobster
sudo install -o root -g lobster -m 640 /dev/null /etc/lobster/backend.env   # then fill it in
sudo install -d /opt/lobster/backend            # then the third-party tree: "Third-party dependencies" below
sudo cp deploy/systemd/lobster-backend.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable lobster-backend
./deploy/deploy-backend.sh --migrate            # the first release: build, stage, migrate, start
```

`ExecStartPost` polls `/health/ready`, which proves Postgres answers. A start with a wrong
`DATABASE_URL` therefore fails the unit rather than succeeding and 500-ing on the first user
request.

That probe's pass/fail is Postgres and nothing else, deliberately — anything else allowed to fail it
also gains the power to block a deploy. The managed Lobee agent's operator credential is therefore
REPORTED and not enforced: `/health/ready` carries an `agentCredential` field, `GET /health/agent`
answers 200 with the detail, and a backend missing `OPENROUTER_API_KEY` logs a named warning at
startup. It starts and serves everything else correctly; only the agent is down. Check it after a
first install, because nothing will fail to tell you:

```sh
curl -fsS http://127.0.0.1:8080/health/agent    # -> "credential":"configured"
```

And watch the journal for `agent/llm OPERATOR_FAULT`: that is OpenRouter refusing the operator key,
or the operator's OpenRouter balance running out. Every managed run fails while it stands, and by
design no customer is charged and none is asked to top anything up — so that log line is the only
thing that will tell you.

### Release

`deploy/deploy-backend.sh`, run from a checkout on the box. It uses sudo for the release directory,
the copies under `node_modules/`, the env file and `systemctl`, and nothing else:

```sh
./deploy/deploy-backend.sh              # build, stage, verify, restart; rolls back by itself on failure
./deploy/deploy-backend.sh --migrate    # the same, applying pending Prisma migrations first
./deploy/deploy-backend.sh --dry-run    # print every step it would take; change nothing
./deploy/deploy-backend.sh --check      # health only: is the running backend ready?
./deploy/deploy-backend.sh --rollback   # put the previous release back and restart
```

Why it is a script, and why a release is not `dist/` alone: `dist/main.js` imports
`@lobster/shared-types` and `@lobster/crypto` from `node_modules`, and on the box those are copies
of the workspace packages, not symlinks into a checkout; `prisma migrate deploy` reads the
migrations beside whichever schema it is given; and the generated Prisma client in
`node_modules/.prisma/client` is compiled from the schema. The four-line procedure this replaces
shipped `dist/` only, so a change to a shared package or to the schema built cleanly, deployed
cleanly, passed the readiness probe, and failed on the first request that reached the stale copy —
which is what took production down on 2026-09-01. The script stages everything the process can
load as ONE release under `/opt/lobster/releases/<stamp>/`:

- `dist/` and `package.json` — the backend build;
- `prisma/` — schema and migrations;
- `node_modules/@lobster/*` — every workspace package the backend depends on, transitively,
  derived from `apps/backend/package.json` at run time (each as `package.json` + `dist/`, what
  `npm pack` would ship), so a new dependency ships the first time it is used;
- `node_modules/.prisma/client` and `node_modules/@prisma/client` — the generated client and the
  runtime it was generated for;
- `RELEASE` — stamp, git revision (`-dirty` when shipped with `--allow-dirty`), branch, who, when,
  which packages. `--check` prints it; `/opt/lobster/deploy.log` keeps the history.

In order: `npm ci` (`--skip-install` to skip), `prisma generate`, `npm run build` for each
workspace package and then the backend; a check that every third-party package the backend or a
shipped package imports exists in the runtime tree (missing is fatal, a different version is
reported); staging; `prisma migrate status` against the staged schema — pending migrations STOP
the deploy unless `--migrate` was passed, in which case `prisma migrate deploy` runs here, before
the switch, so the new code finds its columns the moment it starts (`DATABASE_URL` is read from
the env file with sudo and reaches Prisma through its environment only, never a command line);
the switch; `systemctl restart`; a bounded poll of `/health/ready`. If the restart fails or
readiness never comes, the previous release is put back and restarted, the failed one is kept
for inspection, and the script exits non-zero. A checkout with uncommitted tracked changes is
refused without `--allow-dirty`: a release nobody can check out again is a release nobody can
reason about.

Run `npm run gate:migrations` before deploying a migration: it applies the whole chain to PGlite
(real Postgres, compiled to WASM) and asserts the billing invariants, so an `ALTER TYPE` that cannot
apply is caught here rather than against the live database. `node --test
deploy/deploy-backend.test.mjs` exercises the script itself against a fixture box.

#### Layouts

The script supports two and detects which one it is looking at:

- **symlink** — `/opt/lobster/backend -> /opt/lobster/releases/<stamp>`. Each release is a complete
  tree: the third-party `node_modules/` is hardlinked from the release before it (`cp -al` — same
  inodes, no extra space; rsync writes a changed file under a new name, so the previous release is
  never modified) and the shipped set is laid over it. The switch is one `ln -sfn`, with no instant
  at which the path does not resolve, and rollback is the same flip back. The five newest releases
  are kept (`LOBSTER_KEEP_RELEASES`).
- **directory** — what the box has today: `/opt/lobster/backend` is a real directory, root-owned,
  with `dist/` owned by the deploying user. The release is staged exactly the same way and then
  rsynced INTO the directory — `dist/`, and anything else that user owns, without sudo; the rest
  with it — after the set it replaces has been copied to `/opt/lobster/backend.previous`. The
  service is stopped before the sync and restarted after it, because a directory cannot switch
  atomically. Rollback restores `backend.previous`.

One-time conversion to the symlink layout. The directory becomes the first release and keeps
serving; the unit's `WorkingDirectory=/opt/lobster/backend` resolves through the symlink, so the
unit does not change. Stop the service for the few seconds it takes so nothing is lazy-loaded
across the move:

```sh
sudo systemctl stop lobster-backend
sudo install -d /opt/lobster/releases
sudo mv /opt/lobster/backend /opt/lobster/releases/00000000000000-preexisting
sudo ln -sfn /opt/lobster/releases/00000000000000-preexisting /opt/lobster/backend
sudo systemctl start lobster-backend
./deploy/deploy-backend.sh --check
```

The next `deploy-backend.sh` run detects the symlink and flips it.

#### Third-party dependencies

The runtime tree — everything in `node_modules/` that is not `@lobster/*` or the Prisma client —
is not produced by the script. It is installed once, and refreshed by hand when
`package-lock.json` changes; the script verifies before every publish that each package the
backend or a shipped workspace package imports is present in it, and reports versions that differ
from the checkout's. From a checkout that has run `npm ci`:

```sh
# The root tree, then whatever npm nested under the backend because the root holds a conflicting
# version (@nestjs/core and @nestjs/platform-express today): the flat runtime tree needs both.
sudo rsync -a --exclude '/@lobster' --exclude '/.prisma' node_modules/ /opt/lobster/backend/node_modules/
sudo rsync -a apps/backend/node_modules/ /opt/lobster/backend/node_modules/
./deploy/deploy-backend.sh            # a refresh changes what the running process can load; deploy right after
```

## Marketing site + dashboard

`scripts/deploy-web.sh` builds `apps/web` and publishes it. The site is a static Angular SSG build,
so publishing is a file sync with no process to restart. The script stages the build into a fresh
directory beside the live one and swaps the symlink, keeping the previous release for rollback:

```sh
./scripts/deploy-web.sh              # build, publish, verify
./scripts/deploy-web.sh --rollback   # repoint at the previous release
```

## TLS

Both hostnames are Certbot-managed. The `# managed by Certbot` lines in the vhosts are Certbot's own
output and are kept verbatim so a renewal does not rewrite the file into something the repo no longer
matches:

```sh
sudo certbot --nginx -d lobrowser.com -d www.lobrowser.com
sudo certbot --nginx -d api.lobrowser.com
```

## After any change here

```sh
sudo nginx -t && sudo systemctl reload nginx
```
