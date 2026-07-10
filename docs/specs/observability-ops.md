# Spec — Observability, Deployment & Operations

> **Scope:** how Lobster Browser is observed, deployed, released, scaled, and kept alive across its
> three shippable artifacts — the **cloud SaaS backend** (NestJS), the **desktop agent** (Rust + Tauri
> + Node sidecar), and the **Lobium engine** build pipeline. This is the run-book layer beneath the
> product specs: logging, metrics, tracing, error tracking, containers, IaC, DB migrations, backups/DR,
> rate limiting, autoscaling, desktop delivery + code signing + auto-update, the release process,
> monitoring/alerting/SLOs, and billing ops.
>
> **Status legend** (matches MASTER_PLAN §1 conventions): **done** = built and in-repo · **partial** =
> a stub/skeleton exists · **planned** = specified here, not yet built. Honest bias: most of this layer
> is **planned**. What exists today is the `GET /health` liveness route, a single-service local
> `docker-compose` (Postgres only), a Prisma schema with a `0001_init` migration, and a five-job GitHub
> Actions CI. Everything else below is the target we are writing down so it can be built to spec.
>
> **Related docs:** `MASTER_PLAN.md` (§3 stack, §8 repo + CI gates), `docs/adr/ADR-0002-tech-stack.md`,
> `docs/contracts/local-automation-api.md`, `docs/contracts/sidecar-ipc.md`, `apps/backend/README.md`.

---

## 0. Current state vs. this spec (one-paragraph honest baseline)

| Area | Today | This spec targets |
|---|---|---|
| Logging | Nest `Logger` + `console.log` in `main.ts` | Structured JSON logs, correlation IDs, levels, redaction |
| Metrics | none | Prometheus `/metrics`, RED + USE dashboards |
| Tracing | none | OpenTelemetry spans backend → sidecar |
| Error tracking | none | Sentry (backend + desktop), release-tagged |
| Health | `GET /health` liveness (**done**) | + `/health/ready`, `/health/startup`, `/metrics` |
| Backend deploy | local `docker-compose` (Postgres only, **partial**) | Dockerfile + k8s/managed, staging + prod |
| DB migrations | Prisma `0001_init`, `migrate deploy` by hand | Gated `migrate deploy` step in the deploy pipeline |
| Backups / DR | none | Managed PITR, tested restores, RTO/RPO targets |
| Rate limiting / abuse | none (contract says "Day 4") | Per-key + per-IP limits, DDoS at the edge |
| Desktop delivery | `tauri.conf.json` `version 0.0.0`, no updater | Signed + notarized builds, Tauri auto-updater, staged rollout |
| Release process | Conventional Commits, squash merge | Semver + changelog + tag + release checklist |
| Billing ops | Stripe stubs (commented) | Reliable webhooks, metering pipeline, reconciliation |

Read the rest of this doc as the build-to target for each row.

---

## 1. Observability

Three pillars — **logs**, **metrics**, **traces** — plus **error tracking** and **health probes**.
One rule threads all of them: **every request carries a correlation ID**, and that ID appears in the
log line, the trace, and the Sentry event, so a single incident is one lookup across all three systems.

### 1.1 Structured logging

**Backend (NestJS).** Replace the default `Logger`/`console.log` with **pino** (`nestjs-pino`),
emitting **one JSON object per line** to stdout (12-factor; the container runtime ships stdout to the
log aggregator). No file logging inside containers.

**Log levels** (pino numeric levels):

| Level | Use | Example |
|---|---|---|
| `fatal` (60) | process cannot continue; about to exit | DB unreachable at boot with `DATABASE_URL` set |
| `error` (50) | a request/job failed, needs attention | unhandled 500, Stripe webhook verification failed |
| `warn` (40) | degraded but handled | in-memory store used because `DATABASE_URL` unset; rate-limit rejection |
| `info` (30) | request lifecycle + state changes | request completed, subscription tier changed, blob synced |
| `debug` (20) | dev/staging diagnostics | SQL timing, sidecar RPC payload sizes |
| `trace` (10) | firehose, local only | full CDP frames |

Default level: `info` in prod/staging, `debug` in dev. Configurable via `LOG_LEVEL` env.

**Required fields on every line** (pino base + custom serializers):

```jsonc
{
  "level": 30,
  "time": "2026-07-03T10:15:00.123Z",
  "service": "lobster-backend",       // lobster-backend | lobster-sidecar | lobster-desktop
  "env": "prod",                      // dev | staging | prod
  "version": "1.4.2",                 // app semver, == git tag, == Sentry release
  "requestId": "01J...",              // correlation id, see §1.2
  "userId": "usr_...",                // when authenticated (never PII beyond the id)
  "teamId": "team_...",               // tenant scope
  "route": "POST /profiles/:id/sync",
  "status": 200,
  "durationMs": 42,
  "msg": "request completed"
}
```

**Correlation ID (`requestId`).** A NestJS middleware runs first on every request:
1. read inbound `X-Request-Id`; if absent, generate a **ULID** (sortable, timestamped).
2. store it in `AsyncLocalStorage` so every log line in that request auto-includes it (no manual
   threading).
3. echo it back in the `X-Request-Id` **response header**.
4. propagate it to the desktop→sidecar→engine hops (the sidecar IPC contract in
   `docs/contracts/sidecar-ipc.md` gains an optional `requestId` field on each RPC envelope).

**Redaction (mandatory).** pino `redact` paths strip secrets before serialization:
`req.headers.authorization`, `req.headers["stripe-signature"]`, `req.headers.cookie`,
`*.password`, `*.passwordHash`, `*.hashedKey`, `*.token`, `*.jwt`, `*.stripeSecret`,
`*.S3_SECRET_ACCESS_KEY`. Encrypted profile **blob bytes are never logged** (they are opaque and
client-encrypted anyway). Log the profile `id` + `encryptedBlobRef`, never contents.

