# Week 1–2 Build Guide: GitHub App Plumbing

## Context

`pr-reviewer` is an agentic PR review bot (see `roadmap.md`). The repo currently contains
only the roadmap — this is a greenfield build. Weeks 1–2 cover the unglamorous foundation:
a GitHub App that receives webhooks, proves they came from GitHub, refuses to process the
same delivery twice, and can mint tokens to call the API back.

Why this matters more than it looks: every later week assumes this layer is correct. If
signature verification is subtly wrong, you have an open endpoint. If idempotency is
racy, GitHub's redeliveries post duplicate reviews. These are the bugs that are invisible
in a demo and fatal in production — which is exactly why they're worth doing properly.

**Goal: a polished week 1–2, not a passing one.** The difference is specified in the
"Polish bar" of each milestone.

---

## Definition of done

Week 1–2 is complete when all of these are true:

1. `docker compose up -d` brings up Postgres + Redis; `npm run start:dev` boots the API.
2. `GET /healthz` returns 200 with real DB + Redis checks (not a hardcoded `{ok:true}`).
3. A real webhook from GitHub, relayed through smee, hits `POST /webhooks/github` and is
   accepted with a correct signature.
4. A tampered payload or wrong signature is rejected **401**, and nothing is written to the DB.
5. Clicking **Redeliver** in the App's Recent Deliveries returns 2xx but does **not**
   create a second row / does not re-run the handler.
6. Installing the App on a repo creates `Installation` + `Repo` rows; uninstalling marks
   them deleted **without destroying history**.
7. You can mint an installation token and successfully call
   `GET /repos/{owner}/{repo}` with it; a second call within the hour hits the Redis cache.
8. `npm test` and `npm run test:e2e` pass, including signature and idempotency cases.
9. `docs/decisions.md` has an entry per non-obvious choice.
10. `README.md` explains what exists and how to run it.

---

## Verified environment facts

Checked on this machine — no need to re-verify.

| Thing | Status |
|---|---|
| Node | v22.23.1 ✅ (Nest 12 needs ≥20) |
| npm | 10.9.8 ✅ |
| Docker / Compose | 29.6.1 / v5.2.0 ✅ |
| `gh` | 2.96.0, authed as `masabinhok` ✅ |
| **Port 3000** | **OCCUPIED — API goes on 3333** |
| Ports 5432 / 6379 | free ✅ |

### Traps — read before installing anything

**1. Prisma `latest` is a release candidate.** `npm view prisma version` → `8.0.0-rc.12`,
but `@prisma/client` latest → `7.10.0`. A bare `npm i prisma` gives you an RC CLI against
a stable client and confusing errors. **Pin both explicitly:**

```bash
npm i -D prisma@7.10.0
npm i @prisma/client@7.10.0
```

**2. `gh webhook forward` cannot forward GitHub App webhooks.** Confirmed by reading the
extension's source (`webhook/forward.go`) — it only accepts `--repo` and `--org` and
creates a *repository* webhook. Repo webhooks omit the `installation` object and never
deliver `installation.created` / `installation.deleted`. **Use smee.io.**

**3. `crypto.timingSafeEqual` throws** if the two buffers differ in length. Length-check
first, or a malformed signature header becomes a 500 instead of a 401.

### Version pins

```
@nestjs/*        12.x        prisma / @prisma/client  7.10.0
jest             30.x        supertest                7.2.2
zod              4.5.2       ioredis                  6.0.0
smee-client      5.0.0       postgres:18-alpine       redis:8-alpine
```

`@octokit/auth-app@8.3.0` exists and does the JWT dance for you — **don't use it in
weeks 1–2.** Hand-rolling it is the learning objective. Note it in `decisions.md` as the
production alternative.

---

## Milestone 0 — Monorepo scaffold + infra

```bash
cd /home/sabin/tech/pr-reviewer
mkdir -p apps docs
npm init -y
```

Edit root `package.json` → add `"private": true` and `"workspaces": ["apps/*"]`.

```bash
cd apps
npx @nestjs/cli@12 new api --package-manager npm --skip-git
cd ..
```

`docker-compose.yml` at the repo root — Postgres 18 + Redis 8, both with **healthchecks**
(polish: `depends_on: condition: service_healthy` so the API never boots against a
half-started DB), and a named volume so data survives restarts.

