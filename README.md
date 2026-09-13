# pr-reviewer

A GitHub App that reviews pull requests. When a pull request is opened or pushed to,
GitHub sends a webhook; the app verifies it and queues a review. A worker fetches the diff,
works out exactly which lines can take a comment, and asks a **LangGraph agent** to review
the change — reading the repository at that commit for context. The agent runs on a **local
model through Ollama by default, for free**, or on Claude with your own API key. Findings
with a concrete failure scenario are posted back as **one GitHub review with inline
comments**, and a Check Run on the PR shows progress and the summary.

![A pr-reviewer comment on a pull request: High · security — SQL query constructed with string interpolation](docs/images/review.png)

*A real comment from the local model, on the testbed's planted-bugs pull request.*

This repository is a learning project, built milestone by milestone — see
[`roadmap.md`](roadmap.md) for the plan, and [`week1-2.md`](week1-2.md),
[`week3-4.md`](week3-4.md) and [`week5-6.md`](week5-6.md) for the milestones so far.
Non-obvious choices are written up in [`docs/decisions.md`](docs/decisions.md).

## Status

**Weeks 1–4 are complete; weeks 5–6 (the agent) are built, tested and running locally.**
What works today:

- `POST /webhooks/github` verifies `X-Hub-Signature-256` over the raw request body
- Every delivery is recorded once; redeliveries are dropped, and a redelivery of one that
  failed is processed again
- Installation lifecycle is tracked: install, uninstall (soft delete), suspend, repos added or removed
- App JWT → installation token, cached in Redis until 60 s before it expires, evicted on suspend or uninstall
- A `pull_request` push becomes one queued review per commit; the webhook answers before the review runs
- The worker fetches the diff by commit SHA, parses it into a map of every commentable line,
  filters out lockfiles, generated, vendored and binary files, and refuses PRs over 50 files
  or 2000 changed lines
- The **agent** (`apps/agent`, Python) reviews the change with read-only tools over a
  snapshot of the repository at the head commit, and hands in findings through a strict tool
- Findings are validated against the diff, fingerprinted, and kept to one per line; those at
  or above `POST_MIN_SEVERITY` (high, by default) are posted as **one `COMMENT` review** —
  never an approval — exactly once, however the job is retried
- A `pr-reviewer` Check Run spins on the PR while the review runs and completes with a
  summary, the model that answered, and what the review cost
- The agent's answer is stored the moment it arrives, so a retry never pays for it twice
- Failed reviews retry with backoff; GitHub rate limits are waited out without using up
  retries; errors a retry can't fix fail the review at once
- `GET /healthz` reports Postgres and Redis

The app can also run with the deterministic stub reviewer (`REVIEWER=stub`), which flags
`console.log`, `debugger` and new `TODO`s and needs no model at all.

How good are the reviews? Honestly, with the free default, modest. On the testbed's
planted-bugs PR the local 7B model finds 1–2 of 7 planted defects, and a prompt injection
planted in the diff measurably suppresses its findings
([`docs/evals/planted-bugs.md`](docs/evals/planted-bugs.md)). Reviewing four real pull
requests in this repository, it found nothing real — every finding was noise, and the medium
ones would have been posted. That is why only high-severity findings are posted by default.
A stronger model is one setting away for anyone with an API key; weeks 9–10 turn this into
evals.

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
        P --> AR[AgentReviewer]
        W --> PUB[ReviewPublisher<br/>one COMMENT review, once]
        P --> A[GithubApiService]
        PUB --> A
        A --> T[InstallationTokenService]
        T --> J[AppJwtService<br/>RS256]
    end

    subgraph AGENT [apps/agent · Python]
        EP[POST /reviews] --> SNAP[snapshot<br/>tarball at head SHA]
        EP --> LG[LangGraph<br/>call_model ⇄ run_tools]
        LG --> TOOLS[read-only tools<br/>get_file · search_repo · …]
        TOOLS --> SNAP
    end

    AR -- contract --> EP
    LG -- anthropic SDK --> OLLAMA[Ollama · local model<br/>default, free]
    LG -. your key .-> CLAUDE[Claude<br/>claude-opus-5]
    PR -- review-pr job --> Q[(Redis<br/>BullMQ · token cache)]
    Q --> W
    T <--> Q
    S --> PG[(Postgres<br/>Prisma)]
    I --> PG
    PR --> PG
    W --> PG
    A -- installation token --> GHAPI[GitHub REST API]
    SNAP --> GHAPI