**Desktop agent (Rust core).** Use the `tracing` + `tracing-subscriber` crates with a JSON layer,
written to a **rotating file** under the OS app-data dir (`~/.lobster/logs/desktop-YYYY-MM-DD.log`,
daily rotation, 7-day retention, 50 MB cap) plus stderr in dev. The sidecar (Node/TS) uses pino to
stdout, which the Rust core captures and re-emits into the same file so a support bundle is one
timeline. **No auth tokens, API keys, proxy credentials, or cookies** in desktop logs.

**Status:** planned. (`main.ts` uses `console.log`; Nest `Logger` is used in `PrismaService`.)

### 1.2 Metrics — RED + USE, Prometheus

Expose **`GET /metrics`** on the backend in Prometheus text format via `prom-client`
(`@willsoto/nestjs-prometheus` wires it into Nest). Scraped every 15 s by Prometheus (self-hosted or
Grafana Cloud / managed).

**RED (request-oriented, per route)** — the primary SLO signal:

| Metric | Type | Labels |
|---|---|---|
| `http_requests_total` | counter | `method`, `route`, `status` |
| `http_request_duration_seconds` | histogram | `method`, `route` (buckets: 5ms…10s) |
| `http_requests_in_flight` | gauge | `route` |
| `http_request_errors_total` | counter | `method`, `route`, `status` (4xx/5xx split) |

**USE (resource-oriented)** — scraped from the runtime + node exporter:
`process_cpu_seconds_total`, `nodejs_eventloop_lag_seconds`, `nodejs_heap_size_used_bytes`,
`nodejs_active_handles`, plus container CPU/mem from cAdvisor and DB pool saturation
(`db_pool_connections{state="active|idle|waiting"}`).

**Domain metrics (business + reliability):**

| Metric | Type | Why |
|---|---|---|
| `profiles_total` | gauge (by `teamId` cardinality-capped, else global) | capacity + billing sanity |
| `profile_sync_bytes_total` | counter | blob egress cost |
| `blob_put_duration_seconds` / `blob_get_duration_seconds` | histogram | S3 latency |
| `stripe_webhook_events_total` | counter, label `type`, `outcome` | billing reliability |
| `stripe_webhook_verification_failures_total` | counter | attack/misconfig signal |
| `rate_limit_rejections_total` | counter, label `scope` (`key`/`ip`) | abuse signal |
| `queue_jobs_total` | counter, label `queue`, `state` | async health |
| `queue_job_duration_seconds` | histogram, label `queue` | async latency |
| `auth_logins_total` / `auth_login_failures_total` | counter | security signal |

**Cardinality discipline:** never label a metric with unbounded values (raw `userId`, `profileId`,
`requestId`, full URLs). Use the **route pattern** (`/profiles/:id`), not the concrete path.

**Status:** planned.

### 1.3 Distributed tracing — OpenTelemetry

Instrument with the **OpenTelemetry Node SDK** (auto-instrumentation for HTTP, Nest, Prisma/`pg`,
and the AWS S3 SDK). Export **OTLP/gRPC** to a collector (Grafana Tempo / Jaeger / Honeycomb / managed).

- **Trace boundary:** a span starts at the request middleware and is the parent for Prisma queries,
  S3 calls, Stripe API calls, and outbound calls to the desktop where applicable.
- **Correlation:** the OTel `trace_id` is injected into every pino line (`trace_id`, `span_id`
  fields) so logs pivot to traces. The `requestId` (§1.1) is added as a span attribute
  `lobster.request_id` for the reverse pivot.
- **Cross-process:** desktop core → sidecar RPC carries W3C `traceparent` in the IPC envelope so a
  "launch profile" action is one trace from UI action to engine spawn (sampled; see below).
- **Sampling:** parent-based, **100% in dev/staging**, **head-sample ~10% in prod** with
  **always-sample-on-error** (tail sampling in the collector where available). Keep 100% of spans
  that touch billing.

**Status:** planned.

### 1.4 Error tracking — Sentry

Backend and desktop both report to **Sentry** (self-hostable; keeps with the OSS posture).

- **Backend:** `@sentry/node` + a Nest exception filter that captures unhandled 5xx (not 4xx),
  tagged with `requestId`, `userId`, `teamId`, `route`, `release` (= app semver), `environment`.
  Sample rate 100% for errors; performance tracing tied to the OTel sampler.
- **Desktop:** `sentry` Rust crate in the core + `@sentry/electron`-style hook is **not** applicable
  (Tauri); use `sentry` (Rust) for the core and `@sentry/node` in the sidecar. Reports are
  **opt-in** (see §1.6).
- **Release health:** every Sentry event is stamped with the **release** so a regression is pinned
  to the exact version and the staged-rollout gate (§5.6) can read the crash-free-sessions rate.
- **PII scrubbing:** `beforeSend` strips auth headers, request bodies for auth/billing routes, and
  any field matching the §1.1 redaction list. IP addresses off by default.

**Status:** planned.

### 1.5 Health, readiness & startup probes

Kubernetes-style three-probe model. Today only liveness exists.

| Endpoint | Probe | Checks | Semantics |
|---|---|---|---|
| `GET /health` | **liveness** (**done**) | process is up, event loop responsive | returns `{code:0,data:{status:"ok"}}`; failure → restart pod |
| `GET /health/ready` | **readiness** (planned) | DB `SELECT 1`, S3 `HeadBucket`, Stripe key present | 200 only when able to serve; failure → pulled from LB, **not** restarted |
| `GET /health/startup` | **startup** (planned) | migrations applied, config validated | gates liveness/readiness during slow boot |
| `GET /metrics` | scrape (planned) | Prometheus exposition | internal-only, not exposed publicly |

Readiness must be **cheap and cached** (checks run on a 5 s timer, endpoint returns the cached
result) so probes don't hammer the DB. Readiness deliberately reports the in-memory-store fallback
as **not ready** in prod (the app should never silently serve prod traffic without Postgres).