Create **two** databases: `pr_reviewer` and `pr_reviewer_test`. Simplest route is an init
script mounted at `/docker-entrypoint-initdb.d/` that runs
`CREATE DATABASE pr_reviewer_test;`.

Then config: install `zod@4.5.2`, and validate env **at boot** in a `ConfigModule` —
a missing `GITHUB_WEBHOOK_SECRET` must crash on startup, not on the first webhook at 2am.

`.env` (gitignored) + `.env.example` (committed, no real values):

```
PORT=3333
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/pr_reviewer
REDIS_URL=redis://localhost:6379
GITHUB_APP_ID=
GITHUB_APP_CLIENT_ID=
GITHUB_WEBHOOK_SECRET=
GITHUB_APP_PRIVATE_KEY_BASE64=
```

**Todo**
- [x] npm workspaces root, `apps/api` Nest app
- [x] `docker-compose.yml` with healthchecks + named volume + test DB
- [x] zod-validated config module, fails fast
- [x] `.env.example` committed, `.env` ignored
- [x] `GET /healthz` pinging Prisma (`SELECT 1`) and Redis (`PING`)
- [x] `enableShutdownHooks()` — Prisma and Redis disconnect cleanly on SIGTERM

**Polish bar:** boot with a deliberately missing env var and confirm a clear error naming
the variable. Kill the DB container and confirm `/healthz` goes unhealthy rather than 500ing.

**Learn:** Nest modules and DI, `ConfigModule` with a validation schema, lifecycle hooks.

---

## Milestone 1 — Register the GitHub App

Go to **https://github.com/settings/apps/new**.

- **Name:** anything unique (`pr-reviewer-dev-masabinhok`)
- **Homepage URL:** your repo URL
- **Webhook URL:** placeholder for now (`https://example.com`) — updated in Milestone 2
- **Webhook secret:** generate one and keep it:
  ```bash
  openssl rand -hex 32
  ```
- **Repository permissions:**
  - Contents → **Read-only**
  - Pull requests → **Read & write**
  - Checks → **Read & write**
  - Metadata → Read-only (forced, appears automatically)
- **Subscribe to events:** Pull request, Pull request review, Pull request review comment
  - *(`installation.*` events are delivered to Apps automatically — no checkbox exists)*
- **Where can this be installed:** Only on this account

Then: **Generate a private key** (downloads a `.pem`), and note the **App ID** and **Client ID**.

Store the key as base64 to avoid newline mangling in `.env`:

```bash
base64 -w0 ~/Downloads/your-app.*.private-key.pem
```

Paste into `GITHUB_APP_PRIVATE_KEY_BASE64`. **Delete the `.pem` from Downloads** and never
commit it. Decode at runtime with `Buffer.from(b64, 'base64').toString('utf8')`.

Create a throwaway repo to install onto:

```bash
gh repo create pr-reviewer-testbed --private --add-readme
```

Install the App on that repo only.

**Todo**
- [x] App registered with exactly the three permissions above
- [x] Webhook secret in `.env`, private key base64'd, `.pem` deleted
- [x] App installed on `pr-reviewer-testbed`
- [x] `.gitignore` covers `*.pem` and `.env`

**Polish bar:** run `git status` and `git log -p | grep -i "BEGIN RSA"` — confirm no key
material has ever been staged or committed.

---

## Milestone 2 — smee tunnel

```bash
npx smee-client@5 -u https://smee.io/YOUR_CHANNEL \
                  -t http://localhost:3333/webhooks/github
```

Flags (verified from source): `-u/--url`, `-t/--target`, `-p/--port`, `-P/--path`.
Running `npx smee-client` with no `-u` mints a fresh channel for you.

Get a channel at https://smee.io/new, then paste that URL into your App's
**Webhook URL** setting. smee relays payloads **verbatim**, so GitHub's real
`X-Hub-Signature-256` survives — you're testing the real thing.

Add a root script so you don't retype it:
`"tunnel": "smee-client -u $SMEE_URL -t http://localhost:3333/webhooks/github"`.

**Todo**
- [x] smee channel created, set as the App's Webhook URL
- [x] `npm run tunnel` script
- [x] Ping delivery reaches your local server (check App → Advanced → Recent Deliveries)

---

## Milestone 3 — Prisma schema

```bash
cd apps/api
npm i -D prisma@7.10.0 && npm i @prisma/client@7.10.0
npx prisma init --datasource-provider postgresql
```

Model the five entities from the roadmap, plus a sixth for idempotency.

