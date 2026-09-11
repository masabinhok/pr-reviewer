# Week 3–4 Build Guide: Job Pipeline and Diff Handling

## Context

Weeks 1–2 built the front door: a GitHub App that verifies webhooks, records each delivery
once, tracks installations, and mints installation tokens. `pull_request` deliveries are
accepted and then nothing happens.

Weeks 3–4 build everything between "a pull request was opened" and "an agent can review
it": a queue so the webhook stays fast, a worker that fetches the diff, a parser that
turns the diff into a map of every commentable line, filtering so the reviewer never
reads a lockfile, a Check Run so the PR shows what is happening, and the `Review` /
`Finding` rows the dashboard will read later.

The reviewer itself is a **stub** in these two weeks — a few deterministic rules behind a
`Reviewer` interface. Weeks 5–6 replace it with the LangGraph agent without touching the
pipeline around it, the same way the queue replaces the `dispatch()` seam from Milestone 5.

**Nothing is posted to the PR as review comments yet.** That is weeks 5–6. The only
visible output on GitHub is the Check Run.

Milestones continue the numbering from weeks 1–2. Each one is a GitHub issue, worked on
its own branch and merged through a PR (see the "Workflow" section below).

---

## Definition of done

Weeks 3–4 are complete when all of these are true:

1. Opening a PR on the testbed enqueues exactly one `review-pr` job, and the webhook
   still answers in well under a second — it enqueues, it does not review.
2. Pushing a commit to the PR (`synchronize`) creates a new review for the new head SHA.
   Redelivering either webhook does **not** create a second job.
3. A `pr-reviewer` Check Run appears on the PR's head commit as in progress, then
   completes with a summary.
4. The worker fetches the diff for the exact SHAs the job was created for, and parses it
   into a map giving every commentable line its file path, line number and side
   (`LEFT` / `RIGHT`).
5. Lockfiles, generated, vendored and binary files are skipped, each with a reason;
   an oversized PR is skipped as a whole with a Check Run that says why.
6. A `Review` moves `PENDING → RUNNING → COMPLETED` (or `FAILED` / `SKIPPED`), and the
   stub reviewer's findings are stored as `Finding` rows, each validated against the
   line map.
7. A job that keeps failing is retried with backoff; after the last attempt the `Review`
   is `FAILED` with the error, and the Check Run is completed — never left spinning.
8. `npm test` and `npm run test:e2e` pass, including the diff parser on real diffs.
9. `docs/decisions.md` has an entry per non-obvious choice; `README.md` is current.

---

## Verified environment facts

Checked on 2026-09-11.

| Thing | Status |
|---|---|
| `bullmq` | 6.3.4 latest (v6.0.0 released 2026-07-30); 5.81.5 on the maintained `release-v5.x` tag |
| `@nestjs/bullmq` | 12.0.0 — peer range includes `bullmq ^6.0.0` and `@nestjs/* ^12` |
| `ioredis` | 6.0.0 already installed (weeks 1–2) |
| Testbed | `masabinhok/pr-reviewer-testbed`, private, installation `160831076` |
| App permissions | Contents read, Pull requests read & write, Checks read & write — enough for everything here |

### Traps — read before starting

**1. BullMQ v6 is two months old, and almost every tutorial is v5.** v6's breaking changes
that matter here: the optional `Connection` constructor parameter is replaced by a
`BackendFactory`; `ioredis` is no longer a direct dependency (fine — it is already
installed); `debounce` is gone in favour of `deduplication`; `Job#discard()` is gone in
favour of throwing `UnrecoverableError`; `Queue#client` and friends are removed. v6 also
adds a PostgreSQL backend — not needed, Redis is already here. **At the start of M9,
smoke-test `@nestjs/bullmq` 12 against `bullmq` 6** (one queue, one job, one worker). If
the Nest integration is shaky on v6, pin `bullmq@5.81.5` and note why in `decisions.md`.

**2. Don't share the app's Redis client with the worker.** BullMQ workers use blocking
Redis commands; in v5 a worker connection must have `maxRetriesPerRequest: null` or
BullMQ refuses it. The existing `RedisService` uses ioredis defaults (20 retries) — give
BullMQ its own connection options instead. Verify the v6 requirement during the M9 smoke
test.