**Status:** liveness **done** (`apps/backend/src/health/health.controller.ts`); ready/startup/metrics **planned**.

### 1.6 Desktop crash reporting & opt-in telemetry

- **Consent-first.** On first run the desktop shows a **telemetry opt-in** toggle (default **off**).
  Nothing leaves the machine until the user opts in. Setting persisted in the local SQLite settings
  table; a single `telemetryEnabled` flag gates both crash reports and usage pings.
- **Crash reporting.** Tauri/Rust panics and sidecar crashes are captured by the Sentry Rust/Node
  SDKs and queued to a local spool; uploaded only when `telemetryEnabled`. Minidump-style payloads
  are scrubbed of file paths that contain the username and of any profile/proxy data.
- **Usage telemetry (opt-in, anonymized).** Coarse product events keyed by a **rotating anonymous
  install ID** (not the user id): app launched, engine launched (`lobium` vs `chromium`), profile
  count bucket (`1-5/6-20/21-100/100+`), OS + app version, update applied/failed. **Never**: URLs
  visited, profile names, proxy hosts, fingerprint values, cookies.
- **Transport.** Batched, POSTed to a backend `/telemetry` ingest endpoint (rate-limited, no auth
  required but signed with the anonymous install ID), or directly to Sentry for crashes.
- **Kill switch.** Opting out purges the local spool and stops all uploads immediately.

**Status:** planned.

---

## 2. Backend deployment

### 2.1 Containerization (Docker)

Ship the backend as a **multi-stage** distroless-ish image (Node 22, matching `.nvmrc`):

```dockerfile
# apps/backend/Dockerfile  (planned)
# --- deps: install with lockfile, cache-friendly ---
FROM node:22-bookworm-slim AS deps
WORKDIR /repo
COPY package.json package-lock.json ./
COPY packages ./packages
COPY apps/backend/package.json ./apps/backend/
RUN npm ci --workspace @lobster/backend --include-workspace-root

# --- build: prisma generate + nest build ---
FROM deps AS build
COPY . .
RUN npx prisma generate --schema=apps/backend/prisma/schema.prisma \
 && npm run build --workspace @lobster/backend

# --- runtime: minimal, non-root ---
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /repo/apps/backend/dist ./dist
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/apps/backend/prisma ./prisma
USER node
EXPOSE 8080
HEALTHCHECK CMD node -e "fetch('http://localhost:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
```

Rules: **non-root user**, **no secrets baked in** (all via env at runtime), pinned base image digest,
`.dockerignore` excludes `node_modules`/`dist`/`.env`, image scanned by Trivy in CI (§6). Tag images
`ghcr.io/<org>/lobster-backend:<semver>` and `:<git-sha>`.

**Status:** planned (no Dockerfile in repo yet).

### 2.2 Local dev — docker-compose (Postgres + MinIO)

Extend the existing single-service compose (`apps/backend/docker-compose.yml`, Postgres only —
**partial**) to a full local cloud: Postgres **+ MinIO** (S3-compatible) **+ the backend**, so a
developer runs the entire SaaS locally with one command and the S3 code path is exercised for real.

```yaml
# apps/backend/docker-compose.yml  (target — extends today's Postgres-only file)
services:
  postgres:            # (exists today)
    image: postgres:16-alpine
    environment: { POSTGRES_USER: lobster, POSTGRES_PASSWORD: lobster, POSTGRES_DB: lobster }
    ports: ['5432:5432']
    volumes: [lobster_pg:/var/lib/postgresql/data]
    healthcheck: { test: ['CMD-SHELL','pg_isready -U lobster -d lobster'], interval: 5s, retries: 10 }

  minio:               # (new) S3-compatible blob store for local profile sync
    image: minio/minio
    command: server /data --console-address ":9001"
    environment: { MINIO_ROOT_USER: lobster, MINIO_ROOT_PASSWORD: lobsterlobster }
    ports: ['9000:9000','9001:9001']
    volumes: [lobster_minio:/data]
    healthcheck: { test: ['CMD','mc','ready','local'], interval: 5s, retries: 10 }

  createbuckets:       # (new) one-shot: create the lobster-profiles bucket
    image: minio/mc
    depends_on: { minio: { condition: service_healthy } }
    entrypoint: >
      /bin/sh -c "mc alias set local http://minio:9000 lobster lobsterlobster &&
                  mc mb -p local/lobster-profiles && mc anonymous set none local/lobster-profiles"

  backend:             # (new, optional) the API itself, for full-stack local runs
    build: { context: ../.., dockerfile: apps/backend/Dockerfile }
    depends_on: { postgres: { condition: service_healthy }, minio: { condition: service_healthy } }
    environment:
      DATABASE_URL: postgresql://lobster:lobster@postgres:5432/lobster?schema=public
      S3_ENDPOINT: http://minio:9000
      S3_REGION: us-east-1
      S3_BUCKET: lobster-profiles
      S3_ACCESS_KEY_ID: lobster
      S3_SECRET_ACCESS_KEY: lobsterlobster
      JWT_SECRET: dev-only-not-for-prod
    ports: ['8080:8080']

volumes: { lobster_pg: {}, lobster_minio: {} }
```

The env keys already match `apps/backend/.env.example` (`S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`,
`S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`), so wiring `S3BlobStore` (currently a stub) against MinIO
is a drop-in.

**Status:** Postgres service **partial** (exists); MinIO + backend services **planned**.

### 2.3 Production topology

Two acceptable targets; pick per MASTER_PLAN §12 decision:

**A. Managed PaaS (recommended for v1)** — Render / Railway / Fly.io / AWS App Runner:
- Backend container autoscaled behind a managed HTTPS LB.
- **Managed Postgres** (RDS/Neon/Supabase) with automated backups + PITR (see §3).
- **Managed object storage** (S3 / R2 / Spaces) with the `S3_*` config pointed at it.
- Cheapest path to "prod that survives a node dying," least ops burden — matches the 10-day timeline.

