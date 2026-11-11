# Audit: pr-reviewer, toward a portfolio showcase

Audited 2026-11-10 at commit `c572b2d` (main, clean). Read-only: no project code was changed.

Everything below marked **verified** was run or reproduced during this audit. Setup ran in a fresh
clone (not your working tree), with throwaway `.env` values and a throwaway RSA key. There was no
real GitHub App, so nothing that needs GitHub's side (installing the App, a webhook from GitHub, a
posted comment) was exercised live.

---

## Verdict

**The engineering is well past showcase quality. The packaging is not, and nothing is deployed.**
The code is careful, tested and documented: four suites pass from a fresh clone, unit coverage is
93%, CI gates on lint, types, e2e and an eval stamp, and every non-obvious choice has a written
reason. A reviewer who opens the code will be impressed. But today a visitor can't open it at all
(the repo is private), can't try it (nothing is hosted, and the reviewer needs a GPU), and the
README's first impression is a learning journal that calls the product "nearly useless".

Distance to showcase-ready: about **1.5–3 focused days**. Most of that is deployment, demo data and
a README rewrite. Very little code needs fixing, with one exception: a real timeout bug (I1) that
fails every review over 5 minutes. On your GPU you would rarely hit it, but it breaks any free
hosted demo that runs on a slower model.

**The 3 biggest problems:**

1. **Nothing can be seen live, and the model can't be hosted for free as built.** No Dockerfiles,
   no deploy config, the agent hard-binds to `127.0.0.1`, and the default reviewer needs Ollama on
   an 8 GB GPU. A live demo needs a deliberate cut-down mode (see B1).
2. **The repo is private and unlicensed, and the README reads as coursework.** An anonymous
   `git clone` of the README's URL fails (verified). The README leads with "Quiet, and nearly
   useless", links six `week*.md` guides, and runs to 23 KB before the setup is complete.
3. **The headline number is weak: 2% of known bugs posted.** The eval itself is the most
   impressive thing in the repo. It is honest, reproducible, uses held-out fixtures and a CI gate.
   But the result it reports is the product's main weakness. Weeks 11–12 are planned to attack
   exactly this and haven't started. The showcase has to present the measurement as the
   achievement. It must not hide or round up the number.

---

## Following the README: the setup log

Run in order, in a fresh clone, as the README says.

| # | Step | Result |
|---|---|---|
| 1 | `git clone https://github.com/masabinhok/pr-reviewer.git` | **Fails for anyone but you.** The repo is private, and an anonymous clone gets `could not read Username`. I cloned locally instead. |
| 2 | `npm install` | OK, 556 packages, 34 s. Reports **26 vulnerabilities (2 critical, 15 high)**; see I2. |
| 3 | `(cd apps/agent && uv sync)` | OK |
| 4 | `ollama pull qwen2.5:7b` | OK, a ~4.7 GB download. The README doesn't mention the size. |
| 5 | `npm run agent:model` | OK |
| 6 | `cp .env.example .env` and fill in the table | OK. You can't fill it in without first creating your own GitHub App and a smee channel, so there's no "just try it" path. |
| 7 | `docker compose up -d` | OK, `pr_reviewer_test` created. **Workaround:** I ran it as `-p prr-audit`, because a clone in another folder named `pr-reviewer` would reuse your existing `pr-reviewer_postgres_data` volume. This only affects someone with two checkouts. |
| 8 | `npx prisma generate` / `npx prisma migrate deploy` | OK, all 13 migrations applied. |
| 9 | `npm run start:dev` | OK. `/healthz` returns `{"db":"up","redis":"up"}`. An unsigned webhook gets a 401, the dashboard API without a token gets a 401, and with the token it returns the overview. |
| 10 | `npm run agent` | OK. `/healthz` returns ok, and `/reviews` without the secret gets a 401. |
| 11 | `npm run tunnel` | Not run (no real smee channel or App). |
| 12 | `npm run web` | OK, and pages render their empty states. **Side effect:** `next dev` writes untracked `apps/web/AGENTS.md` and `apps/web/CLAUDE.md` (see I7). |
| 13 | Install the App, open a PR | Not possible without a real App. The flow is covered by the e2e suite (faked GitHub, real queue and DB), which passed. |
| 14 | One real model review: `npm run eval -- --runs 1 --only cookie-maxage-zero` | First attempt **failed** after 41 s with `agent answered 503 … Ollama unavailable`. Ollama restarted while loading the model the first time, and the agent's Ollama client allows only one retry (N5). This machine's NVIDIA driver isn't loaded, so Ollama ran on CPU. Retry **failed after 304 s**: the API stopped waiting at Node fetch's 5-minute limit (I1). |

