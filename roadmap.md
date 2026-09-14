# Agentic PR Reviewer — Project Roadmap

Started: August 2026

## The pitch

A GitHub App that reviews pull requests. On a `pull_request` webhook it queues a job,
an agent reads the diff, explores the repo for context, and posts inline review comments
anchored to specific lines.

NestJS API + Postgres + Redis/BullMQ, Python LangGraph agent, Next.js dashboard with
review history and eval scores.

Chosen over a RAG chat project because the hard parts here are real engineering problems
(webhook auth, idempotency, diff line anchoring, comment noise control) rather than
prompt work.

## Stack

| Piece | Tech | Role |
|---|---|---|
| API | NestJS | GitHub App auth, webhook receiver, job enqueue, dashboard API |
| Agent | Python FastAPI + LangGraph | The reviewer itself |
| DB | Postgres + Prisma | Installations, repos, reviews, findings, feedback |
| Queue | Redis + BullMQ | Review jobs (reviews take 30 to 120s, must be async) |
| UI | Next.js | Dashboard |
| Later | Go | Diff parsing / static analysis service (month 3) |

---

## Weeks 1 to 2: GitHub App plumbing

Least glamorous, most valuable. Get it right.

- [x] Register a GitHub App (dev). Permissions: `contents: read`, `pull_requests: write`, `checks: write`
- [x] Nest project + Docker Compose (Postgres, Redis)
- [x] Prisma schema: Installation, Repo, Review, Finding, Feedback
- [x] Webhook endpoint with HMAC-SHA256 signature verification on the **raw body**, not the parsed JSON. This trips everyone up.
- [x] Idempotency: store `X-GitHub-Delivery` ID, drop duplicates. GitHub redelivers.
- [x] App JWT (RS256, 10 min expiry) then exchange for an installation access token, cache in Redis with TTL
- [x] Handle `installation.created` / `installation.deleted`

Use `smee.io` or `gh webhook forward` to get webhooks to localhost.

Learn: Nest modules/guards/interceptors, raw-body middleware, Prisma.

## Weeks 3 to 4: Job pipeline and diff handling

- [x] BullMQ queue: `pull_request.opened` / `synchronize` enqueues `review-pr`
- [x] Worker fetches the PR diff (`Accept: application/vnd.github.v3.diff`) and changed-file list
- [x] Parse the unified diff into hunks. Keep file path + line + side (LEFT/RIGHT) for every changed line. You need this to anchor comments later.
- [x] Filter out lockfiles, generated files, vendored dirs, PRs over N files
- [x] Post a "review in progress" Check Run, complete it when done. Looks professional in the PR UI.
- [x] Store Review and Finding rows

Learn: BullMQ retries/backoff, GitHub REST pagination and rate limits.

## Weeks 5 to 6: The agent

FastAPI service running a LangGraph agent. Nest calls it with the PR context.

Tools:
- [x] `get_file(path, ref)` because a diff alone lacks context
- [x] `search_repo(query)` grep-style, to find callers and definitions
- [x] `get_pr_metadata()` title, description, linked issue
- [x] `list_changed_files()`

Output must be structured JSON, not prose. Force it with a schema:

```json
{
  "file": "src/auth/token.ts",
  "line": 42,
  "side": "RIGHT",
  "severity": "high",
  "category": "correctness",
  "summary": "one sentence statement of the defect",
  "why_it_breaks": "concrete inputs or state, then wrong output or crash",
  "suggested_fix": "optional"
}
```

Rules:
- [x] Findings without a concrete failure scenario get dropped
- [x] Severity gate: only post high and medium (now `POST_MIN_SEVERITY`, high by default, after dogfooding showed the local model's medium findings were noise; see `docs/decisions.md`)
- [x] Post one `POST /pulls/{n}/reviews` with a `comments[]` array. A single review, not 12 separate comments.
- [x] Validate every line against your hunk map first. Comments outside the diff get rejected by GitHub.

Learn: LangGraph state and tool loops, structured output, GitHub review API.

## Weeks 7 to 8: Noise control and dashboard

Noise is what kills these bots. This section is the interview story.

- [ ] Dedupe across pushes: fingerprint findings (file + normalized code + category) so `synchronize` events do not re-post the same comment
- [ ] Resolve stale findings: if the line changed and the issue is gone, mark resolved
- [ ] Thumbs up / down reactions on comments, webhook, store as feedback signal
- [ ] Next.js dashboard: installations, review history, findings, per-review token cost, feedback rate

## Weeks 9 to 10: Evals

The real differentiator.

Build a fixture set: about 20 real PRs (grab open-source ones) with known bugs, plus clean
PRs that should produce zero comments.

Score:
- Recall: did it find the planted bug?
- Precision: how many comments on clean PRs? (false positive rate)
- Run in CI on every prompt change

Then the README says "measured 78% recall at 0.4 false positives per clean PR" instead of
"uses LangChain". That single line beats every other AI project on a junior resume.

## Month 3 and beyond

- [ ] Go service for diff parsing + static analysis (tree-sitter), called by the worker. A genuine reason for Go, not a rewrite for its own sake.
- [ ] `/review` slash command in PR comments to re-trigger
- [ ] Per-repo config file `.prreviewer.yml`: paths to ignore, severity threshold
- [ ] Prompt caching on the repo context to cut cost
- [ ] Langfuse tracing
- [ ] Deploy to Fly or Railway, publish the App

---

## Two things to do early

1. Dogfood it on your own repos from week 6. Screenshots of it commenting on real PRs become your README hero image.
2. Keep a `docs/decisions.md`, one paragraph per design choice (why one review instead of many comments, why fingerprint dedupe). Interviewers ask "why did you do it that way" and you will have written answers.

## Working rules

- Commit small and daily, but keep the README current. Recruiters read the README, not the commits.
- Deploy by week 8. An undeployed project loses most of its value.