**B. Kubernetes (scale target)** — when multi-region / fine autoscaling is needed:
- `Deployment` (3+ replicas), `Service`, `Ingress` (nginx/Traefik) with TLS via cert-manager.
- `HorizontalPodAutoscaler` on CPU + `nodejs_eventloop_lag` custom metric.
- `readinessProbe` → `/health/ready`, `livenessProbe` → `/health`, `startupProbe` → `/health/startup`.
- Secrets via `ExternalSecrets`/sealed-secrets, config via `ConfigMap`.
- `PodDisruptionBudget` (minAvailable: 2) so rollouts never drop below capacity.
- Migrations run as a pre-deploy `Job` (§2.6).

**Status:** planned. (Managed PaaS recommended first; k8s manifests are a later track.)

### 2.4 Environments

| Env | Purpose | DB | Object store | Stripe | Domain |
|---|---|---|---|---|---|
| **dev** | local laptop | compose Postgres or in-memory | MinIO or in-memory | test keys / stubs | `localhost:8080` |
| **staging** | pre-prod, prod-like, auto-deployed from `main` | managed Postgres (small) | staging bucket | **test** mode | `staging-api.lobster.app` |
| **prod** | live | managed Postgres + PITR | prod bucket | **live** mode | `api.lobster.app` |

Staging is **prod-parity**: same image, same migration path, same Stripe webhook wiring (in test
mode) so billing changes are exercised before prod. Desktop `staging` builds point at
`staging-api` via the `LOBSTER_API_URL` build arg.

**Status:** planned.

### 2.5 Configuration & secrets

- **12-factor:** all config from env vars (`ConfigModule` already present — `BillingService`/
  `S3BlobStore` read `ConfigService`). **No secrets in the repo** — enforced by gitleaks in CI (§6)
  and `.gitignore` (`*.env`, `*.pem`, `*.key`, `secrets/`).
- **Boot-time validation:** a Zod/`class-validator` schema validates required env on startup and
  **hard-fails** if missing in prod (already true for `JWT_SECRET` via `jwt-secret.ts`; extend to
  `DATABASE_URL`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `S3_*`).
- **Secret storage:** managed platform secrets (Render/Fly secrets, AWS Secrets Manager, or k8s
  `ExternalSecrets` backed by Vault). Secrets are **rotated** on a schedule; `JWT_SECRET` rotation
  uses a dual-key window (accept old+new) to avoid mass logout.