**3. Fetch the diff by SHA, not by PR number.** `GET /pulls/{n}` with the diff media type
returns the diff *as of now*. If the author pushes again between enqueue and fetch, the job
created for commit A reviews commit B's diff, and every line number is off for the Check
Run attached to A. Use `GET /repos/{owner}/{repo}/compare/{base}...{head}` with
`Accept: application/vnd.github.diff`, using the base and head SHAs recorded with the job.

**4. Big PRs fail rather than truncate.** The pull-request files endpoint returns at most
3000 files, and omits `patch` for binary and very large files; the diff media type can be
refused outright for very large diffs. List files first, decide whether to skip, and only
then fetch the diff.

**5. A review comment can target any line inside a hunk, not only changed lines.** Context
lines count. The line map in M11 must include them, or week 5–6 will reject valid
findings. Anything *outside* every hunk is rejected by GitHub with a 422.

**6. Check Runs are App-only.** Only a GitHub App with `checks: write` can create them, and
it must use an installation token — not the App JWT. A Check Run is attached to a commit
SHA, so each new push needs its own.

### Version pins

```
bullmq           6.3.4 (fallback 5.81.5)     @nestjs/bullmq   12.0.0
ioredis          6.0.0 (existing)            diff parser      hand-rolled (see M11)
```

---

## Workflow

Every milestone below is one GitHub issue under the **Weeks 3–4** GitHub milestone.

1. Branch from `main`: `m9-review-queue`, `m10-github-api-client`, …
2. Work commits on the branch (conventional-commit messages)
3. Last commit: `complete milestone N` — only the checkbox update in this file
4. PR titled like the issue, body starting `Closes #<issue>`
5. Merge with **Create a merge commit** — squashing would fold the `complete milestone N`
   commit into the others

---

## Milestone 9 — Review queue (BullMQ)

The webhook must answer GitHub in well under ten seconds; a review takes 30 to 120. So the
webhook's only job becomes: record the review, enqueue it, return 200. This replaces the
`pull_request` placeholder in `WebhooksService`'s dispatch table.

### Which events enqueue

| `pull_request` action | Enqueue? |
|---|---|
| `opened`, `reopened`, `synchronize`, `ready_for_review` | yes |
| any of the above on a **draft** PR | no — recorded, skipped until `ready_for_review` |
| everything else (`closed`, `labeled`, `edited`, …) | no — `IGNORED` |

### Deduplication: the database again

`Review` already has `@@unique([repoId, prNumber, headSha])`. Insert the `Review` row
(`PENDING`) **before** enqueueing, exactly like `WebhookDelivery` in M5 — a `P2002` means
this commit is already being reviewed, so don't enqueue. Then enqueue with a job ID derived
from the review's ID, so BullMQ refuses a duplicate too. The webhook-delivery check (M5)
catches redeliveries; this catches two *different* deliveries about the same commit.

The job payload is just `{ reviewId }`. The worker loads everything else fresh — no stale
PR data sitting in Redis.

### Also in this milestone

- Upsert the `Repo` from the payload (heals repos recorded before M7) and fill
  `defaultBranch` from `repository.default_branch` — the gap left by M7.
- Record `baseSha` and `headSha` on the `Review` (needs a migration: `baseSha` is new) —
  M10 fetches the diff between exactly these two.
- Retries: 3 attempts, exponential backoff. Keep completed/failed jobs for a while for
  debugging, not forever.
- The worker runs **in the API process** for now, as a Nest provider. A separate worker
  process is a deployment change for later; record it in `decisions.md`.
- The worker's processor is a skeleton here: `RUNNING` → log → `COMPLETED`. M10–M14 fill in
  the steps.

**Todo**
- [x] BullMQ + `@nestjs/bullmq` installed; v6 smoke-tested (trap 1) and the choice recorded
- [x] `review-pr` queue with its own Redis connection options (trap 2)
- [x] `pull_request` handler: action table above, drafts skipped
- [x] `Review` inserted first (`PENDING`, `baseSha`, `headSha`); `P2002` → no enqueue
- [x] Job ID derived from the review ID; payload is `{ reviewId }` only
- [x] `Repo` upserted from the payload, `defaultBranch` filled
- [x] Worker skeleton: `PENDING → RUNNING → COMPLETED`, retries with backoff
- [x] Tests: action table, draft skip, duplicate commit → one job, retry on failure

