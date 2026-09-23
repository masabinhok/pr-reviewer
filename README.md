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

**Measured**, on 29 real pull requests with known answers, three runs each: the local 7B model
posts **2% of the known bugs as comments, at 0.04 false comments per clean pull request**. It
finds ten times as many — 21% — but they sit below the posting bar, in the Check Run. The
numbers, how they were measured and what they hide are in
[`docs/evals/report.md`](docs/evals/report.md).

This repository is a learning project, built milestone by milestone — see
[`roadmap.md`](roadmap.md) for the plan, and [`week1-2.md`](week1-2.md),
[`week3-4.md`](week3-4.md), [`week5-6.md`](week5-6.md), [`week7-8.md`](week7-8.md) and
[`week9-10.md`](week9-10.md) for the milestones so far, and
[`week11-12.md`](week11-12.md) for what is being built now.
Non-obvious choices are written up in [`docs/decisions.md`](docs/decisions.md).

## Status

**Weeks 1–10 are complete:** the GitHub App plumbing, the review pipeline, the agent, noise
control with a dashboard, and an evaluation that measures it. What works today:

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
- Every finding then gets a **second look**: checked on its own, in a fresh conversation,
  against the code around its line. Refuted findings are dropped, unconfirmed ones demoted
  to low; the Check Run lists what was dropped and why
- A push to a PR never re-posts a comment already on it: a finding near code an earlier
  review commented on is stored as a repeat, and the Check Run counts it
- A comment whose code is gone, and whose problem the review no longer finds, is resolved and
  collapsed as outdated; a person resolving the thread on GitHub resolves it too
- 👍 and 👎 on the App's comments are collected as feedback — polled, since GitHub has no
  reaction webhook, with ETags so an unchanged comment costs no rate limit
- A dashboard (`apps/web`, Next.js) over a read-only API behind a bearer token: where findings
  go, every review and its findings with their verdicts and feedback, and the installations
- Findings are validated against the diff, fingerprinted, and kept to one per line; those at
  or above `POST_MIN_SEVERITY` (high, by default) are posted as **one `COMMENT` review** —
  never an approval — exactly once, however the job is retried
- A `pr-reviewer` Check Run spins on the PR while the review runs and completes with a
  summary, the model that answered, and what the review cost
- The agent's answer is stored the moment it arrives, so a retry never pays for it twice
- Failed reviews retry with backoff; GitHub rate limits are waited out without using up
  retries; errors a retry can't fix fail the review at once
- `GET /healthz` reports Postgres and Redis
- `npm run eval` reviews 29 real pull requests with known answers through the production code,
  three times, and reports recall and false positives with their spread; CI runs every suite and
  refuses a change to the reviewer that has no evaluation run to go with it

The app can also run with the deterministic stub reviewer (`REVIEWER=stub`), which flags
`console.log`, `debugger` and new `TODO`s and needs no model at all.

How good are the reviews? Measured, with the free default: quiet, and nearly useless. The local
7B model posts 2% of known bugs as comments, at 0.04 false comments per clean pull request. It
does better than that suggests: without its second look it finds 81% of the held-out bugs. But it
rates almost everything low or medium, so almost nothing reaches the posting bar, and the second
look discards two in three of the real ones. Two attempts to fix that were measured and reverted
([`docs/evals/report.md`](docs/evals/report.md)). A stronger model is one setting away for anyone
with an API key, and the same evaluation would measure it.

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
        W --> PUB[ReviewPublisher<br/>one COMMENT review, once<br/>repeats skipped]
        W --> STALE[StaleFindings<br/>retire comments whose code is gone]
        FB[FeedbackPoller<br/>👍 👎, polled with ETags] --> A
        DASH[DashboardController<br/>read-only, bearer token]
        P --> A[GithubApiService]
        PUB --> A
        STALE --> A
        A --> T[InstallationTokenService]
        T --> J[AppJwtService<br/>RS256]
    end

    subgraph AGENT [apps/agent · Python]
        EP[POST /reviews] --> SNAP[snapshot<br/>tarball at head SHA]
        EP --> LG[LangGraph<br/>call_model ⇄ run_tools]
        LG --> TOOLS[read-only tools<br/>get_file · search_repo · …]
        TOOLS --> SNAP
        LG --> VERIFY[verify<br/>a second look at each finding]
    end

    WEB[apps/web · Next.js<br/>dashboard] -- server-side, token --> DASH

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
    DASH --> PG
    FB --> PG
    A -- installation token --> GHAPI[GitHub REST + GraphQL]
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
the model calls `submit_review`, then checks every finding again in a fresh conversation and
drops the ones the code disproves. Everything from the PR is treated as data, never
instructions; the tools only read. Ollama serves the same Messages API as Claude, so one
SDK client and one graph drive either; Claude's extra features (adaptive thinking, prompt
caching, strict tools) are used only when the model is Claude.

