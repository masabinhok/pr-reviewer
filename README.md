# pr-reviewer

A GitHub App that reviews pull requests. When a pull request is opened or pushed to,
GitHub sends a webhook; the app verifies it, queues a review, and a worker fetches the
diff, works out which lines can take a comment, runs a reviewer over the changed code, and
reports back on the PR through a Check Run. From weeks 5–6 the reviewer is an agent that
posts inline review comments anchored to specific lines.

This repository is a learning project, built milestone by milestone — see
[`roadmap.md`](roadmap.md) for the plan, and [`week1-2.md`](week1-2.md) and
[`week3-4.md`](week3-4.md) for the milestones done so far. Non-obvious choices are written
up in [`docs/decisions.md`](docs/decisions.md).

## Status

**Weeks 1–4 are complete** — the GitHub App plumbing, and the job pipeline and diff
handling. What works today:

- `POST /webhooks/github` verifies `X-Hub-Signature-256` over the raw request body
- Every delivery is recorded once; redeliveries are dropped, and a redelivery of one that
  failed is processed again
- Installation lifecycle is tracked: install, uninstall (soft delete), suspend, repos added or removed
- App JWT → installation token, cached in Redis until 60 s before it expires, evicted on suspend or uninstall
- A `pull_request` push becomes one queued review per commit; the webhook answers before the review runs
- The worker fetches the diff by commit SHA, parses it into a map of every commentable line,
  filters out lockfiles, generated, vendored and binary files, and refuses PRs over 50 files
  or 2000 changed lines
- A `pr-reviewer` Check Run spins on the PR while the review runs and completes with a summary
- Findings are validated against the diff, fingerprinted, and stored
- Failed reviews retry with backoff; GitHub rate limits are waited out without using up retries
- `GET /healthz` reports Postgres and Redis

Not yet: the reviewer is a stub that flags `console.log`, `debugger` and new `TODO`s, and
findings appear only in the Check Run summary. Weeks 5–6 replace the stub with a LangGraph
agent and post findings as review comments.

## Architecture

```mermaid
flowchart LR
    GH[GitHub] -- webhook --> SMEE[smee.io<br/>dev tunnel]
    SMEE --> G

    subgraph API [apps/api · NestJS]
        G[GithubSignatureGuard<br/>HMAC over raw body] --> C[WebhooksController]
        C --> S[WebhooksService<br/>insert-first idempotency<br/>dispatch table]
        S --> I[InstallationsService]
        S --> PR[PullRequestsService<br/>Review row, then enqueue]
        W[ReviewProcessor<br/>worker] --> P[ReviewPipeline<br/>files → filter → diff →<br/>parse → reviewer → validate]
        P --> A[GithubApiService]
        W --> A
        A --> T[InstallationTokenService]
        T --> J[AppJwtService<br/>RS256]
    end

    PR -- review-pr job --> Q[(Redis<br/>BullMQ queue<br/>token cache)]
    Q --> W
    T <--> Q
    S --> PG[(Postgres<br/>Prisma)]
    I --> PG
    PR --> PG
    W --> PG
    A -- installation token --> GHAPI[GitHub REST API<br/>files · compare · Check Runs]
```

**A delivery:** the signature guard rejects anything unsigned or tampered with a 401. The
controller hands the delivery to `WebhooksService`, which inserts a `WebhookDelivery` row
first — its unique constraint is what makes redeliveries safe — then routes by
`event.action`. Unknown events get a 200 and are recorded as `IGNORED`.

**A pull request:** `PullRequestsService` writes a `PENDING` `Review` for the head commit
(unique per repo, PR and SHA) and enqueues a job carrying only its ID. The webhook returns.
The worker picks the job up, opens a Check Run, and runs `ReviewPipeline`: list the changed
files, filter them, fetch the diff between the review's exact base and head SHAs, parse it,
filter again, run the reviewer, and validate every finding against the parsed diff. The
findings and the `COMPLETED` status are written in one transaction, and the Check Run is
completed with a summary.

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

Optional: `QUEUE_PREFIX` (Redis key prefix for the queue, default `pr-reviewer`) and
`REVIEW_RETRY_DELAY_MS` (first retry delay, default 10000, doubling after).

Then start the infrastructure, apply migrations, and run the API — the review worker runs
inside the same process:

```bash
docker compose up -d                              # Postgres + Redis (first run also creates pr_reviewer_test)
cd apps/api
npx prisma generate                               # Prisma client → src/generated (not committed)
npx prisma migrate deploy                         # schema → database
npm run start:dev                                 # API + worker on http://localhost:3333
```

In a second terminal, from the repository root:

```bash
npm run tunnel                                    # smee → localhost:3333/webhooks/github
```

Check it is alive with `curl localhost:3333/healthz`, install the App on a repository, and
open a pull request. The API logs `accepted event "pull_request.opened"`, the review runs,
and a `pr-reviewer` check appears on the PR.

## Checking against the real GitHub

These scripts run the app's own code against a repository the App is installed on. Run
them from `apps/api`; each builds first.

| Script | What it proves |
|---|---|
| `npm run prove:token <owner/repo>` | JWT → installation token → Redis cache; the second call is served from cache |
| `npm run prove:diff <owner/repo> <pr> [name]` | The diff fetched by SHA matches the PR's own, and what the filters would keep. With a name, saves the file list and diff as test fixtures |
| `npm run prove:line-map <owner/repo> <pr>` | The line map agrees with GitHub about which lines can take a comment — GitHub is asked, via pending reviews it never publishes |
| `npm run prove:findings <owner/repo> <pr>` | Each stored finding of the PR's latest review lands on the line of code it describes |
| `npm run capture:fixtures` | Copies recent real webhook deliveries into `test/fixtures` |

## Tests

All commands run from `apps/api`, with `docker compose up -d` running.

```bash
npm test               # unit tests — no network, no database
npm run test:e2e       # e2e tests
npm run lint           # oxlint
```

The e2e suite never touches your development data: it uses the `pr_reviewer_test`
database (migrated and truncated by the suite itself) and Redis database 1, and fakes
GitHub at the `fetch` boundary with responses captured from real calls. Everything else —
the HTTP endpoint, the queue, the worker, the pipeline — runs for real.

## Layout

```
apps/api/
├── prisma/                 schema and migrations
├── src/
│   ├── guards/             webhook signature verification
│   ├── webhooks/           endpoint, idempotency, dispatch
│   ├── installations/      installation lifecycle handlers
│   ├── reviews/            pull_request → Review + job; worker, pipeline, Check Run summary
│   ├── diff/               unified diff parser and the line map
│   ├── filters/            which files are reviewed, and PR size limits
│   ├── reviewer/           Reviewer interface, stub reviewer, finding validation
│   ├── github/             App JWT, installation tokens, API client, redaction
│   ├── queue/              BullMQ connection
│   ├── health/             /healthz
│   ├── prisma/ redis/      clients as Nest providers
│   └── scripts/            prove:* and capture:fixtures
└── test/                   e2e suites, fixtures, helpers
docs/decisions.md           why things are the way they are
```