The test commands in the README all work as written (see Tests).

---

## Blockers (must fix before it can be featured)

### B1. No live demo is possible as built
- **What:** Everything runs on localhost. The reviewer defaults to a local 7B model on a GPU, and
  webhooks arrive through a smee dev tunnel. The repo has no Dockerfile for any of the three
  services and no hosting config. The agent hard-codes its bind address.
- **Where:** `apps/agent/src/pr_agent/__main__.py:14` (`host="127.0.0.1"`); no `Dockerfile` anywhere;
  `apps/api/src/main.ts:3` and `apps/agent/src/pr_agent/config.py:12` read `../../.env` by path.
  That's harmless when real env vars are set, but it ties the services to the monorepo layout.
- **Why it matters:** "live demo" is the first thing on your list, and there's no hosted URL to put
  at the top of the README.
- **Fix:** Make the bind host configurable, add one Dockerfile per service (or a platform buildpack
  config), and choose a free demo mode for the model. Free hosting can't run Ollama; the options
  and their trade-offs go in PLAN.md. The deterministic `REVIEWER=stub` already exists and needs no
  model.

### B2. Private repo, no license, no GitHub metadata
- **What:** `gh repo view` shows `isPrivate: true`, no description, no topics, no homepage, and no
  license. There is no `LICENSE` file. Root `package.json` says `"license": "ISC"` and
  `apps/api/package.json` says `"UNLICENSED"`.
- **Why it matters:** Visitors can't see the source. Without a license the code isn't legally
  reusable, and the conflicting license fields look careless.
- **Fix:** Add a `LICENSE` (MIT is the usual portfolio choice), make the license fields agree, set
  the description, topics and homepage, then make the repo public. The secret scan is clean (below).
  Note that making it public also exposes the commit author emails already in history.

### B3. The README is a learning journal, not a project page
- **What:** It opens with the architecture in prose, and its measured headline is "Quiet, and nearly
  useless". It points readers to `week1-2.md` … `week11-12.md` and `roadmap.md`. "Status" is a
  20-bullet changelog. It has no live demo link, no GIF, no license and no known-limitations
  section. Setup needs a GitHub App before anything works.
- **Where:** `README.md` (23 KB); six `week*.md` plus `roadmap.md` at the repo root (~130 KB of
  build guides); `docs/idempotency.html` and `docs/unit-testing.html` are learning notes.
- **Why it matters:** The README is the portfolio piece. The honesty is an asset, but the framing
  undersells real engineering.
- **Fix:** Rewrite per the Phase 2 brief. Keep the measured numbers with their caveats, and lead
  with what is impressive: webhook correctness, exactly-once posting, line anchoring, and an eval
  with a CI gate. Move the build guides to `docs/journal/`.

### B4. No demo data: the dashboard is empty for anyone but you
- **What:** There's no seed script. On a fresh database every dashboard page shows zeros (verified:
  "0 reviews: 0 finished, 0 failed, 0 too large"). The only way to get data is real GitHub activity
  through your App.
- **Where:** `apps/api/prisma/` has migrations but no seed; the only realistic fake data lives
  inside `apps/web/scripts/smoke.mjs`.
- **Why it matters:** A visitor to a hosted dashboard would see an empty page.
- **Fix:** Add a seed script that loads realistic, clearly labelled demo reviews. The committed
  eval runs in `evals/runs/` are real model output and could feed it. Or point the hosted
  dashboard at a demo database that the stub reviewer fills from a public testbed repo.

---

## Important (fix in the showcase pass)

### I1. Any review longer than 5 minutes fails, whatever `AGENT_TIMEOUT_MS` says
- **What (verified twice):** In a real review on CPU, the API gave up after **304 s** with
  `agent unreachable for jshttp/cookie#1@faf3895: TypeError`, while the agent was still working
  (its log shows turn 4 at 21:14, after the API had stopped waiting). A standalone repro
  (a server that accepts and never answers, fetched with `AbortSignal.timeout(15 min)`) fails after
  **301 s** with `fetch failed; cause: UND_ERR_HEADERS_TIMEOUT`. Node's built-in `fetch` (undici)
  has a 300 s default `headersTimeout`, and the agent sends no headers until the review is done.
- **Where:** `apps/api/src/reviewer/agent-reviewer.ts:63-80`. The `signal` sets 15 minutes, but
  undici's 5-minute limit fires first. The `catch` logs only `e.name` (`TypeError`), so the real
  cause is hidden.
