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

| Path                       | Owner            | Holds                                              |
| -------------------------- | ---------------- | -------------------------------------------------- |
| `/opt/lobster/backend`     | `root`           | the built app (`dist/`, `node_modules/`, `prisma/`) |
| `/etc/lobster/backend.env` | `root:lobster` 0640 | every secret — see `apps/backend/.env.example`   |
| `/var/lib/lobster`         | `lobster`        | the profile blob store (`BLOB_STORE_PATH`)          |

Secrets live in `/etc`, never in the repo tree. A `.env` under `apps/backend` is a development
convenience only: the unit does not read it, and a directory backup of a working tree that contains
one carries `JWT_SECRET` and `DATABASE_URL` off the box with it.

First install:

```sh
sudo useradd --system --home /var/lib/lobster --shell /usr/sbin/nologin lobster
sudo install -d -o lobster -g lobster /var/lib/lobster
sudo install -d -o root -g lobster -m 750 /etc/lobster
sudo install -o root -g lobster -m 640 /dev/null /etc/lobster/backend.env   # then fill it in
sudo cp deploy/systemd/lobster-backend.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now lobster-backend
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

Release:

```sh
npm ci && npm run build --workspace @lobster/backend
sudo systemctl stop lobster-backend
sudo rsync -a --delete apps/backend/dist/ /opt/lobster/backend/dist/
sudo -u lobster npx prisma migrate deploy --schema /opt/lobster/backend/prisma/schema.prisma
sudo systemctl start lobster-backend
```

Run `npm run gate:migrations` before deploying a migration: it applies the whole chain to PGlite
(real Postgres, compiled to WASM) and asserts the billing invariants, so an `ALTER TYPE` that cannot
apply is caught here rather than against the live database.

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
