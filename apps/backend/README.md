# 🦞 @lobster/backend

The Lobster Browser **cloud SaaS API** — a [NestJS 10](https://nestjs.com) service providing
auth, teams, encrypted profile sync, and billing. Persistence is Postgres via
[Prisma](https://www.prisma.io); encrypted profile blobs live in S3-compatible object storage
(Postgres holds only a reference + metadata).

> **Status: auth implemented (T-004).** Real password hashing (bcryptjs) + JWT auth with a
> `JwtAuthGuard` and `GET /auth/me`. The data layer persists to **Postgres via Prisma when
> `DATABASE_URL` is set**, and falls back to an **in-memory store** for local dev / tests (no DB
> required to boot). JWT signing **hard-fails in production** if `JWT_SECRET` is unset. Teams,
> profiles, and billing remain stubs (Track C). This app is part of the root npm workspaces.

## Wire contract

Every endpoint returns the shared `{ code, data, msg }` envelope from
[`@lobster/shared-types`](../../packages/shared-types) (`code === 0` means success), re-exported
locally from [`src/common/api-response.ts`](src/common/api-response.ts). Domain shapes
(`User`, `Team`, `Membership`, `Profile`, `Subscription`, …) are imported from that package so
the cloud API never drifts from the desktop UI or the local automation API.

## Running

```bash
# From the repo root:
npm install

# Local dev WITHOUT a database — the in-memory user store is used, auth works end to end:
cd apps/backend
npm run start:dev                        # listens on PORT (default 8080)

# With Postgres (the real data layer):
cp .env.example .env                     # set DATABASE_URL + a real JWT_SECRET
docker compose up -d                     # starts Postgres on :5432
npx prisma migrate deploy                # applies prisma/migrations (0001_init)
npm run start:dev

# Production-style run
npm run build && npm run start

# Type-check / test (safe in CI at any time; no DB needed)
npm run typecheck
npm test
```

Quick smoke test once running: `curl http://localhost:8080/health` → `{"code":0,"data":{"status":"ok"},"msg":"success"}`.

## Scripts

| Script | Command | Purpose |
|--------|---------|---------|
| `build` | `nest build` | Compile to `dist/` |
| `start` | `node dist/main.js` | Run the compiled server |
| `start:dev` | `nest start --watch` | Dev server with hot reload |
| `typecheck` | `prisma generate && tsc --noEmit` | Type-check (regenerates the Prisma client first) |
| `test` | `prisma generate && tsc && node --test` | Unit + e2e (`*.spec.js`) — no DB required |
| `prisma:generate` | `prisma generate` | Regenerate the Prisma client |

## HTTP surface

| Method | Path | Module | Notes |
|--------|------|--------|-------|
| GET | `/health` | health | Liveness probe |
| POST | `/auth/register` | auth | **Real**: bcrypt hash + signed JWT; rejects duplicate email |
| POST | `/auth/login` | auth | **Real**: verifies password, returns a signed JWT (401 on bad creds) |
| GET | `/auth/me` | auth | **Real**: `JwtAuthGuard`-protected; returns the current user |
| POST | `/teams` … | teams | Create/invite/list/set-role (stubs) |
| POST | `/profiles` … | profiles | CRUD + `/:id/sync` (stubs; per-plan limit gate) |
| POST | `/billing/checkout`, `/billing/webhook` | billing | Stripe (calls commented; stub) |

## Auth internals

- `auth.service.ts` — register/login/validateUser; bcryptjs hashing; JWT via `@nestjs/jwt`.
- `jwt-secret.ts` — `resolveJwtSecret()`: real `JWT_SECRET` required in production, dev fallback otherwise.
- `jwt-auth.guard.ts` — verifies the Bearer token and attaches the user to the request.
- `users.repository.ts` + `in-memory-users.repository.ts` + `prisma-users.repository.ts` — the
  repository abstraction; `auth.module.ts` picks Prisma when `DATABASE_URL` is set, else in-memory.
- `../prisma/` — global `PrismaModule`/`PrismaService` (connects only when `DATABASE_URL` is set).
- Tests: `auth.service.spec.ts` (unit) + `auth.e2e.spec.ts` (supertest: register → login → /auth/me, 401 paths).

## Deferred to Track C

- Wire teams/profiles services to Prisma (persistence + team-scoped authorization).
- S3 streaming for encrypted profile blobs (presigned URLs; plaintext never touches the server).
- Live Stripe: Checkout, raw-body webhook verification, usage metering on profile count.
- Email OTP; admin-only mutation guards.
