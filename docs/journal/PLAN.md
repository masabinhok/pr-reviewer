# Plan: pr-reviewer to showcase-ready

Follows `AUDIT.md` (2026-11-10, commit `c572b2d`). Finding IDs (B1, I1, …) refer to it.

**Constraints:**
- Everything stays free to host and run.
- No claim goes in without being verified.
- Each stage leaves `main` working, with all suites green.
- Commits go straight to `main`, in conventional style, with no co-author trailer.

**The eval gate is a constraint on the whole plan.** CI fails any change to the stamped files
unless a fresh 3-run evaluation (about an hour on your GPU) is committed with it. Your GPU driver
wasn't loaded on 2026-11-10. The stamped files are:

- `apps/agent/src/pr_agent/{agent/graph,agent/prompt,agent/submit,agent/verify,config,main,repo/tools}.py`
- `apps/agent/ollama/Modelfile`
- `apps/api/src/reviewer/validate-findings.ts`
- the posting bar default

**Nothing below touches them.** Where a fix would (N5, the Ollama retry), it is cut. The formatting
pass excludes `validate-findings.ts`.

---

## The shape of the live demo (the decision everything else follows)

The reviewer's model can't be hosted for free:
- Ollama needs a GPU, or many minutes per review on CPU.
- Hugging Face's docs now say Docker Spaces need a paid plan.
- Claude is bring-your-own-key.

So the proposal has two parts.

**1. Always-on live demo (free):** the real App, end to end, with the **deterministic stub reviewer**
(`REVIEWER=stub`, which already exists). The stub flags `console.log`, `debugger` and new `TODO`s
and needs no model. A visitor sees the actual pipeline in seconds:
- the signed webhook and the idempotent delivery record
- the queue and the worker
- the Check Run
- line-anchored inline comments, posted exactly once
- the dashboard

**2. The AI, shown honestly:**
- the existing PR comments the local 7B model really posted on the testbed (visible to anyone once
  the testbed is public)
- a recorded GIF of a real local review
- the committed evaluation report
- dashboard seed data exported from your real local reviews

**What it trades off:** the hosted bot does not run the LLM. The README says so in its first
screen: "the live demo runs the deterministic stub; the AI reviewer runs locally on a GPU, and here
is what it did".

**Rejected options:**
- **Free hosted LLM APIs** (Gemini or Groq free tiers): the agent speaks the Anthropic Messages API,
  so a new provider means editing stamped files plus a new eval. Some free tiers also train on
  inputs, which matters when the input is visitors' code. A possible later project.
- **A small model on a free CPU host:** reviews over 5 minutes (I1), worse quality than the
  measured model, and no free host found that runs Docker plus Ollama.
- **A tunnel to your own GPU:** that isn't "stays live". It's fine for an interview, by switching
  `AGENT_URL` and `REVIEWER` by hand; it's in the README as an option only.

### Free hosting setup

| Piece | Where | Free-tier facts that matter (checked 2026-11-11) |
|---|---|---|
| API + worker (one process) | **Render**: free web service, Docker | Sleeps after 15 min with no inbound traffic, and takes about a minute to wake. GitHub times a webhook out at **10 s and never redelivers automatically**, so a sleeping API loses the first delivery. **Mitigation:** a keep-alive ping every 10 min. 750 free instance-hours a month covers one always-on service (a month is at most 744 h). |
| Queue + token cache | **Render Key Value** (free, 1 per workspace) | In-memory, and Render may restart it at any time, losing queued jobs. That's acceptable for a demo: a lost job leaves a PENDING review, and a new push re-queues. **Not Upstash:** its free 500K commands a month is reported to run out quickly under an idle BullMQ worker. Set the eviction policy to `noeviction`; BullMQ requires it. |
| Postgres | **Neon** free | 1 GB storage, 100 CU-hours per project per month, scales to zero. Render's free Postgres expires (30 days per most sources) and has no backups, so not that. **Budget:** at 0.25 CU, a compute kept awake all month uses about 186 CU-h and would run out. So the keep-alive must hit a route that doesn't touch the database (`GET /`, not `/healthz`), and feedback polling drops to hourly (`FEEDBACK_POLL_MS=3600000`). My estimate is about 15–30 CU-h a month; check it in Neon's dashboard after a week. |
| Dashboard | **Vercel** Hobby | Next.js native, root directory `apps/web`. Function limit 300 s, and a cold API wake takes ~60 s, so pages survive even without the keep-alive. Hobby is for non-commercial use, which a portfolio is. |
| Keep-alive | **GitHub Actions** cron in this repo | `*/10 * * * *` → `curl -fsS $DEMO_API_URL/`. Free for public repos. GitHub may delay or skip scheduled runs under load, so the keep-alive isn't guaranteed. If that turns out not to be enough, use cron-job.org (free), set up by you. |
| Agent | **Not deployed** | See above. |