**Back in the API:** the answer is stored, validated against the line map, and written as
`Finding` rows — each one near code an earlier review already commented on is marked a repeat.
Findings at or above the posting bar that aren't repeats are posted as one GitHub review;
earlier comments whose code has changed, and whose problem wasn't found again, are resolved and
collapsed; the Check Run is completed with the summary; the review is marked `COMPLETED`. Each
step records that it happened, so a retry after a failure part-way through picks up where it
stopped.

**Afterwards:** a scheduled job polls 👍 and 👎 on the App's comments into `Feedback`, and the
dashboard reads everything back through a read-only API.

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
`AGENT_VERIFY` / `AGENT_MAX_VERIFICATIONS` (the second look: on, 15 findings per review),
`AGENT_TIMEOUT_MS` (how long the API
waits for the agent, default 15 minutes), `FEEDBACK_POLL_MS` (how often reactions are polled,
default 300000; 0 turns it off), `DASHBOARD_TOKEN` (the dashboard API's bearer token; unset, the
dashboard is off), `POST_MIN_SEVERITY` (the least severe finding
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

## The dashboard

![The dashboard's overview: 41 findings proposed, 6 refuted by the second look, 35 kept, 13 posted, 3 marked wrong; reviews per day; the second look, feedback and the agent](docs/images/dashboard.png)

How the reviewer is doing, from the reviewer's own records: where its findings go (proposed,
refuted by the second look, kept, posted, marked wrong with a 👎), every review with what it
posted and why the rest wasn't, and the installations it runs on. It reads the API's
read-only `/api/dashboard` endpoints from its own server, with `DASHBOARD_TOKEN`; the token
never reaches the browser.

```bash
npm run web                                       # http://localhost:3000 — needs the API running
```

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

## The evaluation

`evals/fixtures/` holds 29 real pull requests with known answers: 20 real bug fixes from
open-source repositories, **reversed** so the reviewed change reintroduces the bug, the testbed's
planted-bugs PR, and 9 merged changes believed clean. Each says where it came from and how its
answer was decided ([`evals/README.md`](evals/README.md)).

```bash
docker compose up -d             # Redis, for the testbed fixture's token
npm run agent:eval               # the agent, keeping public tarballs in evals/.cache
cd apps/api && npm run eval      # 3 runs × 29 fixtures, into evals/runs/<time>/
```

A full run is 87 reviews and takes about an hour on an 8 GB GPU (26 s per review at the median).
It writes each result as it finishes, so `--resume <dir>` carries on a stopped run. Then read each
location match the report lists and mark it `right` or `wrong` in the run's `judgments.json`, and
`--report <dir>` rewrites the report.

What the numbers mean:

- **Recall** — of the known bugs, the share found. **Precision** — of the findings, the share at a
  known bug. **False positives per clean PR** — findings on a pull request with nothing wrong.
- **Posted** counts what met the posting bar — the comments a person sees. **Kept** counts what
  survived the second look and validation — the Check Run's list.
- Every number is the mean over runs with its range; a change only counts as better if it beats
  the baseline by more than the range.
- **Held-out** fixtures decide whether a change is kept; **tune** fixtures are the ones to look at
  while making it.

CI can't run a model, so it checks that someone did: a stamp of the prompts, tools, second look,
settings, validation and posting bar must match a complete run in `evals/runs/`, or the `eval gate`
workflow fails and says what to run (`npm run eval:check` locally).

## Tests

None of the suites need Ollama, an API key or the network.

```bash
cd apps/api
npm test               # unit tests — no database
npm run test:e2e       # e2e — needs `docker compose up -d`
npm run lint           # oxlint

cd ../agent
uv run pytest          # the agent, against a scripted fake model
uv run python scripts/verify_eval.py   # the second look, measured on findings of known truth (needs Ollama)
uv run ruff check .

cd ../web
npm test               # the dashboard's formatting and funnel
npm run build && npm run test:smoke   # every page, against a fake API — up, and down
```

The API's e2e suite uses the `pr_reviewer_test` database (migrated and truncated by the
suite) and Redis database 1, and fakes GitHub — and, in one file, the agent — at the
`fetch` boundary with responses captured from real calls. Everything else — the HTTP
endpoint, the queue, the worker, the pipeline, posting — runs for real. The agent's suite gives the agent
a fake client that returns real SDK message objects, and fakes GitHub with an `httpx2`
transport. The request and response in `contracts/` are generated by one side and checked
by the other, so the two services can't drift apart unnoticed.

