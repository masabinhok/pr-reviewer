# Development

Everything for running pr-reviewer on your own machine with the AI agent, checking it against real GitHub, measuring it, and testing it. The README's quick start runs it with the stub reviewer.

## Prerequisites

- **Node.js 22+** and npm
- **Python 3.12+** and [`uv`](https://docs.astral.sh/uv/) for the agent
- **Docker** with Compose (runs Postgres 18 and Redis 8)
- **A GitHub App** you own, with a webhook secret and a generated private key.
  Repository permissions: Contents read-only, Pull requests read & write, Checks read &
  write (Metadata read-only is added automatically). Subscribe to the Pull request, Pull
  request review, Pull request review comment and Pull request review thread events —
  `installation` events need no checkbox; GitHub delivers them to every App.
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
builds a variant from [`apps/agent/ollama/Modelfile`](../apps/agent/ollama/Modelfile) with room
for a review.

Fill in `.env`:

| Variable | Where it comes from |
|---|---|
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` | Anything you like; Compose creates the database from them |
| `DATABASE_URL` | `postgresql://USER:PASSWORD@localhost:5432/DB` using the three values above |
| `DIRECT_DATABASE_URL` | Optional: a direct, unpooled URL for `prisma migrate`, when `DATABASE_URL` goes through a pooler (Neon's does) |
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

![The dashboard's overview: 41 findings proposed, 6 refuted by the second look, 35 kept, 13 posted, 3 marked wrong; reviews per day; the second look, feedback and the agent](images/dashboard.png)

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

`evals/fixtures/` holds 29 real pull requests with known answers: 19 real bug fixes from
open-source repositories, **reversed** so the reviewed change reintroduces the bug, the testbed's
planted-bugs PR, and 9 merged changes believed clean. Each says where it came from and how its
answer was decided ([`evals/README.md`](../evals/README.md)).

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