```

**A delivery:** the signature guard rejects anything unsigned or tampered with a 401. The
controller hands the delivery to `WebhooksService`, which inserts a `WebhookDelivery` row
first — its unique constraint is what makes redeliveries safe — then routes by
`event.action`. Unknown events get a 200 and are recorded as `IGNORED`.

**A pull request:** `PullRequestsService` writes a `PENDING` `Review` for the head commit
(unique per repo, PR and SHA) and enqueues a job carrying only its ID; the webhook returns. The worker opens a Check Run
and runs `ReviewPipeline`: list the changed files, filter them, fetch the diff between the
review's exact base and head SHAs, parse it, filter again, then ask the reviewer.

**The agent:** `AgentReviewer` posts the reviewable files and a fresh installation token to
the agent (`contracts/` holds the request and response both test suites check). The agent
downloads the repository at the head SHA, then loops between the model and its tools until
the model calls `submit_review`. Everything from the PR is treated as data, never
instructions; the tools only read. Ollama serves the same Messages API as Claude, so one
SDK client and one graph drive either; Claude's extra features (adaptive thinking, prompt
caching, strict tools) are used only when the model is Claude.

**Back in the API:** the answer is stored, validated against the line map, and written as
`Finding` rows. Findings at or above the posting bar are posted as one GitHub review; the Check Run is
completed with the summary; the review is marked `COMPLETED`. Each step records that it
happened, so a retry after a failure part-way through picks up where it stopped.

## Prerequisites

- **Node.js 22+** and npm
- **Python 3.12+** and [`uv`](https://docs.astral.sh/uv/) for the agent
- **Docker** with Compose (runs Postgres 18 and Redis 8)
- **A GitHub App** you own, with a webhook secret and a generated private key.
  Repository permissions: Contents read-only, Pull requests read & write, Checks read &
  write (Metadata read-only is added automatically). Subscribe to the Pull request, Pull
  request review and Pull request review comment events — `installation` events need no
  checkbox; GitHub delivers them to every App.
- **A smee.io channel** ([smee.io/new](https://smee.io/new)) set as the App's webhook URL,
  so GitHub can reach your machine during development
- **[Ollama](https://ollama.com)** for the agent's model. The default, qwen2.5 7B with a
  32k context window, needs about 6.5 GB of GPU memory (an 8 GB card is enough); on a
  smaller one Ollama runs part of it on the CPU, more slowly.
- *Optional:* an **Anthropic API key**, to review with Claude instead. Every review is then
  billed to it.

## Setup

```bash
git clone https://github.com/masabinhok/pr-reviewer.git
cd pr-reviewer
npm install
(cd apps/agent && uv sync)
ollama pull qwen2.5:7b
npm run agent:model        # builds pr-reviewer:qwen2.5-7b: the same model, with a 32k window
cp .env.example .env
```

Ollama gives every model a 4096-token context unless told otherwise, and silently drops the
start of a longer conversation — for the agent, its instructions and the diff. `agent:model`
builds a variant from [`apps/agent/ollama/Modelfile`](apps/agent/ollama/Modelfile) with room
for a review.

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
| `AGENT_URL` | `http://localhost:8000` |
| `AGENT_SHARED_SECRET` | Any long random string: `openssl rand -hex 32` |
| `AGENT_PROVIDER` | `ollama` (the default, free) or `anthropic` (Claude, your key) |
| `ANTHROPIC_API_KEY` | Only for `anthropic`: [console.anthropic.com](https://console.anthropic.com) |

A key in the environment never switches the provider on its own; Claude is used only when
`AGENT_PROVIDER=anthropic` says so.

Optional: `REVIEWER` (`agent` or `stub`; defaults to `agent` when `AGENT_URL` is set),
`AGENT_MODEL` (default `pr-reviewer:qwen2.5-7b` on Ollama, `claude-opus-5` on Anthropic),
`OLLAMA_URL` (default `http://localhost:11434`), `AGENT_CONTEXT_TOKENS` (the local model's
window, default 32768 — keep it equal to `num_ctx` in the Modelfile), `AGENT_EFFORT`
(Claude only, default `high`), `AGENT_MAX_TURNS` / `AGENT_MAX_TOOL_CALLS` (20 / 40),
`AGENT_TIMEOUT_MS` (how long the API
waits for the agent, default 15 minutes), `POST_MIN_SEVERITY` (the least severe finding
posted as a comment: `high`, the default, `medium` or `low`), `QUEUE_PREFIX` (Redis key prefix for the queue,
default `pr-reviewer`) and `REVIEW_RETRY_DELAY_MS` (first retry delay, default 10000,
doubling after).

Then start the infrastructure, apply migrations, and run the three processes:

```bash
docker compose up -d                              # Postgres + Redis (first run also creates pr_reviewer_test)
cd apps/api
npx prisma generate                               # Prisma client → src/generated (not committed)
npx prisma migrate deploy                         # schema → database
npm run start:dev                                 # API + worker on http://localhost:3333
```

From the repository root, in two more terminals:

```bash
npm run agent                                     # the agent on http://127.0.0.1:8000 (Ollama must be running)
npm run tunnel                                    # smee → localhost:3333/webhooks/github
```

Check it is alive with `curl localhost:3333/healthz`, install the App on a repository, and
open a pull request. The API logs `accepted event "pull_request.opened"`, a `pr-reviewer`
check appears on the PR, and a review with inline comments follows for any finding at or
above the posting bar.

## Checking against the real GitHub

These scripts run the app's own code against a repository the App is installed on. Run
them from `apps/api`; each builds first.

| Script | What it proves |
|---|---|
| `npm run prove:token <owner/repo>` | JWT → installation token → Redis cache; the second call is served from cache |
| `npm run prove:diff <owner/repo> <pr> [name]` | The diff fetched by SHA matches the PR's own, and what the filters would keep. With a name, saves the file list and diff as test fixtures |
| `npm run prove:line-map <owner/repo> <pr>` | The line map agrees with GitHub about which lines can take a comment — GitHub is asked, via pending reviews it never publishes |
| `npm run prove:findings <owner/repo> <pr>` | Each stored finding of the PR's latest review lands on the line of code it describes |
| `npm run try:review <owner/repo> <pr> [path]` | One real review of a real pull request, printed — no Review row, no Check Run, nothing posted. The loop for tuning a model or a prompt. `DUMP_REQUEST=x.json` instead writes the agent's request, which `uv run python scripts/replay.py` (in `apps/agent`) replays offline |
| `npm run review:stats [n]` | Recent reviews: status, time, turns, tokens and cache hits, cost, findings posted |
| `npm run capture:fixtures` | Copies recent real webhook deliveries into `test/fixtures` |

## Tests

None of the suites need Ollama, an API key or the network.

```bash
cd apps/api
npm test               # unit tests — no database
npm run test:e2e       # e2e — needs `docker compose up -d`
npm run lint           # oxlint

cd ../agent
uv run pytest          # the agent, against a scripted fake model
uv run ruff check .
```

The API's e2e suite uses the `pr_reviewer_test` database (migrated and truncated by the
suite) and Redis database 1, and fakes GitHub — and, in one file, the agent — at the
`fetch` boundary with responses captured from real calls. Everything else — the HTTP
endpoint, the queue, the worker, the pipeline, posting — runs for real. The agent's suite gives the agent
a fake client that returns real SDK message objects, and fakes GitHub with an `httpx2`
transport. The request and response in `contracts/` are generated by one side and checked
by the other, so the two services can't drift apart unnoticed.

