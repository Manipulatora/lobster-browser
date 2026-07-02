# T-004 — Backend: Prisma migrate + real JWT auth

- **Pillar/Track:** C · Backend / SaaS
- **Assignee:** Codex
- **Status:** ready
- **Depends on:** T-006 (workspace wiring), a Postgres instance (docker compose)

## Goal

Turn the backend scaffold into a running service with a real data layer and working auth.

## Spec

- Add a `docker-compose.yml` (Postgres) under `apps/backend` for local dev.
- `prisma migrate dev` creates the schema (User/Team/Membership/Profile/ApiKey/Subscription).
- Implement `POST /auth/register` (argon2 password hash) and `POST /auth/login` (verify + sign JWT).
- JWT guard protecting authenticated routes; `GET /auth/me`.
- Responses use the `{ code, data, msg }` envelope.

## Files to touch

- `apps/backend/src/auth/**`, `apps/backend/prisma/**`, `apps/backend/docker-compose.yml`.

## Acceptance criteria

- `npm run start:dev` boots; `POST /auth/register` then `/auth/login` returns a valid JWT; `/auth/me`
  returns the user with the token, 401 without.
- `npm run typecheck` + `nest build` green.

## Test requirements

- e2e (supertest): register → login → access protected route; negative: bad password → 401.
