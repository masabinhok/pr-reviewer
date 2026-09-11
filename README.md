# pr-reviewer

A GitHub App that reviews pull requests. When a pull request is opened, GitHub sends a
webhook; the app verifies it, records it, and (from week 3) queues a job in which an agent
reads the diff, explores the repository for context, and posts inline review comments
anchored to specific lines.

This repository is a learning project, built milestone by milestone — see
[`roadmap.md`](roadmap.md) for the plan and [`week1-2.md`](week1-2.md) for the milestones
done so far. Non-obvious choices are written up in [`docs/decisions.md`](docs/decisions.md).

## Status

**Weeks 1–2 (GitHub App plumbing) are complete.** What works today:

- `POST /webhooks/github` verifies `X-Hub-Signature-256` over the raw request body
- Every delivery is recorded once; GitHub redeliveries are detected and dropped
- Installation lifecycle is tracked: install, uninstall (soft delete), suspend, repos added or removed
- App JWT → installation access token, cached in Redis until 60 s before it expires
- `GET /healthz` reports Postgres and Redis

Not yet: the review itself. `pull_request` deliveries are accepted and recorded, and
nothing else happens until week 3.

## Architecture

```mermaid
flowchart LR
    GH[GitHub] -- webhook --> SMEE[smee.io<br/>dev tunnel]
    SMEE --> API

    subgraph API [apps/api · NestJS]
        G[GithubSignatureGuard<br/>HMAC over raw body] --> C[WebhooksController]
        C --> S[WebhooksService<br/>insert-first idempotency<br/>dispatch table]
        S --> I[InstallationsService]
        I --> T[InstallationTokenService]
        T --> J[AppJwtService<br/>RS256]
    end

    S --> PG[(Postgres<br/>Prisma)]
    I --> PG
    T <--> R[(Redis<br/>token cache)]
    T -- JWT → token --> GHAPI[GitHub REST API]
```

A delivery goes: signature guard (401 on anything unsigned or tampered) → controller →
`WebhooksService`, which inserts a `WebhookDelivery` row first — the unique constraint on
the delivery ID is what makes redeliveries safe — then routes by `event.action` through a
dispatch table. Unknown events are acknowledged with a 200 and recorded as `IGNORED`, so
GitHub never sees a 500 for an event the app simply does not care about.

To call the GitHub API, the app signs a short-lived App JWT and exchanges it for an
installation token, which is cached in Redis per installation.

## Prerequisites

- **Node.js 22+** and npm
- **Docker** with Compose (runs Postgres 18 and Redis 8)
- **A GitHub App** you own, with a webhook secret and a generated private key.
  Repository permissions: Contents read-only, Pull requests read & write, Checks read &
  write (Metadata read-only is added automatically). Subscribe to the Pull request, Pull
  request review and Pull request review comment events — `installation` events need no
  checkbox; GitHub delivers them to every App.
- **A smee.io channel** ([smee.io/new](https://smee.io/new)) set as the App's webhook URL,
  so GitHub can reach your machine during development

## Setup

```bash
git clone https://github.com/masabinhok/pr-reviewer.git
cd pr-reviewer
npm install
cp .env.example .env
```

Fill in `.env`:

| Variable | Where it comes from |
|---|---|
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` | Anything you like; Compose creates the database from them |
| `DATABASE_URL` | `postgresql://USER:PASSWORD@localhost:5432/DB` using the three values above |
| `REDIS_URL` | `redis://localhost:6379` |
| `PORT` | `3333` (the tunnel script assumes it) |
| `GITHUB_APP_ID`, `GITHUB_APP_CLIENT_ID` | Your App's settings page |
| `GITHUB_WEBHOOK_SECRET` | The secret you set on the App's webhook |
| `GITHUB_APP_PRIVATE_KEY_BASE64` | The downloaded `.pem`, base64-encoded onto one line: `base64 -w0 your-app.private-key.pem` |
| `SMEE_URL` | Your smee.io channel URL |

Then start the infrastructure, apply migrations, and run the API:

```bash
docker compose up -d                              # Postgres + Redis (first run also creates pr_reviewer_test)
cd apps/api
npx prisma generate                               # Prisma client → src/generated (not committed)
npx prisma migrate deploy                         # schema → database
npm run start:dev                                 # API on http://localhost:3333
```

In a second terminal, from the repository root:

```bash
npm run tunnel                                    # smee → localhost:3333/webhooks/github
```

Check it is alive with `curl localhost:3333/healthz`, then install the App on a repository
and open a pull request — the API logs `accepted event "pull_request.opened"` with the
delivery ID.

To check the GitHub side end to end — JWT, token exchange, Redis cache — against a
repository the App is installed on:

```bash
cd apps/api && npm run prove:token owner/repo
```

## Tests

All commands run from `apps/api`, with `docker compose up -d` running.

```bash
npm test               # unit tests — no network, no database
npm run test:e2e       # e2e tests against the pr_reviewer_test database
npm run lint           # oxlint
```

The e2e suite drives the real HTTP endpoint with real payloads from `test/fixtures`, and
never touches your development database: it uses `pr_reviewer_test`, applies migrations
itself, and truncates between tests. To refresh the fixtures from your App's recent
deliveries (GitHub keeps a few days of history):

```bash
npm run capture:fixtures
```

## Layout

```
apps/api/
├── prisma/                 schema and migrations
├── src/
│   ├── guards/             webhook signature verification
│   ├── webhooks/           endpoint, idempotency, dispatch
│   ├── installations/      installation lifecycle handlers
│   ├── github/             App JWT, installation tokens, redaction
│   ├── health/             /healthz
│   ├── prisma/ redis/      clients as Nest providers
│   └── scripts/            prove:token, capture:fixtures
└── test/                   e2e suites, fixtures, helpers
docs/decisions.md           why things are the way they are
```