**Alternative:** Koyeb's free instance wakes in 1–5 s, which is under GitHub's 10 s, so no
keep-alive would be needed. But its limits were contradictory in every source (one service,
specs reported as 0.1 vCPU or 1 vCPU, and a reported card hold). Render's are documented. Pick
Koyeb only if Render's keep-alive proves unreliable.

**Accounts:** I can't create accounts or paste secrets into dashboards. Stage 6 lists exactly what
you click and paste; I prepare the files and verify the result.

---

## Stages

Each stage ends with every suite passing (`npm test`, `npm run test:e2e`, `npm run lint`, `tsc`,
`uv run pytest`, `ruff`, web `test` + `build` + `test:smoke`, `eval:check`) and one or more
commits.

### Stage 1: Repo hygiene and dead code (about 1.5 h)
- Add an MIT `LICENSE` (your choice of license), and make the root and `apps/api` license fields
  agree.
- Delete the Nest scaffold: `app.controller.ts`, `app.service.ts`, `app.controller.spec.ts`, and
  `apps/api/README.md`. `GET /` returns `{"name":"pr-reviewer","health":"/healthz"}`; the
  keep-alive needs it.
- Remove the `deploy` script and `@nestjs/mau`, `@nestjs/mapped-types` (`"*"`), the root `zod`,
  and `vite-tsconfig-paths` (switch to `resolve.tsconfigPaths: true`). Declare `dotenv` in
  `apps/api` (I9).
- Root `package.json`: a `test` script that runs the workspaces, and remove `main`,
  `directories` and the empty `description`. Remove the generator comments from `schema.prisma`
  and `prisma7.config.ts`.
- `agentRules: false` in `apps/web/next.config.ts` (I7). Disable `x-powered-by` in `main.ts` (N1).
- Move `roadmap.md`, `week*.md` and `docs/*.html` into `docs/journal/`, and fix the links that
  point at them.
- Commits: `chore: add MIT license`, `refactor(api): remove the Nest starter controller`,
  `chore(deps): drop unused packages, declare dotenv`, `chore(web): stop next dev writing agent
  files`, `docs: move the build journal into docs/journal`.

### Stage 2: Formatting, enforced (about 30 min)
- Add `.prettierignore` listing `src/generated/` and `src/reviewer/validate-findings.ts`, the
  stamped file.
- Run `npm run format` once, as a standalone commit, and put its hash in `.git-blame-ignore-revs`.
- Add `npx prettier --check "src/**/*.ts" "test/**/*.ts"` to `.github/workflows/api.yml`.
- Commits: `style(api): format with prettier`, `ci(api): check formatting`.

### Stage 3: The two real bugs (about 2.5 h)
- **I1:** in `agent-reviewer.ts`, pass the request a dispatcher whose `headersTimeout` and
  `bodyTimeout` equal `AGENT_TIMEOUT_MS` (`undici`'s `Agent`; this adds `undici` as a dependency,
  justified because Node's built-in copy isn't importable). Log `e.cause?.code`, so the error says
  `UND_ERR_HEADERS_TIMEOUT` rather than `TypeError`.
  - Test: a local server that delays its headers past a lowered undici default proves the
    configured timeout governs.
  - Re-run the 304 s repro from the audit, if your GPU or CPU allows.