The testbed's planted-bugs PR, with its answer key in
[`docs/evals/planted-bugs.md`](docs/evals/planted-bugs.md), is the hand-judged check of the
agent itself until weeks 9–10 turn it into evals.

## Layout

```
apps/api/                     NestJS: webhooks, queue, worker, GitHub, posting
├── prisma/                   schema and migrations
├── src/
│   ├── guards/               webhook signature verification
│   ├── webhooks/             endpoint, idempotency, dispatch
│   ├── installations/        installation lifecycle handlers
│   ├── reviews/              pull_request → Review + job; worker, pipeline, publisher, Check Run
│   ├── diff/                 unified diff parser and the line map
│   ├── filters/              which files are reviewed, and PR size limits
│   ├── reviewer/             Reviewer interface, AgentReviewer, stub, finding validation
│   ├── github/               App JWT, installation tokens, API client, redaction
│   ├── queue/                BullMQ connection
│   ├── health/               /healthz
│   ├── prisma/ redis/        clients as Nest providers
│   └── scripts/              prove:*, review:stats, capture:fixtures
└── test/                     e2e suites, fixtures, helpers
apps/agent/                   Python: the review agent
├── src/pr_agent/
│   ├── agent/                LangGraph graph, prompt, submit_review, pricing
│   ├── repo/                 repository snapshot and read-only tools
│   └── main.py               POST /reviews
├── ollama/Modelfile          the local model, with a context window big enough for a review
└── tests/
contracts/                    the API ↔ agent request and response
docs/decisions.md             why things are the way they are
docs/evals/                   answer keys for judging the agent
```