- **Why it matters:**
  - The documented "default 15 minutes" is really 5.
  - Each BullMQ retry starts the whole review again while the agent finishes the abandoned one.
    That doubles the compute, and with Claude it doubles the bill.
  - On a GPU the median review is 26 s, so you've likely never hit it. But any **free hosted demo
    on a slow model or CPU** will hit it on every non-trivial PR.
- **Fix:** Give the request a dispatcher whose `headersTimeout` and `bodyTimeout` equal
  `timeoutMs`: `new Agent({ headersTimeout: t, bodyTimeout: t })` from the `undici` package, which
  is an explicit dependency, because Node's built-in copy isn't importable. Log `e.cause?.code` as
  well. Add a test with a server that answers after a long delay, using fake timers or a small
  timeout. Longer term, a 202-and-poll endpoint would remove the long-held request entirely.

### I2. Known-vulnerable dependencies
- **What (verified, `npm audit`):** 26 advisories (2 critical, 15 high). Direct packages with
  advisories:
  - `next` is pinned **exactly** at `16.3.5`; the fix is 16.4.6. The advisories are an RCE in
    `next/og` and a `use cache` leak.
  - `@nestjs/platform-express` pulls in a vulnerable `multer`.
  - `prisma` (via `deepmerge-ts` and `mysql2`).
  - `zod`, `vitest` and `@nestjs/cli`.

  Python (verified, `pip-audit` on `uv.lock`): `certifi 2026.7.22`, `langgraph-sdk 0.4.4` and
  `urllib3 2.7.0`.
- **Exposure checked:** nothing imports `next/og`, uses `'use cache'`, or accepts file uploads
  (multer). So the two criticals and the multer DoS aren't reachable in this code.
- **Why it matters:** Anyone who clones a public portfolio repo sees "2 critical" on
  `npm install`, and you'd be deploying a Next version with a published critical advisory.
- **Fix:** Bump `next` to 16.4.6, run `npm update` within the existing ranges (every direct fix
  above is in range), and run `uv lock --upgrade-package certifi --upgrade-package urllib3
  --upgrade-package langgraph-sdk`. Re-run all suites. Don't chase the majors (TypeScript 7,
  Vitest 5, Prisma 8).

### I3. Webhook bodies over 100 KB are rejected with 413
- **What (verified):** A correctly signed 150 KB delivery returned
  `413 request entity too large`, and a 1 KB one returned 200. The default Express JSON limit
  (100 KB) applies.
- **Where:** `apps/api/src/main.ts:10-12` (`NestFactory.create(AppModule, { rawBody: true })`, no
  body-parser limit).
- **Why it matters:** GitHub allows payloads up to 25 MB and doesn't retry a failed delivery on its
  own. A PR with a very long description, or an `installation` event listing hundreds of repos, is
  dropped before the signature check and leaves no `WebhookDelivery` row.
- **Fix:** One line: `app.useBodyParser('json', { limit: '25mb' })`. Add an e2e case with a large
  signed payload.

### I4. Not deployable as-is
- **What:** There's no container or platform config for any service. The agent binds `127.0.0.1`
  (B1). The Prisma client is generated into `src/generated`, which isn't committed, so every build
  must run `prisma generate`. Migrations need a `prisma migrate deploy` release step. The API's
  production entry point is `node dist/main`, and nothing documents how to run it.
- **Why it matters:** These are the gaps between "works on my machine" and a URL.
- **Fix:** One Dockerfile (or build/start command pair) per service: `prisma generate` at build,
  `migrate deploy` at release, and the bind host and port from the environment. The details go in
  PLAN.md.

### I5. Formatting isn't enforced, and the code shows it
- **What (verified):** `prettier --check` fails on **107 of 124** API TypeScript files.
  `.prettierrc` exists, but CI runs only `oxlint`, which passes. Styles are mixed:
  `guards/signature.guard.ts` uses double quotes and no semicolons. `webhooks/webhooks.service.ts`
  uses 4-space indents with the `handleWebhook` body mis-indented relative to its signature
  (around line 78). `webhooks.controller.ts` has stray blank lines.
- **Why it matters:** It's the first thing a code reviewer notices, and it undercuts code that is
  otherwise careful.
- **Fix:** Make one isolated `style: format with prettier` commit, add its hash to
  `.git-blame-ignore-revs`, and add `prettier --check` to `.github/workflows/api.yml`. The agent
  already passes `ruff format --check`.