- **I3:** `app.useBodyParser('json', { limit: '25mb' })` in `main.ts`, so raw-body signing still
  works. Add an e2e case: a signed 200 KB delivery gets a 200.
- Neither file is stamped. The gate is unaffected.
- Commits: `fix(reviewer): let AGENT_TIMEOUT_MS govern the agent request, not undici's 5 minutes`,
  `fix(api): accept webhook payloads up to GitHub's 25 MB`.

### Stage 4: Dependencies (about 1 h)
- Bump `next` to `16.4.6` (exact pin, as now), then `npm update` within the existing ranges, and
  re-run `npm audit`. Report what remains and whether it's reachable. Don't chase majors.
- `uv lock --upgrade-package certifi --upgrade-package urllib3 --upgrade-package langgraph-sdk`.
  `uv.lock` isn't stamped. These three are transport and SDK patches, not the model client.
- Commit: `chore(deps): patch known advisories`.

### Stage 5: Deployable (about 3 h)
- `apps/api/Dockerfile`, multi-stage:
  - build: `npm ci -w api --include-workspace-root`, `prisma generate`, `nest build`
  - run: `node dist/main` on Node 22 slim, non-root
- Migrations run as a pre-deploy command (`npx prisma migrate deploy`). Prisma needs Neon's
  **direct** URL for migrations and works with the **pooled** URL at runtime, so check
  `prisma7.config.ts` on both.
- Make `POSTGRES_USER/PASSWORD/DB` optional in the API's env schema (`app.module.ts`). Only
  Compose uses them, and today a host must set fake values.
- Agent: the bind host comes from `AGENT_HOST`, default `127.0.0.1`, read in `__main__.py`, which
  isn't stamped (B1). There's no agent Dockerfile, because it isn't deployed.
- `render.yaml` blueprint: the API web service (Docker, health check `/healthz`, pre-deploy
  migrate) and the free Key Value instance.
- `.github/workflows/keepalive.yml`: the `*/10` cron that curls `GET /`.
- Verify locally: `docker build` and run against Compose's Postgres and Redis, then `/healthz` and a
  signed webhook, end to end with the stub.
- Commits: `build(api): Dockerfile and Render blueprint`, `feat(agent): AGENT_HOST for running
  outside localhost`, `ci: keep the demo API awake`.

### Stage 6: Deploy (about 2.5 h, much of it yours, in dashboards)
1. **Make `pr-reviewer-testbed` public.** It's private today. Its existing PRs hold the local
   model's real comments, and they're the "see it without signing up" path. Check its contents
   first; I'll list what's there before you flip it.
2. **Neon:** create a project and copy both connection strings, pooled and direct.
3. **A second GitHub App, `pr-reviewer-demo`.** Your dev App stays on smee.
   - Permissions: Contents read; Pull requests read & write; Checks read & write.
   - Events: Pull request, Pull request review, Pull request review comment.
   - Webhook URL `https://<render-app>.onrender.com/webhooks/github`, a new secret, and a new
     private key.
   - Make it public, so visitors can install it, and install it on the testbed.
4. **Render:** New → Blueprint → this repo. Set the API's environment:

   | Variable | Value |
   |---|---|
   | `DATABASE_URL` | Neon pooled URL (`?sslmode=require`) |
   | `DIRECT_DATABASE_URL` | Neon direct URL, for `migrate deploy` (name settled in Stage 5) |
   | `REDIS_URL` | Render Key Value internal URL |
   | `GITHUB_APP_ID`, `GITHUB_APP_CLIENT_ID` | the demo App's settings page |
   | `GITHUB_WEBHOOK_SECRET` | the demo App's webhook secret |
   | `GITHUB_APP_PRIVATE_KEY_BASE64` | `base64 -w0 demo-app.pem` |
   | `REVIEWER` | `stub` |
   | `POST_MIN_SEVERITY` | `low`. The stub rates its findings medium or low, so at the default `high` the demo would post nothing. |
   | `DASHBOARD_TOKEN` | `openssl rand -hex 32` |
   | `FEEDBACK_POLL_MS` | `3600000` (hourly, for the Neon budget) |
   | `NODE_ENV` | `production` |

   `PORT` is set by Render, and the config reads it.