**Polish bar:** open a PR on the testbed → one job, one `Review` that ends `COMPLETED`.
Push a commit → a second `Review` for the new SHA. Redeliver the `opened` delivery → no new
job. Throw inside the worker once → the job is retried and then succeeds.

**Learn:** BullMQ queues, workers, job IDs, attempts and backoff, why the job carries an ID
and not data.

---

## Milestone 10 — GitHub API client

One place that talks to the GitHub REST API with an installation token, so every later
milestone calls `github.listPullRequestFiles(...)` instead of hand-building `fetch` calls.

- `GithubApiService` built on M6's `InstallationTokenService`: base URL, `Accept` and
  `X-GitHub-Api-Version` headers, JSON or diff responses, errors that carry GitHub's
  `message` but never the token.
- **Pagination** through the `Link` header (`rel="next"`), as one generic helper — the same
  shape `capture:fixtures` already uses.
- **Rate limits**: read `x-ratelimit-remaining` / `x-ratelimit-reset`. On a primary limit
  (remaining 0) or a secondary limit (403/429 with `retry-after`), throw a typed
  `GithubRateLimitError` carrying when to retry. The worker turns that into a delayed
  retry rather than spending one of its three attempts.
- **Revoked tokens**: on a 401, invalidate the cached installation token and retry once.
  Closes the last gap from M6.
- Methods needed by the pipeline: `getPullRequest`, `listPullRequestFiles` (paginated,
  3000-file cap from trap 4), `getDiff(base, head)` via compare (trap 3).

**Todo**
- [x] `GithubApiService` with shared headers, JSON + diff responses, redacted errors
- [x] Generic `Link`-header pagination
- [x] `GithubRateLimitError` for primary and secondary limits
- [x] 401 → invalidate token → retry once
- [x] `getPullRequest`, `listPullRequestFiles`, `getDiff(base, head)`
- [x] Unit tests with mocked `fetch`: three-page pagination, both rate-limit kinds, 401 retry
- [x] `npm run prove:diff <owner/repo> <pr>` against the testbed

**Polish bar:** `prove:diff` on a real testbed PR prints the file count, diff size, and
remaining rate limit; the diff it prints matches the PR's "Files changed" tab.

**Learn:** GitHub REST pagination, primary vs secondary rate limits, media types.

---

## Milestone 11 — Diff parser and line map ⭐

**The milestone the rest depends on.** Weeks 5–6 anchor every comment using this map; a
comment anchored to a line GitHub doesn't consider part of the diff is rejected with a 422,
and a comment on the wrong line is worse — it lands, pointing at the wrong code.

### The format

```
diff --git a/src/auth.ts b/src/auth.ts
index 3f2a1b0..9c4d7e2 100644
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -10,7 +10,8 @@ export function verify(token: string) {
   const parts = token.split('.');         ← context: old line 10, new line 10
-  if (parts.length !== 3) return false;   ← deleted: old line 11           (LEFT)
+  if (parts.length !== 3) {               ← added:   new line 11           (RIGHT)
+    return false;                         ← added:   new line 12           (RIGHT)
```

`@@ -10,7 +10,8 @@` means: the hunk covers 7 old lines starting at 10, and 8 new lines
starting at 10. A missing count (`@@ -1 +1 @@`) means 1.

### Cases the parser must handle

New file (`--- /dev/null`), deleted file (`+++ /dev/null`), rename with and without
changes (`rename from` / `rename to`), binary (`Binary files … differ`), mode-only changes,
`\ No newline at end of file`, several hunks in one file, empty files, and paths with
spaces.

### Output

- `DiffFile { path, oldPath, status: added | removed | modified | renamed, binary, hunks }`
- `Hunk { oldStart, oldLines, newStart, newLines, lines }`
- `DiffLine { kind: add | del | context, oldLine?, newLine?, content }`
- `LineMap.canComment(path, line, side)` — `RIGHT` covers added and context lines by their
  new number; `LEFT` covers deleted and context lines by their old number (trap 5).

A **pure function**: string in, structure out, no I/O. It validates each hunk's line counts
against its header and throws on a mismatch, rather than silently producing a wrong map.

Hand-rolled rather than `parse-diff`: the anchoring semantics (which lines are commentable,
on which side) are the whole point, and the parser is small enough to own. Record it in
`decisions.md`.

