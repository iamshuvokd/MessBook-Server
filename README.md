# Mess Manager Server

Accounts + multi-device sync layer for the [Mess Manager](../mess_manager) Flutter app.

The app is **offline-first** — every feature works with zero internet against
its local SQLite database. This server exists only to let a mess go online:
Google sign-in, an invite code, and background sync so every member sees the
same data on their own phone. It is never a hard dependency for the app.

## Stack

Node 22, Express, MySQL 8, `mysql2`, `jsonwebtoken`, `google-auth-library`, `zod`.

## Local development

```bash
cp .env.example .env
# fill in JWT_SECRET at minimum; GOOGLE_CLIENT_IDS/MASTER_ADMIN_EMAILS can
# stay empty for now (auth against real Google accounts needs Step 4)

docker compose up
```

This starts:

- `api` — the server, hot-reloading via `node --watch`, at `http://localhost:3000`
- `mysql` — MySQL 8 at `localhost:3306` (root / devroot)
- `adminer` — a DB browser at `http://localhost:8080`

First run needs the schema applied once:

```bash
docker compose exec api npm run db:migrate
```

### Without Docker

If you'd rather run against a MySQL you already have installed:

```bash
npm install
npm run db:migrate   # reads DB_* from .env
npm run dev
```

## Tests

```bash
npm test
```

The included tests only cover routes that don't touch the database (health
check, auth rejection) so they run without any MySQL instance. Fuller
integration tests belong here once Docker is available to run them against —
see `MESS_MANAGER_PLAN.md` in the app repo for the open item.

## Deploying

See `docker-compose.prod.yml`, `Caddyfile.example`, and
`.github/workflows/deploy.yml`. Deployment is wired for CI/CD (GitHub
Actions → ghcr.io → SSH pull-and-restart on the droplet) but stays inactive
until the `DROPLET_*` repo secrets are added — that's a deliberate later
step, not a missing piece.

## API surface

See `../MESS_MANAGER_ONLINE_PLAN.md` in the app repo for the full endpoint
list and schema rationale. Summary:

- `POST /auth/google`, `/auth/refresh`, `/auth/logout`, `GET /me`
- `POST /groups` (bring a mess online), `POST /groups/join`, `GET /groups`,
  `PATCH /groups/:id/members/:mid/role`, `DELETE /groups/:id/members/:mid`
- `POST /groups/:id/sync/pull`, `POST /groups/:id/sync/push`
- `POST /groups/:id/polls`, `GET /groups/:id/polls`, `POST /polls/:id/vote`