Every push runs these in GitHub Actions — `api` (with Postgres and Redis as services), `agent`,
`web` — each only when its part changed, and the `eval gate` described above.

## Layout

```
apps/api/                     NestJS: webhooks, queue, worker, GitHub, posting
├── prisma/                   schema and migrations
├── src/
│   ├── guards/               webhook signature verification
│   ├── webhooks/             endpoint, idempotency, dispatch
│   ├── installations/        installation lifecycle handlers
│   ├── reviews/              pull_request → Review + job; worker, pipeline, publisher, repeats,
│   │                         stale comments, the per-PR lock, Check Run
│   ├── diff/                 unified diff parser and the line map
│   ├── filters/              which files are reviewed, and PR size limits
│   ├── reviewer/             Reviewer interface, AgentReviewer, stub, finding validation
│   ├── github/               App JWT, installation tokens, API client (REST and GraphQL), redaction
│   ├── feedback/             reactions polled into Feedback, and the feedback rate
│   ├── dashboard/            the read-only dashboard API, its token guard, JSON-safe output
│   ├── queue/                BullMQ connection
│   ├── health/               /healthz
│   ├── prisma/ redis/        clients as Nest providers
│   ├── evals/                fixtures, scoring, the report, the stamp
│   └── scripts/              prove:*, review:stats, capture:fixtures, eval, eval:fixture, eval:check
└── test/                     e2e suites, fixtures, helpers
apps/agent/                   Python: the review agent
├── src/pr_agent/
│   ├── agent/                LangGraph graph, prompt, submit_review, the second look, pricing
│   ├── repo/                 repository snapshot and read-only tools
│   └── main.py               POST /reviews
├── ollama/Modelfile          the local model, with a context window big enough for a review
├── evals/verify/             findings of known truth, for measuring the second look
├── scripts/                  replay.py (a review offline), verify_eval.py (the second look, measured)
└── tests/
apps/web/                     Next.js: the dashboard
├── app/                      overview, reviews, a review, installations
├── components/               the funnel, the daily chart, severity and verdict tags
├── lib/                      the server-only API client, formatting, the funnel
└── scripts/smoke.mjs         every page against a fake API
contracts/                    the API ↔ agent request and response
docs/decisions.md             why things are the way they are
docs/evals/                   the measured report, and the planted bugs' answer key
evals/fixtures/               29 pull requests with known answers
evals/runs/                   committed evaluation runs: results, judgments, report
.github/workflows/            api, agent, web, and the eval gate
```