**Todo**
- [x] Parser for every case above, throwing on malformed hunks
- [x] `LineMap` with `canComment(path, line, side)` including context lines
- [x] Real diffs captured from testbed PRs as fixtures (at least one multi-file, one rename,
      one binary)
- [x] Table-driven unit tests: one case per format feature, plus the real fixtures

**Polish bar:** parse the diff of a real multi-file testbed PR; for five lines picked from
GitHub's "Files changed" view — including a deleted line and a context line — the map gives
the same path, line and side.

**Learn:** the unified diff format, why comment anchoring needs `side`.

---

## Milestone 12 — Filtering

The reviewer should never spend tokens on a lockfile, and a 400-file PR should be refused
politely rather than attempted.

**Per-file rules** — each skipped file gets a reason:

| Reason | Matches |
|---|---|
| `lockfile` | `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `bun.lock(b)`, `Cargo.lock`, `poetry.lock`, `go.sum`, `composer.lock`, `Gemfile.lock` |
| `generated` | `*.min.js`, `*.min.css`, `*.map`, `dist/`, `build/`, `__generated__/`, `*.generated.*`, `*.pb.go` |
| `vendored` | `vendor/`, `node_modules/`, `third_party/` |
| `binary` | marked binary by the parser, or no `patch` from the files endpoint |
| `removed` | the file was deleted — nothing left to review |

**Per-PR rules** — skip the whole review when the PR is over **50 files** or **2000 changed
lines** after per-file filtering (defaults in one config object; per-repo overrides come
with `.prreviewer.yml` in month 3).

A skipped review needs somewhere to say so: add `SKIPPED` to `ReviewStatus` and a nullable
`skipReason` to `Review` (migration). Filtering runs on the file list **before** the diff
is fetched (trap 4).

**Todo**
- [x] Rules as data, in one config object with the defaults above
- [x] `filterFiles()` → `{ kept, skipped: [{ path, reason }] }`, a pure function
- [x] PR-level limits → review `SKIPPED` with `skipReason`
- [x] Migration: `ReviewStatus.SKIPPED`, `Review.skipReason`
- [x] Table-driven unit tests for every rule and both limits

**Polish bar:** a testbed PR touching `package-lock.json` and a source file — only the
source file reaches the reviewer, and the lockfile's skip reason is recorded.

**Learn:** keeping policy as data, so it can later come from a per-repo config file.

---

## Milestone 13 — Check Run

The PR shows what the bot is doing: a spinner while it works, a result when it is done.

- When the worker starts a review: `POST /repos/{owner}/{repo}/check-runs` with name
  `pr-reviewer`, `head_sha`, `status: in_progress`. Store the ID in `Review.checkRunId`
  (the column exists).
- When it finishes: `PATCH` to `completed` with a conclusion and an `output` (title plus a
  Markdown summary: files reviewed, files skipped with reasons, findings by severity).

| Outcome | Conclusion |
|---|---|
| Review completed | `success` |
| Review skipped (too large) | `skipped`, summary says why |
| Job failed on its last attempt | `failure`, summary carries the error |

**The spinner must always stop.** If the job dies on its final attempt, a handler on the
worker's failed event completes the Check Run — otherwise it shows "in progress" on the PR
forever. Only the *final* failure does this; a failure that will be retried leaves the
spinner running.

**Todo**
- [x] Create the Check Run at job start, store `checkRunId`
- [x] Complete it with the conclusion table above and a Markdown summary
- [x] Final-attempt failures complete the Check Run as `failure`
- [x] Unit tests for the summary and conclusion mapping; mocked-API test for the lifecycle

**Polish bar:** open a testbed PR → the spinner appears within seconds → it turns green
with a readable summary. Make the stub reviewer throw → after the retries the check turns
red with the error, not stuck.

**Learn:** the Checks API, and designing for the failure path first.

---

## Milestone 14 — Reviewer seam and persistence

Wire the whole pipeline end to end, with a stand-in where the agent will go.

### The seam

```ts
interface Reviewer {
  review(context: ReviewContext): Promise<ProposedFinding[]>;
}
```

`ReviewContext` carries the PR metadata, the kept files, the parsed diff and the line map.
`ProposedFinding` is the roadmap's agent schema — `file`, `line`, `side`, `severity`,
`category`, `summary`, `whyItBreaks`, `suggestedFix?` — so weeks 5–6 plug the agent in
without changing a type.

`StubReviewer` flags added lines containing `console.log`, `debugger`, or a new `TODO`, as
low- or medium-severity findings with a concrete `whyItBreaks`. It is deliberately dumb:
its job is to exercise every step after it.

### Before storing a finding

- Drop it if `canComment(file, line, side)` is false — log it, it is a reviewer bug
- Drop it if `whyItBreaks` is empty (the roadmap's "no concrete failure scenario" rule)
- Compute `fingerprint` (the column is required): a hash of file path + normalised line
  content + category — weeks 7–8 dedupe across pushes on it

All findings are stored; the high/medium severity gate applies to *posting*, in weeks 5–6.

### The pipeline, in order

load review → mark `RUNNING` → create Check Run → list files → filter → (skip?) → fetch
diff by SHA → parse → reviewer → validate → store findings and mark `COMPLETED` in one
transaction → complete Check Run

**Todo**
- [x] `Reviewer` interface, `ReviewContext`, `ProposedFinding`
- [x] `StubReviewer` with the three rules
- [x] Validation against the line map, `whyItBreaks` rule, fingerprints
- [x] Findings and `COMPLETED` written in one transaction
- [x] The worker runs the full pipeline above
- [x] Unit tests for validation and fingerprints; pipeline test with mocked GitHub

**Polish bar:** a testbed PR that adds a `console.log` → the `Review` ends `COMPLETED` with
one `Finding` whose file, line and side match GitHub's "Files changed" view, and the Check
Run summary lists it.

**Learn:** designing an interface for a component that doesn't exist yet.

---

## Milestone 15 — e2e, docs, README

### e2e

Against `pr_reviewer_test` and a real Redis (a separate queue prefix), with GitHub mocked at
the `fetch` boundary using captured responses:

- Extend `capture:fixtures` with `pull_request.synchronize`, and add captures of a real
  diff and files list from a testbed PR
- signed `pull_request.opened` → one job → worker runs → `Review` `COMPLETED` + `Finding`
  rows, Check Run created and completed
- redelivered `opened` → no second job
- `synchronize` → a new `Review` for the new head SHA
- oversized PR → `SKIPPED`, Check Run `skipped`
- worker failing every attempt → `FAILED`, Check Run `failure`

### Docs

`docs/decisions.md` entries, written as each milestone lands:
- Why the diff is fetched by SHA via compare, not by PR number
- Why the `Review` row is inserted before enqueueing, and the job carries only an ID
- Why the worker runs in the API process for now
- Why a hand-rolled diff parser
- Why a stub reviewer behind an interface
- Check Run conclusions, and why the failure path completes the check
- Filter defaults and where per-repo overrides will come from

`README.md`: status moves to weeks 3–4, the architecture diagram gains the queue and
worker, new scripts documented.

**Todo**
- [ ] e2e cases above green
- [ ] Fixtures for `synchronize`, a real diff, a real files list
- [ ] `decisions.md` entries above
- [ ] README current
- [ ] Optional (carried from M8): GitHub Actions CI running lint + unit + e2e

---

## Suggested pacing

| Days | Milestone |
|---|---|
| 15–16 | 9 (queue) |
| 17 | 10 (API client) |
| 18–20 | **11 (diff parser)** — the core, don't rush it |
| 21 | 12 (filtering) |
| 22 | 13 (Check Run) |
| 23–25 | 14 (pipeline end to end) |
| 26–28 | 15 (e2e, docs, buffer) |

---

## Verification checklist

When weeks 3–4 are done (ask Claude to "verify week 3-4"):

1. Open a PR on the testbed → the webhook answers fast; one job; the Check Run spins, then
   turns green with a summary.
2. Push a commit → a new `Review` for the new SHA, a new Check Run on the new commit.
3. Redeliver both deliveries → no new jobs, no new rows.
4. For five lines on the PR's "Files changed" tab, the line map agrees on path, line, side.
5. A lockfile in the PR → skipped with a reason; a 60-file PR → `SKIPPED`, Check Run
   `skipped`.
6. Stub reviewer forced to throw → retries, then `FAILED` and a red Check Run.
7. `npm test && npm run test:e2e` green; test bodies contain real assertions.
8. Anti-patterns to grep for: diff fetched by PR number instead of SHAs, `Review` created
   after enqueue, job payloads carrying PR data, the worker sharing `RedisService`, a Check
   Run that can be left `in_progress`.