### I6. NestJS scaffold leftovers
- **What:**
  - `GET /` returns `Hello World!` (verified). It comes from `app.controller.ts`,
    `app.service.ts` and `app.controller.spec.ts`.
  - `apps/api/README.md` is the stock NestJS starter README, with sponsorship badges and an ad
    for Mau.
  - `apps/api/package.json` has `"deploy": "nest deploy"` and the `@nestjs/mau` devDependency
    (Nest's paid AWS deploy platform, unused).
  - Root `package.json` has `"test": "echo \"Error: no test specified\" && exit 1"`, an empty
    `description`, and `main: index.js`, a file that doesn't exist.
  - Generator comments remain in `apps/api/prisma/schema.prisma:1-4` ("Get a free hosted
    Postgres database…") and in `apps/api/prisma7.config.ts:1-2`.
- **Why it matters:** These show where the scaffold stops and the real work starts. On a live API,
  `/` returning "Hello World!" looks unfinished.
- **Fix:** Delete the App controller and service and their spec. Either return a one-line JSON
  pointer from `/` or drop the route. Delete `apps/api/README.md` or replace it with three lines.
  Remove `deploy` and `@nestjs/mau`. Make the root `test` script run the workspaces' tests. Remove
  the generator comments.

### I7. `next dev` dirties the working tree
- **What (verified):** After the first `npm run web`, `git status` shows untracked
  `apps/web/AGENTS.md` and `apps/web/CLAUDE.md`, generated by Next 16.3 ("Set `agentRules: false`
  to disable").
- **Fix:** Set `agentRules: false` in `apps/web/next.config.ts`.

### I8. Unused and unpinned dependencies
- **What:**
  - `@nestjs/mapped-types` is declared with version `"*"` and has no imports.
  - `@nestjs/mau` is unused.
  - The root `package.json` depends on `zod`, which nothing at the root uses (the API declares
    its own).
  - `vite-tsconfig-paths` is redundant; Vitest prints a warning saying so on every e2e run.
- **Why it matters:** A `"*"` range means any future major can be installed. The rest is noise
  in `npm audit` and in install size.
- **Fix:** Remove all four, and set `resolve.tsconfigPaths: true` in the Vitest config.

### I9. Undeclared dependency: `dotenv`
- **What:** `apps/api/src/main.ts:1`, eight scripts in `apps/api/src/scripts/` and
  `apps/api/prisma7.config.ts` import `dotenv`, but `apps/api/package.json` doesn't declare it. It
  resolves only because npm hoists it from the root's `dotenv-cli` and `@nestjs/config`.
- **Why it matters:** A Docker build that installs only the API workspace, or a future npm
  hoisting change, breaks the boot.
- **Fix:** Add `dotenv` to the API's dependencies.

### I10. History and repo hygiene
- **What:**
  - 42 commits are named `complete milestone N` or `complete week …`, which isn't conventional
    and doesn't say what changed.
  - 26 merge commits.
  - 112 commits carry a `Co-Authored-By: Claude …` trailer.
  - Six week guides, `roadmap.md` and two HTML learning notes sit at the root and in `docs/`.
- **Why it matters:** Visitors skim history and the root listing.
- **Fix:** Don't rewrite history. It's destructive, breaks the merged-PR links, and it's
  your real record. Keep conventional commits from here on (as your rule already says). Move the
  journal files into `docs/journal/` so the root shows only the project. Whether and how the
  README mentions AI-assisted development is your call; the trailers are visible in history
  either way.

---

## Nice-to-have

- **N1. `X-Powered-By: Express` on the API** (verified). The dashboard already disables it
  (`poweredByHeader: false`). Fix: `app.getHttpAdapter().getInstance().disable('x-powered-by')` in
  `main.ts`.
- **N2. Health checks don't cover the agent.** API `/healthz` checks Postgres and Redis. Agent
  `/healthz` always returns `ok` and doesn't check Ollama or the Anthropic key. For a hosted demo,
  a check that says "agent unreachable" or "model unavailable" makes failures legible.
- **N3. Logs are plain text.** That's fine locally. For a free host's log viewer, JSON lines with
  the delivery and review IDs that are already logged would be easier to search. Not worth a new
  dependency unless the plan needs it.
- **N4. Webhook payloads are cast, not validated** (`webhooks.service.ts`, `as unknown as …` in
  the dispatch table). The HMAC check makes this low risk, and a shape change from GitHub becomes
  a recorded `FAILED` delivery, not a crash. Leave it.
- **N5. A cold Ollama start fails a review.** `model_client` in `apps/agent/src/pr_agent/main.py`
  sets `max_retries=1` for Ollama. During the first model load, one review got a 503. In the App,
  BullMQ retries cover this; in the eval it counts as a failed review. You could raise the retry
  count, or call Ollama's load endpoint at agent startup.
- **N6. The dashboard UI wasn't checked visually.** The browser extension wasn't connected during
  this audit. From the code and the HTML: the layout is responsive (`md:` breakpoints, nav stacks
  on small screens), the nav has `aria-label` and `aria-current`, `<html lang="en">` is set,
  fonts are chosen for legibility, and the smoke test checks every page with the API both up and
  down. Mobile width, contrast and keyboard focus are unverified; check them in Phase 2.
- **N7. Root `package.json`'s `directories.doc` and `main`** are npm-init defaults. Remove them
  with I6.

---

## Security review

| Area | Finding |
|---|---|
| Committed secrets | **None found.** `.env` is gitignored, and no `.env` or `*.pem` was ever added in history. Every `ghs_`/`ghp_`/`sk-ant-` match is a test placeholder; `ghs_16C7e42F…` is GitHub's documentation example. |
| Webhook auth | Good. HMAC-SHA256 over the raw body, constant-time compare, length-checked first so a malformed header gets a 401, not a 500 (`guards/signature.guard.ts`). |
| Dashboard API | Good for a single-user tool: a bearer token compared constant-time over hashes, 503 when unset (never open), read-only, called server-side only, and `server-only` guards the client import. The `limit` and `status` query params are clamped and allow-listed (`dashboard.service.ts:144-145`). **For a public demo, this token can't be shared.** The hosted dashboard needs a read-only demo database, not the token to real data. |
| Agent endpoint | Shared secret, constant-time compare, bound to localhost. The installation token arrives in the request body and the agent keeps it out of logs: httpx logging is raised to WARNING because a codeload redirect URL carries a token. Moving the agent off localhost for hosting means the shared secret becomes the only lock. That's fine over HTTPS, so make sure it's long. |
| Prompt injection | Tools are read-only. Paths resolve inside the snapshot, and symlinks out are refused (`repo/tools.py:197-203`). Tarballs are extracted with the PEP 706 `data` filter, and size and member caps apply (`repo/snapshot.py`). |
| Input size | See I3. |
| Exposed admin routes | None. `GET /` is the only unauthenticated route besides `/healthz` (I6). |

---

## Tests

| Suite | Result (verified, fresh clone) |
|---|---|
| API unit (`npm test`) | **410 passed**, 34 files. Coverage **93.2% statements, 87.2% branches** (`npm run test:cov`). |
| API e2e (`npm run test:e2e`) | **72 passed**, 10 files, about 64 s, against real Postgres and Redis. |
| API lint / types | `oxlint` clean, `tsc --noEmit` clean. `prettier --check` fails (I5). |
| Agent (`uv run pytest`) | **128 passed**. `ruff check` and `ruff format --check` are clean. |
| Web | `tsc` clean, 8 unit tests pass, `next build` OK, and the smoke test renders every page with the API up and down. |
| Eval gate (`npm run eval:check`) | Passes: stamp `6e8b74d28cd76708` matches run `2026-09-19T144109`. |

**What isn't tested automatically:**
- Real GitHub. By design, GitHub is faked with captured responses, and real behaviour is covered by
  the manual `prove:*` scripts.
- Real model quality. That's measured only by the manual eval (about an hour on a GPU).
- The production build and start of the API and agent, because no deploy path exists.
- Large webhook payloads (I3).

None of these is a gap in critical-path logic. The idempotency, exactly-once posting, retry and
line-map paths all have e2e coverage.

---

## Code quality, in short

The structure is clear: Nest modules by concern; the agent split into graph, tools and snapshot;
a cross-language contract in `contracts/` checked from both sides. Errors are classified as
retryable or not and mapped to BullMQ retry or `UnrecoverableError`. Comments explain why rather
than what. The only quality problems are cosmetic and mechanical: I5, I6 and I8. There is no
dead code beyond the scaffold, and no TODO or FIXME markers in source (the `TODO` matches are the
stub reviewer's own feature and the eval's placeholder text).

---

## End-to-end review (one real model review)

Not achieved on this machine, and the reason is a finding. Ollama ran on CPU (this machine's
NVIDIA driver wasn't loaded; that's local, not the project). The agent made about 10–60 s per
model turn. Attempt 1 failed on Ollama's cold start (N5), and attempt 2 hit the 300 s limit (I1).
So model quality was **not** re-measured here. The numbers in `docs/evals/report.md` come from
your GPU runs in September and are taken as reported. The eval gate confirms that the committed
run matches the current reviewer code.
