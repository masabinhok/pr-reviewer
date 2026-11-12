# pr-reviewer: portfolio material

Every number here is from the committed evaluation (`docs/evals/report.md`), the test suites, git,
or a measurement on the live demo on 2026-11-12. Nothing is estimated.

## The card

**pr-reviewer:** a GitHub App that reviews pull requests with an LLM agent, posts only
line-anchored findings it can justify, and measures itself against 29 real bugs.

- An event-driven pipeline: a signed webhook, a Postgres-backed idempotency record, a BullMQ queue
  and worker, a Python LangGraph agent, and one GitHub review posted exactly once.
- An evaluation harness on 29 real pull requests with known answers, plus a CI gate that blocks
  any change to the reviewer that has no evaluation run.
- Deployed for $0 on Render, Neon and Vercel; a review is live on GitHub 10 s after a pull request
  opens.

`NestJS` `BullMQ` `Postgres` `Prisma` `Python` `LangGraph` `Ollama` `Next.js` `Docker`

Links: [repository](https://github.com/masabinhok/pr-reviewer) ·
[live dashboard](https://pr-reviewer-teal.vercel.app) ·
[a reviewed pull request](https://github.com/masabinhok/pr-reviewer-testbed/pull/8) ·
[the local model's comments](https://github.com/masabinhok/pr-reviewer-testbed/pull/6/files)

## The problem

AI review bots are noisy:
- They comment on everything.
- They post the same comment again on every push.
- Their comments land on lines that aren't in the diff.
- Nobody measures whether they're right.

pr-reviewer is built around the opposite constraints. It posts only what it can tie to a line and a
concrete failure, and it posts that once. It counts what it posts against bugs whose answers are
known.

## Design choices

- **The diff decides where a comment can go.** The unified diff is parsed into a map of every
  commentable line. A finding outside that map is dropped before GitHub sees it.
- **A second look in a fresh conversation.** Each finding is re-checked on its own against the code
  around it. Refuted findings are dropped, and unconfirmed ones are demoted.
- **Exactly once, under retries.** The webhook delivery, the Review row and the posted GitHub review
  each record that they happened, so a retry that fails part-way resumes rather than re-posting.
  Comments near code that an earlier review already commented on are stored as repeats and are not
  posted again.
- **Local-first and free by default.** The agent speaks the Anthropic Messages API, which Ollama
  also serves. One client drives a free local 7B model, or Claude with your own key.
- **Measure before claiming.** Any change to the prompts, the tools, the second look or the posting
  bar needs a committed three-run evaluation, or CI fails.

## Results, measured

On 29 pull requests: 19 real bug fixes from 8 open-source projects, reversed so that the change
reintroduces the bug; 1 planted-bug pull request; and 9 clean changes. Each was reviewed 3 times,
for 87 reviews, by `qwen2.5:7b` on an 8 GB GPU.

| | recall | false positives per clean PR |
|---|---|---|
| Posted (comments a person sees) | 2% (0–7%) | 0.04 (0–0.11) |
| Kept (listed in the Check Run) | 21% (15–30%) | 0.41 (0.22–0.56) |

- **The honest headline is that it's quiet and nearly useless on a 7B model.** It rarely posts a
  wrong comment, and it rarely posts a right one.
- **Two changes were tried and reverted on held-out data, by rules written in advance:**
  - Posting medium findings: false positives tripled, with the recall gain inside the spread.
  - Turning the second look off: kept recall rose to 81% (57–100%), but posted recall stayed at 0%.
- **Every location match was read by hand.** 3 of 20 matched the right line but described the wrong
  problem, and were scored as misses.
- **Speed and cost:** 26 s per review at the median, 61 s at the 90th percentile, $0.

## Engineering, measured

- **Tests:** 413 unit tests (93.1% statements, 87.2% branches), 76 end-to-end tests against real
  Postgres and Redis with GitHub faked at the `fetch` boundary, 128 agent tests against a scripted
  model, and the dashboard's tests and smoke test. A shared contract in `contracts/` is checked from
  both the TypeScript and the Python side.
- **Size:** about 9,700 non-blank lines of TypeScript and Python application code, and about 9,500
  of tests. Generated code is excluded. 13 database migrations.
- **History:** 202 commits from 2026-08-28 to 2026-09-23, built milestone by milestone with a
  journal (`docs/journal/`), then a production-readiness pass to audit, fix and deploy it
  (`docs/journal/AUDIT.md`, `docs/journal/PLAN.md`).
- **How it was built:** with AI pair-programming.

## Found while hardening it for production

A production-style audit of the finished project (`docs/journal/AUDIT.md`) found these. Each fix
has a test that fails without it:

- **A 5-minute ceiling on reviews.** Node's `fetch` drops a request with no response headers after
  300 s, whatever its `AbortSignal` allows. A real review failed at 304 s as "agent unreachable",
  and the error didn't say why. The request now carries its own undici dispatcher.
- **Large webhooks rejected.** Express's 100 kB JSON limit answered a large pull request's delivery
  with a 413, which GitHub never retries. The limit is now GitHub's 25 MB, with raw-body signing
  intact.
- **A mislabelled review.** At the demo's low posting bar, the review said "1 issue (1 medium)"
  over a low comment. This was caught in the screenshots for the README.
- **Tests aimed at the wrong database.** After migrations moved to a direct database URL, the e2e
  setup would have migrated whatever that URL named. That includes a hosted database, if a
  developer's `.env` points at one.
- **Dependencies:** 26 npm advisories (2 critical) and 3 Python ones were reduced to 0. npm's
  resolver crashed until the two workspaces agreed on one vitest major.

## Deployed for free

| Piece | Where | The catch, and how it's handled |
|---|---|---|
| API and worker | Render free web service (Docker) | It sleeps after 15 min and wakes in about a minute, but GitHub waits only 10 s and never retries. A ping every 10 min keeps it awake. |
| Queue | Render Key Value (free) | It's in memory, so a restart can lose queued jobs; the next push redoes them. `noeviction`, as BullMQ requires. |
| Postgres | Neon (free) | It scales to zero. The health check and keep-alive hit a route that never touches the database, so it can. |
| Dashboard | Vercel Hobby | It reads the API from its own server; the token never reaches the browser. |
| The model | Not hosted | No free host runs it. The live App uses the deterministic stub reviewer; the model's real output is on the testbed and in the seeded history. |

Migrations run when the container starts, because Render's pre-deploy step is paid-only. Real review
history was carried into the demo by `demo:export` (public repositories only, nothing re-dated) and
`demo:seed` (idempotent).

## What's next

Planned in `docs/journal/week11-12.md`, not built yet:
- confidence-based posting, aimed at the posted-recall problem above
- a `/review` command
- per-repository configuration