5. **Vercel:** import the repo with root directory `apps/web`. Set `DASHBOARD_API_URL` to the
   Render URL, and `DASHBOARD_TOKEN` to the same value as on Render. The token stays server-side;
   the dashboard pages are public and read-only, by design.
6. **This repo:** add the Actions variable `DEMO_API_URL` for the keep-alive.
7. **Verify, me with you:**
   - `/healthz` is up, and `/` answers.
   - Open a PR on the testbed that adds a `console.log`. A Check Run appears, then an inline
     comment, then the review shows on the dashboard.
   - Push again: no duplicate comment.
   - Redeliver from the App's settings: the delivery is dropped as a duplicate.
   - Record the timings for the README.
8. **Unverified, to test in this stage:** a PR **from a fork** into the testbed. Visitors would
   use this path. GitHub sends `pull_request` for fork PRs, but I haven't checked our diff fetch on
   one.

### Stage 7: Demo data (about 2.5 h)
- Write `apps/api/src/scripts/demo-export.ts`. It reads **your local dev database** (the
  `pr-reviewer_postgres_data` volume, which I haven't opened) and writes
  `apps/api/prisma/demo/data.json` with:
  - installations, repos, reviews, findings and feedback for **public repos only**
  - IDs as strings
  - `agentResult` dropped (bulky, and not shown)
  - error strings checked for anything token-shaped; the redaction already exists
- Write `apps/api/src/scripts/demo-seed.ts`. It loads that file idempotently, using upserts on the
  existing unique keys, so it's safe to re-run on Neon.
- **Before committing `data.json`, I show you what's in it.** It's real data from real reviews,
  captured on stated dates, and the README says so. Nothing is invented. If the local DB holds too
  little, the fallback is the stub filling the demo database from testbed PRs, which is real but
  stub-only.
- Unit test: the seed's mapping from export to rows, plus a round trip in the e2e suite's database.
- Commits: `feat(scripts): export public review history as demo data`, `feat(scripts): seed the
  demo database`, `chore: demo data captured from local reviews`.

### Stage 8: README rewrite (about 3 h)
Target: the first screen sells it, and the rest lets someone run it. About a third of today's
length. Today's depth moves to `docs/`.

1. **Name + one-line pitch:** "A GitHub App that reviews pull requests with an LLM agent, posts
   only line-anchored findings it can justify, and measures itself against 29 real bugs."
2. **Live demo links:**
   - the dashboard (Vercel)
   - the testbed PRs with real model comments
   - "install the demo App", plus the stub caveat in one sentence
3. **GIF:** opening a PR → Check Run spinning → an inline comment. **Recording:** you record it with
   Peek or OBS, or I do it with the browser extension if it's connected. Keep
   `docs/images/review.png` and `dashboard.png`, and re-shoot the dashboard on the deployed
   seed.
4. **Features:** 6–8 bullets, each a real guarantee: signature over the raw body, idempotent
   deliveries, exactly-once posting, the line map, the second look, no re-posting across pushes,
   feedback via reactions, and the eval with its CI gate.
5. **Architecture:** a simplified mermaid diagram (~10 nodes) and one paragraph per hop. The full
   diagram moves to `docs/architecture.md`.
6. **Measured, honestly:** the eval table (posted 2%, 0.04 false comments per clean PR; kept 21%;
   held-out 81% with the second look off, reverted because posted stayed 0%), what it means, and
   that weeks 11–12 target it.
7. **Tech stack** table.
8. **Local setup in a few commands:** the stub path first (Compose → migrate → seed → `start:dev`
   → `web`; works with dummy GitHub values for the dashboard), then "add a GitHub App", then
   "add the local model".
9. **Environment variables table:** each variable, which service reads it, whether it's required,
   and its default. Generated from `configuration.ts` and `config.py` by reading them, not memory.
10. **Deployment notes:** the free setup above, what sleeps, the keep-alive, and the Neon budget.
11. **Known limitations:**
    - the hosted demo runs the stub
    - the local model posts 2% of known bugs
    - Render Key Value can lose queued jobs
    - single-user dashboard token
    - no `/review` command or per-repo config yet
12. **License**, and links to `docs/decisions.md` and `docs/journal/`.
- Move the `prove:*`/`try:review` scripts table to `docs/scripts.md`.
- **GitHub:**
  - description: the pitch line
  - topics: `github-app`, `code-review`, `llm`, `langgraph`, `nestjs`, `nextjs`, `ollama`,
    `bullmq`, `prisma`, `evaluation`
  - homepage: the dashboard URL
  - make the repo public (after Stage 1's license, and after you've seen the final tree)
- Commit: `docs: rewrite the README for the live demo`.

### Stage 9: Portfolio card material (about 1 h)
`docs/portfolio.md`. Every number below is verified now or comes from the committed eval;
anything Stage 6 measures is added then.

- **Problem:** AI code review bots are noisy. They comment on everything, re-post on every push,
  and nobody measures whether they're right.
- **Design choices:**
  - only post what has a concrete failure scenario and anchors to a commentable line
  - a second-look checker in a fresh conversation
  - exactly-once posting across retries
  - local-first, free by default
  - measure before claiming
- **How it was built:**
  - NestJS API with worker, BullMQ, Postgres/Prisma, a Python LangGraph agent, a Next.js
    dashboard, and a cross-language contract tested from both sides
  - built 2026-08-28 to 2026-09-23 in milestones, with 202 commits
  - built with AI pair-programming; say so plainly, the history shows it
- **Deployed:** the free setup above, and what's live versus local.
- **Real numbers:**
  - 29 PRs with known answers: 19 reversed bug fixes from 8 open-source projects, 1 planted-bug
    PR, 9 clean
  - 87 reviews per evaluation; posted recall 2%, 0.04 false comments per clean PR; kept recall 21%
  - median review 26 s on an 8 GB GPU, $0
  - 410 unit + 72 e2e + 128 agent + 8 dashboard tests; 93% unit statement coverage
  - about 7,500 lines of non-test source
  - 13 migrations
- Commit: `docs: portfolio write-up`.

---

## Scope cuts (removed or deferred, not fixed)

| Cut | Why |
|---|---|
| Weeks 11–12 (confidence-based posting, `/review`, `.prreviewer.yml`) | They're product work and need GPU evals. The showcase ships first; when weeks 11–12 land, they update one README table. |
| A hosted LLM in the demo | See "The shape of the live demo". |
| An agent Dockerfile and agent hosting | Not deployed; `AGENT_HOST` is enough for anyone who wants to. |
| N5, Ollama retries | `main.py` is stamped, so the fix would need a 3-run eval. Documented as a known quirk instead. |
| N3 JSON logs, N4 payload validation | Low value for the demo; logs are readable in Render as-is. |
| Rewriting git history (commit names, trailers) | Destructive, breaks merged-PR links, and the history is the honest record. |
| The Go diff service on the old roadmap | Never started; removed from the plan. |
| Dashboard login | The demo dashboard is meant to be public over demo data. GitHub login stays out of scope (`docs/decisions.md`). |

---

## Time estimate

| Stage | Estimate |
|---|---|
| 1 Hygiene | 1.5 h |
| 2 Formatting | 0.5 h |
| 3 Bugs I1, I3 | 2.5 h |
| 4 Dependencies | 1 h |
| 5 Deployable | 3 h |
| 6 Deploy (with you) | 2.5 h |
| 7 Demo data | 2.5 h |
| 8 README + GIF | 3 h |
| 9 Portfolio write-up | 1 h |
| **Total** | **about 17.5 h, 2–3 working days** |

Stages 1–5 need nothing from you. Stage 6 needs your accounts. Stage 7 needs your local database
running. Stage 8's GIF needs either you or the browser extension.

## What I need from you before starting

1. Approval of the demo shape: the stub live, the AI shown through real recorded output.
2. MIT license, or another?
3. OK to make `pr-reviewer` and `pr-reviewer-testbed` public at Stage 6/8, after you've seen the
   contents.
4. Whether the README and portfolio say "built with AI pair-programming". My recommendation is
   yes, in one line.

---

## Implementation notes (Stages 1–5, 2026-11-11)

Where the work departed from the plan above, and why:

- **Stage 1:** `GET /` lives on `HealthController`, so there's no new module. The generator-comment
  removal is its own commit, and `X-Powered-By` got its own commit too.
- **Stage 2:** Prettier needed a second pass on 3 files before `--check` was stable. Both passes are
  in the one formatting commit.
- **Stage 3:**
  - The test needs the server's headers 2.5 s late, not 0.5 s, because undici checks timeouts
    about once a second. I confirmed it fails without the fix (`UND_ERR_HEADERS_TIMEOUT`).
  - `undici` is pinned to major 6, the copy Node 22's fetch uses, so its `Agent` is the same
    dispatcher interface.
  - The 304 s live repro wasn't re-run; the unit test exercises the same mechanism.
  - The app setup moved into `configureApp` (`src/configure-app.ts`), so the e2e suite tests what
    `main.ts` runs.
- **Stage 4:** `npm update` and `npm audit fix` both crashed npm 10's resolver (`edgesOut`). The
  cause was the split vitest majors (api on 4, web on 5.0.1). I aligned both on 5 and regenerated
  `package-lock.json` within the existing ranges, using npm 11 to resolve it and npm 10 `npm ci` to
  install, as CI does. The result is 0 npm and 0 pip-audit vulnerabilities.
- **Stage 5:**
  - **Migrations:** Render's pre-deploy command is paid-only, so `prisma migrate deploy` runs at
    container start (about 3 s to ready with nothing pending), and `prisma` moved to
    `dependencies`.
  - **Variables:** `DIRECT_DATABASE_URL` is the migrate URL. The `POSTGRES_*` variables were removed
    from the API's schema, not made optional, because the API never reads them.
  - **Health check:** Render's health check uses `/`, not `/healthz`. Render polls it, and
    `/healthz` queries Postgres, which would keep Neon awake.
  - **Image:** 927 MB, mostly the Prisma CLI kept for the migrate-at-start step.
  - **Still unverified:** whether Neon's scale-to-zero counts open idle pool connections. Watch the
    CU-hours in the first week.

## Implementation notes (Stages 6–9, 2026-11-12)

- **Stage 6:**
  - The demo App is `pr-reviewer-demo-1`, and the Render service is `pr-reviewer-api-jous`.
  - Webhooks failed at first because the App's URL still had the guessed service name, and the App
    wasn't installed.
  - GitHub Actions is blocked by an account billing lock, so the keep-alive runs on cron-job.org.
    The workflow takes over once Actions is unlocked.
  - Verified: 10 s from opening a PR to a finished Check Run (testbed PR #8), no duplicate on a
    second push, and a redelivery with no side effects. Fork PRs are left "not verified", the
    user's choice.
- **Stage 7:**
  - `agentResult` is kept, not dropped, because the dashboard reads the model, turns and refuted
    findings from it.
  - The local database was read through a `pg_dump` copy, never touched.
  - 24 reviews were exported. The 3 on `pr-reviewer` aren't seeded, because the demo App isn't
    installed there (the user's choice).
  - The work surfaced a bug: the e2e setup migrated whatever `DIRECT_DATABASE_URL` named. Fixed.
- **Stage 8:**
  - The GIF's screenshots surfaced another bug: the review body called low findings "medium" at
    the low bar. Fixed.
  - The README and this plan said "20 reversed bug fixes"; the fixtures hold 19, plus 1 planted.
    Corrected.
  - The Playwright tools needed a Chrome that isn't installed, so the screenshots came from
    Playwright's cached Chromium in headless mode.
- **Stage 9:** `docs/portfolio.md`. Every number was re-measured from its source.