- **Required prod secrets:** `JWT_SECRET`, `DATABASE_URL`, `STRIPE_SECRET_KEY`,
  `STRIPE_WEBHOOK_SECRET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, Sentry DSN, code-signing
  material (§5.2, in CI secrets only).

**Status:** partial (`JWT_SECRET` prod hard-fail **done**; broader validation + managed secrets **planned**).

### 2.6 Database migrations in the pipeline (Prisma)

The schema lives at `apps/backend/prisma/schema.prisma` with a `0001_init` migration. Deploy rules:

1. **Never** `prisma migrate dev` or `db push` against staging/prod. Only **`prisma migrate deploy`**
   (applies committed migrations, no schema drift, no prompts).
2. Migrations run as a **separate, ordered step before** the new app version serves traffic — a k8s
   pre-deploy `Job` or a PaaS release command — using a DB role with DDL rights (the app's runtime
   role does not need DDL).
3. **Expand/contract (backward-compatible) migrations** so blue/green and rolling deploys never
   break the old running version: add columns nullable → backfill → switch reads → drop in a later
   release. No destructive change ships in the same release that starts using it.
4. `prisma migrate deploy` is **idempotent**; if it fails, the deploy **aborts before** the new
   version rolls out (old version keeps serving).
5. CI already runs `prisma generate` (no DB) for typecheck; the **deploy** pipeline adds the
   `migrate deploy` step against the target DB with a short statement timeout and an advisory lock so
   two concurrent deploys can't race.

**Status:** partial (schema + `0001_init` + manual `migrate deploy` documented in README; **automated gated step planned**).

### 2.7 Release strategy — rolling vs blue/green

- **Default: rolling** (surge 1, unavailable 0) behind readiness gating — cheap, and expand/contract
  migrations make it safe.
- **Blue/green** for releases that touch auth or billing: bring up the green stack, run smoke tests
  (`/health/ready`, a synthetic login + checkout in Stripe test mode), flip the LB, keep blue warm
  for fast rollback.
- **Rollback:** re-deploy the previous image tag (images are immutable + semver-tagged). Because
  migrations are expand/contract, rolling back the app does **not** require rolling back the DB.

**Status:** planned.

---

## 3. Data — backups, PITR, DR, S3 lifecycle

Two data stores: **Postgres** (metadata, users, teams, subscriptions, blob refs) and **object
storage** (client-encrypted profile blobs). They have different DR profiles.

### 3.1 Postgres backups + point-in-time recovery

- **Automated daily base backups** + **continuous WAL archiving** → PITR to any second in the
  retention window. Use the managed provider's PITR (RDS/Neon/Supabase) — retention **≥ 7 days**
  (prod ≥ 30 days).
- **Logical dumps** (`pg_dump`, nightly) shipped to a **separate account/region** bucket as defense
  against provider-account compromise and against logical corruption a physical PITR would replicate.
- **Restore drills:** a **quarterly** game-day restores the latest backup into a scratch DB and runs
  the e2e suite against it. A backup that has never been restored is not a backup.

### 3.2 Object storage (profile blobs)

- Blobs are **client-encrypted** (Postgres holds only `encryptedBlobRef` + `fingerprintSeed`), so a
  storage leak is ciphertext. Even so: **versioning ON** (recover from bad syncs / ransomware),
  **cross-region replication** for prod, **SSE at rest** as defense-in-depth.
- The blob store is **content-addressed by profile + version** (`<keyPrefix>/<key>/<version>.enc`,
  per the `S3BlobStore` TODO), so restoring a profile = fetching a prior version.

### 3.3 Disaster recovery — RTO / RPO targets

| Scenario | RPO (max data loss) | RTO (max downtime) | Mechanism |
|---|---|---|---|
| App instance dies | 0 | < 1 min | autoscaler/replicas + LB health checks |
| Bad deploy | 0 | < 5 min | roll back to previous image tag |
| DB logical corruption | ≤ 5 min | < 1 hr | PITR to just-before + replay |
| DB total loss | ≤ 5 min (WAL) | < 2 hr | PITR / promote replica / restore dump |
| Region outage | ≤ 15 min | < 4 hr | cross-region replica promote + failover DNS |
| Object-store loss | 0 (versioned + replicated) | < 1 hr | replica bucket + re-point `S3_*` |

DR runbook lives in the ops repo; the on-call rotates through a **DR game-day** each quarter.

### 3.4 S3 lifecycle policies

- **Blob versions:** keep current + **N=10** prior versions (or 90 days), then transition old
  versions to infrequent-access/Glacier, expire noncurrent > 180 days.
- **Orphan sweep:** a scheduled job reconciles object keys against `Profile.encryptedBlobRef` and
  deletes objects with no DB reference older than 30 days (guards egress cost).
- **Multipart cleanup:** abort incomplete multipart uploads after 7 days.
- **Access logs / lifecycle audit** retained 30 days.

**Status:** all planned (`S3BlobStore` is a stub; no backup automation exists yet).

---

## 4. Reliability & scale

### 4.1 Rate limiting & abuse protection

Two enforcement points, matching the two API surfaces:

**Cloud backend** (`@nestjs/throttler` + a Redis store for multi-instance correctness):

| Scope | Limit (default) | Notes |
|---|---|---|
| Per API key | 600 req/min sustained, burst 60/s | keyed on `ApiKey.id` (hashed key → id) |
| Per IP (unauthenticated) | 60 req/min | login/register/webhook-adjacent |
| Auth endpoints (`/auth/login`,`/register`) | 10/min per IP + per email | credential-stuffing brake; exponential backoff/lockout after N fails |
| `/billing/webhook` | not user-limited | protected by signature verification, IP-allowlist Stripe ranges |
| Blob sync (`/profiles/:id/sync`) | 30/min per team + size cap | protects S3 egress |

Rejections return **429** with `Retry-After` and increment `rate_limit_rejections_total{scope}`.
Limits are **plan-aware** (enterprise tiers get higher RPM — ties to §8 quota enforcement).

**Local automation API** (Rust Axum, desktop): per-endpoint limits as noted in
`docs/contracts/local-automation-api.md` ("Day 4"). Bearer API-key auth; loopback-only binding means
the threat model is local processes, so limits mainly prevent runaway automation loops.

### 4.2 DDoS & edge protection

- Terminate TLS at a **CDN/WAF edge** (Cloudflare / CloudFront + AWS WAF). Managed DDoS (L3/4),
  rate rules, bot-fight, and geo/ASN rules at the edge before traffic hits the app.
- **Stripe webhook IP allowlist** at the edge; everything else to `/billing/webhook` dropped.
- `/metrics` and `/health/ready` are **internal-only** (not routed publicly).
- Request body size caps (e.g. 10 MB) except the sync route (explicit larger cap) to blunt payload
  floods.

### 4.3 Autoscaling

- **Backend:** scale on CPU **and** `nodejs_eventloop_lag_seconds` (the honest saturation signal for
  an I/O service) + `http_requests_in_flight`. Min 2 replicas (HA), scale to N.
- **DB:** vertical first; add **read replicas** for read-heavy endpoints (profile list, action-log
  reads) later. Connection pooling via **PgBouncer**/Prisma pool — cap `connection_limit` so N app
  replicas don't exhaust Postgres.
- **Workers:** scale on **queue depth** (§4.4).

### 4.4 Async work queue

Long/spiky work must not run inline in the request. Use **BullMQ (Redis)** (or SQS on AWS):

| Queue | Producer | Work |
|---|---|---|
| `blob-sync` | `/profiles/:id/sync` | finalize S3 multipart, update version marker, write action log |
| `usage-metering` | profile create/delete, periodic | roll up profile counts → Stripe meter events (§8) |
| `webhooks` | Stripe webhook receiver | process event **after** fast-acking Stripe |
| `email` | auth/invites | OTP, team invites, receipts |
| `retention` | cron | S3 orphan sweep, log/backup pruning |

Rules: **at-least-once** delivery → every consumer is **idempotent** (§4.5); exponential backoff,
**max attempts** then **dead-letter queue** with an alert; jobs carry the `requestId` for tracing.

### 4.5 Idempotency

- **Inbound API:** mutating endpoints accept an **`Idempotency-Key`** header; the backend stores
  `(key, teamId) → response` for 24 h and replays the stored response on retry (critical for
  `/billing/checkout` and `/profiles` create).
- **Stripe webhooks:** dedupe on Stripe's **event `id`** — persist processed event ids; a redelivered
  event is a no-op ack (§8.1). Never process the same event twice (subscriptions, meters).
- **Blob sync:** versioned + content-addressed, so a re-sent identical blob is a no-op; a conflicting
  version uses the last-writer-wins + version-vector conflict handling from the sync spec.
- **Queue jobs:** each job has a stable job id derived from the domain key so re-enqueues coalesce.

**Status:** all planned. (Idempotency keys, throttler, queue, Redis not yet in repo.)

---

## 5. Desktop delivery

The desktop agent is a **Tauri 2** app (`apps/desktop/src-tauri/tauri.conf.json`, `productName
"Lobster Browser"`, `identifier com.lobster.browser`, currently `version 0.0.0`, **no updater
configured**). The Node sidecar + `engine-runner` are bundled; the actual browser engines are
**downloaded on first run** (`engines/download-engines.mjs`; binaries never committed — see
`.gitignore`).

### 5.1 Release channels

| Channel | Audience | Cadence | Updater feed |
|---|---|---|---|
| `stable` | all users | on release | `.../updater/stable/{target}/{arch}` |
| `beta` | opt-in testers | pre-release | `.../updater/beta/...` |
| `nightly` | internal / CI | per merge to `main` | `.../updater/nightly/...` |

A user's channel is a local setting; the updater endpoint is chosen by channel. Nightly/beta builds
are signed too (see §5.2) — an unsigned build must never reach a user.

### 5.2 Code signing & notarization

Non-negotiable for a desktop app that downloads and launches browser engines — unsigned binaries
get SmartScreen/Gatekeeper-blocked and read as malware.

**Windows — Authenticode:**
- Sign the `.exe`/`.msi`/NSIS installer **and** the bundled sidecar/helper binaries with an
  **EV or OV code-signing certificate** (EV clears SmartScreen reputation faster).
- Prefer a **cloud HSM / Azure Trusted Signing** (cert never leaves the HSM); `signtool` in CI with
  timestamping (`/tr` RFC-3161) so signatures survive cert expiry.

**macOS — Developer ID + notarization:**
- Sign with a **Developer ID Application** cert, **hardened runtime** enabled, correct entitlements
  (the app spawns child processes — needs `com.apple.security.cs.allow-jit`/
  `allow-unsigned-executable-memory` only if the engine requires it; keep entitlements minimal).
- **Notarize** via `notarytool` and **staple** the ticket to the `.dmg`/`.app`.
- **Universal** builds (or separate Intel + Apple-Silicon) per MASTER_PLAN §12 (mac Intel + ARM).

**Linux:** AppImage/deb; sign with GPG, publish the public key + checksums.

**Signing keys live only in CI secrets / HSM** — never in the repo (gitleaks + `.gitignore` `*.pem`
`*.key` back this).

### 5.3 Tauri auto-updater + update server

- Enable the **`tauri-plugin-updater`** (add to `Cargo.toml` + `tauri.conf.json` `plugins.updater`
  with `pubkey` and per-channel `endpoints`). Tauri verifies updates with its **own Ed25519 signature**
  (separate from OS code-signing) — the private key is a CI secret, the public key ships in the app.
- **Update server / feed:** a static JSON manifest per `{channel, target, arch}` served from S3+CDN:
  ```jsonc
  {
    "version": "1.4.2",
    "notes": "…changelog excerpt…",
    "pub_date": "2026-07-03T10:00:00Z",
    "platforms": {
      "windows-x86_64": { "signature": "<ed25519>", "url": "https://cdn.lobster.app/releases/1.4.2/lobster_1.4.2_x64-setup.nsis.zip" },
      "darwin-aarch64": { "signature": "<ed25519>", "url": "…/lobster_1.4.2_aarch64.app.tar.gz" },
      "darwin-x86_64":  { "signature": "<ed25519>", "url": "…" },
      "linux-x86_64":   { "signature": "<ed25519>", "url": "…/lobster_1.4.2_amd64.AppImage.tar.gz" }
    }
  }
  ```
- **Check cadence:** on launch + every 6 h; download in the background; apply on next relaunch (never
  interrupt a running automation session mid-flight — prompt, or wait until no profiles are running).
- **Engine compatibility:** the updater checks a `minEngineVersion`/`minBackendApiVersion` field so a
  desktop update that requires a new backend API contract won't strand users (and the backend keeps
  API back-compat for ≥ 2 desktop minor versions).

### 5.4 Staged rollout

- Roll out by **percentage** via the manifest: publish `1.4.2` to **5% → 25% → 50% → 100%** over
  hours/days. Percentage is decided client-side from a hash of the anonymous install ID vs. a
  `rollout` field in the manifest, so it's deterministic and monotonic per install.
- **Gate promotion on Sentry release health** (crash-free sessions ≥ threshold, §1.4) and update
  success rate (`update applied/failed` telemetry, §1.6). A regression **halts** rollout.

### 5.5 Rollback

- Desktop updates are hard to "recall" once applied, so the lever is: **stop the rollout**, publish a
  **superseding higher version** that reverts the change (never re-point a version number at
  different bytes). Keep the previous installer available for manual downgrade + a documented
  "revert to previous" support path.
- Because engines are downloaded and profiles live in app-data, a downgrade must be **data-safe**:
  the local SQLite schema uses forward-compatible migrations with a documented min-supported version.

### 5.6 Versioning & changelog (desktop)

- `tauri.conf.json` `version` is the single source (bumped from `0.0.0` at first release), **== git
  tag == Sentry release == updater manifest version**.
- Each release ships a user-facing changelog (shown in an in-app "What's new" panel, sourced from
  `CHANGELOG.md`, §6.2).

**Status:** all planned. (`tauri.conf.json` has no updater block; `version` is `0.0.0`; no signing
config yet.)

---

## 6. Release process

### 6.1 Semantic versioning

- **Semver `MAJOR.MINOR.PATCH`** across all three artifacts, but versioned **independently** with
  scoped tags: `backend-vX.Y.Z`, `desktop-vX.Y.Z`, `lobium-vX.Y.Z` (they release on different
  cadences; the desktop `version` is the user-facing one).
- Bumps derived from **Conventional Commits** (already the commit convention, MASTER_PLAN §7.3):
  `fix:` → patch, `feat:` → minor, `feat!:`/`BREAKING CHANGE:` → major.
- Pre-releases: `1.5.0-beta.1`, `1.5.0-nightly.<sha>`.

### 6.2 Changelog & tagging

- **`CHANGELOG.md`** generated from Conventional Commits (`changesets`, `release-please`, or
  `git-cliff`) — never hand-maintained. Grouped by artifact + type (Features / Fixes / Breaking).
- Release = an **annotated, signed git tag** → triggers the release workflow. Tag message includes
  the changelog section. GitHub Release attaches signed installers + checksums (`SHA256SUMS`).

### 6.3 CI/CD per artifact

Today's CI (`.github/workflows/ci.yml`) has five jobs on push/PR to `main`: **web**
(format/typecheck/build/test + `prisma generate`), **secret-scan** (gitleaks), **rust**
(fmt/clippy/test), **engine-launch** (native Lobium when provisioned; Patchright harness only for
internal compatibility), **fingerprint-gate** (live detector under Xvfb). That's the **quality gate**.
Add **delivery** pipelines:

| Pipeline | Trigger | Steps |
|---|---|---|
| **Backend CD** | tag `backend-v*` (+ auto to staging on `main`) | build image → Trivy scan → push GHCR → `prisma migrate deploy` (target DB) → rolling/blue-green deploy → smoke `/health/ready` → notify |
| **Desktop release** | tag `desktop-v*` | matrix build (win-x64, mac-arm64, mac-x64, linux-x64) → **sign + notarize** → Tauri **updater-sign** → upload installers + manifest to S3/CDN → GitHub Release → start staged rollout |
| **Lobium build** | manual / `lobium-v*` (own long pipeline, MASTER_PLAN §8) | `depot_tools` sync → apply quilt series → GN/ninja with ccache/reclient → run detector matrix → sign per-OS → publish engine artifact + version to the engine download manifest |

Matrix builds use `tauri-apps/tauri-action`. Secrets (signing certs, updater key, registry creds,
DB URL, Sentry DSN) live in **GitHub Actions encrypted secrets / OIDC to the cloud** — never in repo.

### 6.4 Release checklist (per release)

- [ ] All CI gates green on the release commit (web / rust / engine-launch / **fingerprint-gate** / secret-scan).
- [ ] Version bumped consistently (`tauri.conf.json` / `package.json` / tag) and changelog generated.
- [ ] DB migration reviewed as **expand/contract**; `migrate deploy` dry-run against a staging clone.
- [ ] Deployed to **staging**; smoke suite green (auth, profile sync against MinIO/S3, Stripe test webhook).
- [ ] Backward-compat verified: old desktop ↔ new backend, and new desktop ↔ current backend.
- [ ] Desktop artifacts **signed + notarized**; updater manifest validated (signatures verify).
- [ ] Sentry **release** created + source maps/debug symbols uploaded.
- [ ] Rollout plan set (percentage stages + halt criteria); on-call briefed.
- [ ] Rollback path confirmed (previous image tag exists / previous installer archived).
- [ ] Post-deploy: dashboards + error rate watched for the bake period.

**Status:** quality-gate CI **done**; delivery pipelines + signing + changelog automation **planned**.

---

## 7. Monitoring, alerting, SLOs

### 7.1 Dashboards (Grafana)

- **Service overview (RED):** request rate, error rate, p50/p95/p99 latency per route; 4xx vs 5xx.
- **Resource (USE):** CPU, mem, event-loop lag, DB pool saturation, container restarts.
- **Database:** connections, slow queries, replication lag, disk, WAL archive lag (backup health).
- **Business/billing:** active subscriptions by tier, webhook success rate, meter-event lag,
  profiles total, sync bytes/day, S3 latency.
- **Desktop fleet (from opt-in telemetry):** version adoption, update success/failure, crash-free
  sessions, engine mix (`lobium` vs `chromium`).

### 7.2 Alerts (Alertmanager / Grafana alerting → PagerDuty/Opsgenie/Slack)

| Alert | Condition | Severity |
|---|---|---|
| High 5xx rate | 5xx > 2% of requests for 5 min | **page** |
| Latency SLO burn | p95 > 500 ms for 10 min | page |
| Backend down | `/health` failing on all replicas | **page** |
| DB unreachable / pool exhausted | readiness failing / `db_pool waiting` high | page |
| WAL archiving stalled | archive lag > 15 min | page (backup at risk) |
| Stripe webhook failures | verification failures > 0, or handling errors > 1% | page (billing) |
| Meter lag | usage-metering queue depth rising / lag > 1 h | ticket |
| Rate-limit surge | `rate_limit_rejections_total` spikes | ticket (possible abuse) |
| Desktop crash spike | crash-free sessions < 99.5% on a release | halt rollout + ticket |
| Cert/secret expiry | signing cert or TLS cert < 30 days | ticket |
| Disk/quota | DB or object-store > 80% | ticket |

Alerts are **symptom-based** (user-visible impact) not cause-based, to avoid alert fatigue. Every
paging alert links to a runbook.

### 7.3 On-call

- Rotation (PagerDuty/Opsgenie), primary + secondary, weekly handoff. Given the two-agent build
  model, the human owner is escalation of last resort; agents surface + triage.
- **Severity ladder:** SEV1 (prod down / data loss / billing broken) → immediate page + incident
  channel; SEV2 (degraded) → page business hours; SEV3 → ticket.
- **Incident process:** ack → mitigate (rollback is the first tool) → resolve → **blameless
  postmortem** for SEV1/2 with action items tracked as tickets (`docs/tickets/`).

### 7.4 SLOs & error budgets

| SLO | Target (30-day) | Error budget |
|---|---|---|
| API availability (`/health/ready` + 5xx < 1%) | **99.9%** | ~43 min/month |
| API latency (p95 < 300 ms on read routes) | 99% of requests | — |
| Profile sync success | 99.9% | — |
| Stripe webhook processing success | 99.95% | billing-critical, tighter |
| Desktop crash-free sessions | 99.5% | gates rollout |

**Error-budget policy:** budget spent → **freeze feature deploys**, shift to reliability work until
recovered. Budget healthy → ship faster / larger rollout steps. Burn-rate alerts (fast 1 h + slow
6 h windows) page before the budget is gone.

**Status:** planned (depends on §1 metrics/tracing landing first).

---

## 8. Billing operations

Stripe integration is currently **stubbed** (`billing.service.ts` returns fake checkout URLs;
`handleWebhook` acks without processing; the raw-body parser is a TODO in `billing.controller.ts`).
This section is the target ops model.

### 8.1 Stripe webhook reliability

- **Raw body required:** register `express.raw({ type: 'application/json' })` for the exact
  `/billing/webhook` path (the controller already reads `req.rawBody`) so
  `stripe.webhooks.constructEvent(rawBody, sig, secret)` verifies the signature. An unverifiable
  payload is **rejected 400** and increments `stripe_webhook_verification_failures_total`.
- **Fast-ack, async-process:** verify signature → persist the raw event (with Stripe's `event.id`)
  → **return 200 immediately** → process on the `webhooks` queue (§4.4). Stripe retries on non-2xx;
  a slow handler causes duplicate deliveries.
- **Idempotent (dedupe on `event.id`):** a `processed_stripe_events(event_id PK, processed_at)` table;
  a redelivered event that's already processed is a no-op 200 (§4.5).
- **Handled events:** `checkout.session.completed` (activate sub → set `tier` + `profileLimit`,
  store `stripeCustomerId`), `customer.subscription.updated` (sync `status`/`tier`),
  `customer.subscription.deleted` (downgrade to `free`), `invoice.payment_failed` (mark `past_due`,
  notify), `invoice.paid`. Each maps to the `Subscription` model (`teamId` PK, `tier`, `profileLimit`,
  `status`, `stripeCustomerId`).
- **Ordering:** events can arrive out of order — always reconcile against the current Stripe object
  (`subscription.status`) rather than assuming event sequence.

### 8.2 Usage-metering pipeline

Billing is **metered on profile count** (MASTER_PLAN §1; `Subscription.profileLimit`). Pipeline:

1. On profile create/delete, enqueue a `usage-metering` job (don't call Stripe inline).
2. The worker computes the team's **current profile count** and reports it to Stripe as a **meter
   event** (`stripe.billing.meterEvents.create({ event_name: 'profiles', payload: { value,
   stripe_customer_id } })`) — the exact call sketched in the `billing.service.ts` comment.
3. Report **absolute count** (idempotent set-to-N semantics), not deltas, so a lost/duplicated job
   self-heals on the next tick.
4. A **periodic reconciliation cron** (hourly) recomputes counts from Postgres and re-reports, so the
   meter can't drift from truth even if an event was dropped.

### 8.3 Reconciliation

- **Daily reconciliation job:** for each team, compare Postgres (`Subscription.tier/status`, profile
  count) against Stripe (subscription status, reported usage). Mismatches → alert + auto-heal where
  safe (re-report usage; flag tier mismatches for review).
- **Dunning:** `past_due` subscriptions follow Stripe Smart Retries; after the grace window the team
  is soft-limited (§8.4) not deleted; data retained per the retention policy.
- **Audit:** every subscription/tier/limit change is written to the **action log** (immutable audit,
  MASTER_PLAN Pillar 4) with actor, before/after, and the triggering Stripe `event.id`.

### 8.4 Quota enforcement

- **`profileLimit` is enforced server-side** on profile create (the `ProfilesService` gate referenced
  in the schema comment): creating past the limit → **402/403** with a clear "upgrade" payload; the
  desktop UI surfaces the upgrade path.
- **Plan-aware rate limits** (§4.1) read from the subscription tier (enterprise → higher RPM).
- **Grace, not cliff:** on downgrade/`past_due`, existing profiles keep working (read/sync) but
  **new creation is blocked** until under the new limit — never silently delete a paying user's data.
- **Single source of truth:** the tier→limits mapping (profileLimit, API RPM, seats) lives in one
  config module consumed by the quota guard, the rate limiter, and the pricing UI, so they never
  drift.

**Status:** all planned (Stripe client, webhook verification, raw-body parser, metering worker, and
reconciliation are stubs/TODOs today).

---

## Status vs target

**Built today (done/partial):** liveness `GET /health` (**done**); `JWT_SECRET` prod hard-fail
(**done**); single-service local `docker-compose` for Postgres (**partial**); Prisma schema +
`0001_init` with a documented manual `migrate deploy` (**partial**); a five-job GitHub Actions CI
that is a genuine **quality gate** (format/typecheck/build/test, gitleaks secret scan, Rust
fmt/clippy/test, live engine launch, and the live fingerprint detector gate) (**done**); Stripe,
S3, config validation, and the Nest `Logger` scaffolding present as **stubs** wired to real config
keys.

**Planned (the bulk of this doc):** structured JSON logging with correlation IDs + redaction;
Prometheus metrics; OpenTelemetry tracing; Sentry error tracking; readiness/startup/metrics probes;
desktop crash reporting + opt-in telemetry; the backend Dockerfile + MinIO-inclusive compose +
production topology (managed PaaS first, k8s later); environments/secrets management; the automated
gated `migrate deploy` step + expand/contract discipline + blue-green/rolling deploys; backups/PITR
+ DR game-days + S3 lifecycle; rate limiting + WAF/DDoS + autoscaling + BullMQ queues + idempotency;
desktop release channels + Authenticode signing + Apple notarization + Tauri auto-updater/update
server + staged rollout/rollback; semver + changelog automation + per-artifact CD pipelines + the
release checklist; dashboards/alerts/on-call/SLOs; and live Stripe webhook reliability + metering +
reconciliation + quota enforcement.

**Honest summary:** the *quality* gates are real and green; the *operations* layer — deploy,
observe, scale, deliver, bill-at-scale — is specified here and largely unbuilt. This doc is the
build-to target so that operational maturity ships deliberately alongside the product, not as an
afterthought. It stays consistent with MASTER_PLAN's posture: product launch is Lobium-only, and the
production-grade run-book must mature alongside the SaaS and native engine.