**Design rules that separate this from a basic schema:**

- Never use GitHub's numeric IDs as your primary keys. Use your own `cuid()` and store
  `githubId BigInt @unique`. GitHub IDs exceed 32-bit — `BigInt`, not `Int`.
- **Soft-delete** `Installation` and `Repo` (`deletedAt DateTime?`). Uninstalling must not
  cascade-delete review history — that history is the product.
- Enums for `ReviewStatus`, `Severity`, `FindingSide`, `FindingStatus`, `FeedbackSignal` —
  not loose strings.
- Index every foreign key and anything you'll filter on (`Review.status`,
  `Finding.fingerprint`).

| Model | Key fields | Notes |
|---|---|---|
| `Installation` | `githubId` unique, `accountLogin`, `accountType`, `suspendedAt`, `deletedAt` | one per App install |
| `Repo` | `githubId` unique, `fullName` unique, `installationId` FK, `defaultBranch`, `private`, `deletedAt` | |
| `Review` | `repoId` FK, `prNumber`, `headSha`, `status`, `startedAt`, `completedAt`, `error`, token/cost fields, `checkRunId` | `@@unique([repoId, prNumber, headSha])` |
| `Finding` | `reviewId` FK, `filePath`, `line`, `side`, `severity`, `category`, `summary`, `whyItBreaks`, `suggestedFix`, `fingerprint`, `githubCommentId` | `fingerprint` is week 7's dedupe key — add the column now |
| `Feedback` | `findingId` FK, `signal`, `githubUserId` | `@@unique([findingId, githubUserId])` — one vote per user |
| `WebhookDelivery` | **`deliveryId String @unique`**, `event`, `action`, `installationId`, `receivedAt`, `processedAt`, `status` | the idempotency table |

Add forward-looking columns now (`Review.promptTokens`, `costCents`, `Finding.fingerprint`)
even though nothing writes them until weeks 5–8. Cheap now, a migration later.

```bash
npx prisma migrate dev --name init
```

Wrap Prisma in a proper `PrismaService extends PrismaClient implements OnModuleInit`.

**Todo**
- [x] Six models, enums, soft deletes, BigInt GitHub IDs
- [x] `@@unique([repoId, prNumber, headSha])` on Review
- [x] `WebhookDelivery.deliveryId` unique
- [x] Migration applied, `PrismaService` + `PrismaModule` wired
- [x] `npx prisma studio` opens and shows the tables

**Polish bar:** the migration runs cleanly from an empty database
(`docker compose down -v && docker compose up -d && npx prisma migrate deploy`).

**Learn:** Prisma relations, enums, indexes, `migrate dev` vs `migrate deploy`.

---

## Milestone 4 — Webhook endpoint + HMAC verification ⭐

**This is the milestone that matters.** Everything else is setup.

### The raw body problem

The signature is computed over the **exact bytes GitHub sent**. Verifying against
`JSON.stringify(req.body)` fails intermittently — key order and whitespace differ.

Per the NestJS docs, this is the correct API:

```ts
// main.ts
const app = await NestFactory.create<NestExpressApplication>(AppModule, {
  rawBody: true,   // do NOT also pass bodyParser: false
});
```

```ts
// controller
import { Controller, Post, RawBodyRequest, Req } from '@nestjs/common';
import { Request } from 'express';

@Post()
handle(@Req() req: RawBodyRequest<Request>) {
  const raw = req.rawBody; // Buffer
}
```

### The guard

Implement as a **Nest guard** (`GithubSignatureGuard`), not inline in the controller —
it's cross-cutting and independently testable.

Algorithm:
1. Read `X-Hub-Signature-256`. Missing → **401**.
2. Read `req.rawBody`. Missing/empty → **401** (means `rawBody: true` isn't set — fail loudly).
3. `expected = 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex')`
4. **Length-check both buffers** — `timingSafeEqual` *throws* on mismatched lengths.
5. `timingSafeEqual(received, expected)` → false means **401**.

Never use `===` on the signature. Never log the secret or the raw signature.

### The controller

- Route: `POST /webhooks/github`
- **ACK fast.** GitHub times out at ~10s. Record the delivery, return 2xx, then dispatch.
  Weeks 3–4 replace the dispatch with BullMQ — structure it so that swap is trivial.
- **Unknown events must return 2xx**, logged and ignored. A 500 on an unhandled event
  makes GitHub mark your endpoint unhealthy.
- Log `X-GitHub-Delivery` as a correlation ID on every line for that request.

**Todo**
- [x] `rawBody: true` in `main.ts`
- [x] `GithubSignatureGuard` with timing-safe compare + length guard
- [x] `POST /webhooks/github` returning 2xx quickly
- [x] Unhandled events → 2xx + log, never 500
- [x] Delivery ID threaded through logs
- [x] **Unit tests** (`signature.guard.spec.ts`): valid sig ✅, wrong sig ❌, tampered body ❌,
      missing header ❌, malformed header (no `sha256=`) ❌, wrong-length sig ❌ (must be 401, not 500)

**Polish bar:** using `curl` against your local endpoint with a hand-computed signature,
confirm 2xx; flip one byte of the body, confirm 401 **and** confirm nothing was written to
the DB. Confirm the malformed-header case returns 401 rather than crashing.

**Learn:** Nest guards and execution context, raw-body middleware, `node:crypto` HMAC,
timing attacks and why constant-time comparison exists.

---

## Milestone 5 — Idempotency

GitHub redelivers on timeout and on manual **Redeliver**. Same `X-GitHub-Delivery`, same
payload. Processing it twice means duplicate reviews on a PR.

**Do not do check-then-insert:**

```ts
// WRONG — two concurrent redeliveries both see "not found" and both proceed
const seen = await prisma.webhookDelivery.findUnique({ where: { deliveryId } });
if (seen) return;
await prisma.webhookDelivery.create({ ... });
```

**Let the database arbitrate.** The unique constraint is the lock:

```ts
try {
  await prisma.webhookDelivery.create({ data: { deliveryId, event, action } });
} catch (e) {
  if (e.code === 'P2002') return { duplicate: true };  // unique violation
  throw e;
}
```

Write this reasoning into `docs/decisions.md` — "why the DB constraint instead of a
pre-check" is a genuinely good interview answer.

**Todo**
- [x] Insert-first, catch `P2002`
- [x] Duplicates return 2xx (GitHub must not retry) but skip the handler
- [x] `processedAt` / `status` updated when handling finishes
- [x] Failed handlers recorded as `FAILED` with the error, not silently swallowed
- [x] Test: same delivery ID twice → one row, handler invoked once

**Polish bar:** hit **Redeliver** in Recent Deliveries. Confirm 2xx, exactly one row, and
a log line saying the duplicate was dropped.

---

## Milestone 6 — App JWT → installation token → Redis cache

Two-step auth, and the part people get wrong.

### Step 1: App JWT (RS256)

```
iss = App ID        iat = now - 60      exp = now + 600
```

- `iat` is backdated 60s for **clock skew** — GitHub rejects future-dated tokens.
- `exp` max is 10 minutes. Use 600, not more.
- Sign RS256 with the decoded private key.

### Step 2: Exchange for an installation token

```
POST /app/installations/{installation_id}/access_tokens
Authorization: Bearer <app-jwt>
→ { token: "ghs_...", expires_at: "..." }
```

Installation tokens last **1 hour**.

### Step 3: Cache in Redis

- Key: `gh:itoken:{installationId}`
- **TTL = (expires_at − now) − 60s.** Expiring your cache slightly early is correct; a
  token that expires mid-request is a flaky 401 you'll spend a day chasing.
- Cache the *installation* token. Never cache the App JWT.

Hand-roll this (the point is learning it). Add a `decisions.md` note that
`@octokit/auth-app` is what you'd reach for in production and why.

**Todo**
- [ ] `AppJwtService` — RS256, backdated `iat`, 600s `exp`
- [ ] `InstallationTokenService` — exchange + Redis cache with skew-adjusted TTL
- [ ] Cache miss → mint; cache hit → no network call
- [ ] Token values never logged (redact to `ghs_***`)
- [ ] `token.service.spec.ts`: cache hit, cache miss, near-expiry refresh
- [ ] Prove it end to end: fetch `GET /repos/masabinhok/pr-reviewer-testbed` with the token

**Polish bar:** call twice, and show via Redis (`redis-cli TTL gh:itoken:...`) that the
second call served from cache. Confirm the TTL is ~3540s, not 3600s.

**Learn:** JWT structure, RS256 vs HS256, why two token types exist, cache TTL skew.

---

## Milestone 7 — Installation lifecycle handlers

Events: `installation.created`, `installation.deleted`, and (bonus, cheap)
`installation.suspend` / `unsuspend`, `installation_repositories.added` / `removed`.

- **created** — upsert `Installation`, upsert each `Repo` in `payload.repositories`.
  Use `upsert`, not `create`: reinstalling after an uninstall must revive the old row
  (`deletedAt: null`), not collide on the unique constraint.
- **deleted** — set `deletedAt` on the installation *and* its repos. **Do not delete rows.**
  Review history must survive; a customer reinstalling should get their history back.
- **suspend/unsuspend** — set/clear `suspendedAt`.

**Todo**
- [ ] `installation.created` → upsert installation + repos, clears `deletedAt`
- [ ] `installation.deleted` → soft delete, history intact
- [ ] Suspend/unsuspend handled
- [ ] Handler dispatch is a map/switch that's easy to extend in week 3
- [ ] Test the install → uninstall → reinstall cycle

**Polish bar:** run the full cycle against the real App on `pr-reviewer-testbed`. After
reinstalling, the original `Installation` row is reused with `deletedAt` cleared.

---

## Milestone 8 — e2e tests, docs, README

### e2e harness

Against `pr_reviewer_test`, using supertest:

```
apps/api/test/
├── webhook.e2e-spec.ts
├── helpers/sign.ts              # HMAC helper shared with fixtures
└── fixtures/
    ├── ping.json
    ├── installation.created.json
    ├── installation.deleted.json
    └── pull_request.opened.json
```

**Get real fixtures, don't invent them:** App settings → Advanced → Recent Deliveries →
copy the actual payload JSON. Real payloads have fields your hand-written ones won't.

Cases to cover:
- valid signature → 2xx
- invalid signature → 401
- tampered body → 401
- missing signature header → 401
- duplicate delivery ID → 2xx, one row, handler runs once
- `installation.created` → rows created
- `installation.deleted` → soft-deleted, rows still present
- unknown event type → 2xx, no crash

Reset the DB between tests (truncate, or `prisma migrate reset --force --skip-seed`).

### Docs

`docs/decisions.md` — one paragraph each, written as you go, not retro-fitted:
- Why verify against the raw body
- Why a unique constraint instead of check-then-insert
- Why soft delete on uninstall
- Why TTL minus 60s skew
- Why hand-rolled JWT instead of `@octokit/auth-app`
- Why BigInt for GitHub IDs

`README.md` — what it is, architecture sketch, prerequisites, setup steps someone else
could actually follow, how to run tests, current status.

**Todo**
- [ ] e2e suite green against a test database
- [ ] Fixtures captured from real deliveries
- [ ] `docs/decisions.md` with ≥6 entries
- [ ] `README.md` a stranger could follow
- [ ] Optional: GitHub Actions CI running lint + unit + e2e

---

## Suggested pacing

| Days | Milestones |
|---|---|
| 1–2 | 0 (scaffold, compose, config, health) |
| 3 | 1–2 (App registration, smee) |
| 4–5 | 3 (Prisma schema + migration) |
| 6–7 | **4 (webhook + HMAC)** — the core, don't rush it |
| 8 | 5 (idempotency) |
| 9–10 | 6 (token auth + cache) |
| 11 | 7 (installation lifecycle) |
| 12–14 | 8 (e2e, docs, README, buffer) |

Commit small and daily, per your working rules. Conventional commits
(`feat(webhook): verify HMAC over raw body`) make the log readable later.

---

## Verification checklist

When week 1–2 is done, these are the checks to run (ask Claude with "verify week 1-2"):

1. `docker compose down -v && docker compose up -d` then `npx prisma migrate deploy` — clean-slate migration.
2. `npm run start:dev` — boots; `curl localhost:3333/healthz` → 200.
3. `npm test && npm run test:e2e` — green, and the test *bodies* contain real assertions.
4. A valid signed `curl` → 2xx; one flipped byte → 401 with no DB write.
5. Redeliver a real delivery → 2xx, one row.
6. Redis TTL on a cached token is ~3540s.
7. Install → uninstall → reinstall on the testbed; history survives.
8. `git log -p | grep -iE "BEGIN .*PRIVATE KEY|ghs_|ghp_"` → no hits.

Specific anti-patterns to grep for: `===` on signatures, `JSON.stringify` in the HMAC path,
check-then-insert idempotency, hard deletes on uninstall, missing length guard before
`timingSafeEqual`, and TTL set to the full 3600s.
