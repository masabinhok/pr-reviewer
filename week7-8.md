# Week 7–8 Build Guide: Noise Control and Dashboard

## Context

Weeks 5–6 put an agent behind the reviewer and posted its findings. Dogfooding then showed
what the roadmap warned about: **noise is what kills these bots.** On five reviews of real
pull requests in this repository, the free local model produced twelve findings and not one
real defect, and on #33 it posted three high-severity comments that the diff itself
disproved. The posting bar (`POST_MIN_SEVERITY=high`) halved the noise; it did not remove it.

Weeks 7–8 attack noise from four sides, then make it visible:

1. **Check before posting** — a second, skeptical pass that tries to disprove each finding
   against the code, and drops what it disproves. (Added to the roadmap's list, because of #33.)
2. **Don't repeat yourself** — a push to a PR must not re-post a comment already on it.
3. **Clean up after yourself** — when the code a comment was about is fixed, resolve it.
4. **Listen** — 👍 / 👎 on the App's comments, collected and stored as feedback.
5. **Show it** — a Next.js dashboard: installations, reviews, findings, tokens, feedback rate.

Everything still runs for free, on the local model, on this machine.

---

## Definition of done

Weeks 7–8 are complete when all of these are true:

1. Every finding passes a **verification pass** before it is stored as postable. On the
   recorded dogfooding findings the pass drops most of the known-wrong ones and keeps the
   known-right ones — measured, with the numbers in `docs/decisions.md`.
2. A second push to a PR **never re-posts** a comment for a finding already commented on.
3. When a push changes the code a posted finding was about and the new review doesn't find
   it again, the finding is **resolved** — in the database and as a resolved thread on GitHub.
   A thread a person resolves by hand is recorded as resolved too.
4. 👍 and 👎 reactions on the App's comments are **collected and stored** as `Feedback`, and
   removed reactions are removed; polling costs no rate limit when nothing changed.
5. A **dashboard** (`apps/web`, Next.js) shows installations, repositories, review history,
   findings with their verification and feedback, tokens and time per review, and the
   feedback rate — reading a token-protected, read-only API on Nest.
6. `npm test`, `npm run test:e2e` (api), `uv run pytest` (agent) and the dashboard's tests
   pass, with no network, Ollama or API key.
7. `docs/decisions.md` has an entry per non-obvious choice; `README.md` covers the dashboard,
   with a screenshot.

---

## Verified environment facts

Checked on 2026-09-14.

| Thing | Status |
|---|---|
| Reaction webhooks | **None.** GitHub's webhook list has no reaction event (checked against the docs) — reactions must be polled |
| Reading reactions | `GET /repos/{o}/{r}/pulls/comments/{id}/reactions` works with the App's installation token (200) and returns an `ETag` |
| Conditional requests | Repeating it with `If-None-Match` answers **304** and does not consume rate limit (4998 → 4998) |
| Resolving threads | **GraphQL only**: `resolveReviewThread(input: {threadId, resolutionReason?})` and `unresolveReviewThread`. The installation token reads `reviewThreads { id isResolved isOutdated comments { databaseId } }` — thread IDs map to our stored comment IDs. Not yet verified: that the installation token may *call* the mutation (M25 checks it first) |
| App events | Subscribed: `pull_request`, `pull_request_review`, `pull_request_review_comment`. **Not** subscribed: `pull_request_review_thread` (needed in M25) |
| App permissions | `checks: write`, `contents: read`, `metadata: read`, `pull_requests: write` |
| BullMQ | 6.3.4, with `queue.upsertJobScheduler` for repeating jobs |
| Schema already in place | `FindingStatus { OPEN, RESOLVED }`, `Feedback { findingId, signal UP/DOWN, githubUserId }` unique per finding and user, `Finding.fingerprint` indexed |
| Next.js / React / Tailwind | 16.3.5 (Node ≥ 20.9) / 19.3.0 / 4.3.3 — Node here is 22.23.1 |
| Data so far | 18 reviews, 30 findings, 0 feedback rows |

### Traps — read before starting

**1. There is no webhook for reactions.** It is the most natural thing to expect and it
does not exist. Feedback is polled: a repeating BullMQ job asks for each posted comment's
reactions with the `ETag` it saw last. A 304 is free; only a change costs a request.

**2. Resolving a review thread is GraphQL-only.** REST can create comments but cannot
resolve them. The thread ID (`PRRT_…`) is not the comment ID; look it up through
`reviewThreads { id comments(first: 1) { nodes { databaseId } } }` and match `databaseId`
to `Finding.githubCommentId`.

**3. A finding the model didn't repeat is not a fixed bug.** The local model's output varies
run to run: the same diff yielded 1, 2 and 5 findings. Resolving whatever the new review
didn't mention would resolve real problems by accident. Resolve only when the **code** the
finding anchored to has changed (GitHub's `isOutdated`, or the anchored line's text is gone)
*and* the new review didn't find it again.

**4. The category varies between runs too.** The fingerprint is file + normalised code +
category, and the local model filed one defect as both `correctness` and `security`. Dedupe
across pushes has to decide what "the same finding" means without trusting the category.

**5. The verifier is the same small model.** A second pass by a 7B model can be as wrong as
the first — it may refute real bugs and confirm noise. Measure it on findings whose truth is
known before trusting it, and keep the pass skeptical by construction: a fresh conversation
that sees the code, not the first pass's reasoning.

**6. `BigInt` doesn't serialise.** GitHub IDs are `BigInt` in Prisma, and `JSON.stringify`
throws on them. The dashboard API must turn them into strings, deliberately, in one place.

**7. The App must subscribe to `pull_request_review_thread`.** That is a checkbox in the
App's settings (Permissions & events → Subscribe to events), and only you can tick it. M25
needs it to learn when a person resolves a thread by hand.

**8. The machine forgets.** After a reboot Postgres and Redis are down, and a script hangs
on its first query instead of failing. `docker compose up -d` first, every session.

### Version pins

```
next 16.3.5    react 19.3.0    react-dom 19.3.0    tailwindcss 4.3.3    bullmq 6.3.4 (existing)
```

---

## Workflow

Same as weeks 5–6: every milestone is a GitHub issue under the **Weeks 7–8** GitHub
milestone, worked on its own branch, finished with a `complete milestone N` commit that
ticks the boxes in this file, and merged through a PR with **Create a merge commit**.
Measurements are made with `npm run try:review` and `scripts/replay.py`, not by pushing
commits to other people's pull requests.

---

## Milestone 23 — Verification pass ⭐

**The milestone the noise story rests on.** After the agent submits, every finding gets a
second look designed to disprove it.

- A `verify` node in the LangGraph graph, after `submit_review`: for each finding, a **fresh**
  model call (not the reviewer's conversation) given the finding, the diff hunk it anchors to,
  and the file's code around the line from the snapshot. It answers through a `verdict` tool:
  `confirmed`, `refuted` or `unsure`, with a one-sentence reason quoting the code.
- The prompt is skeptical by design: find the line of code that shows the finding is wrong;
  only if there is none, confirm it. PR content is still data, never instructions.
- `refuted` → dropped. `unsure` → kept but demoted to `low`, so it is stored and shown in the
  Check Run but never posted under the default bar. `confirmed` → unchanged.
- The response carries what was dropped and why (contract change: both fixtures, both suites),
  and the Check Run says "N findings dropped on a second look".
- Budget: a cap on findings verified per review; each verdict call is small. Verification
  failing (budget, model error) keeps the finding unverified and demoted, never silently
  confirmed.
- **An evaluation set** of findings whose truth is known: the recorded wrong ones from
  dogfooding (the twelve in `docs/decisions.md`, the three posted on #33) and the right ones
  from the planted-bugs PR (the SQL injection at `users.ts:18`, the `===` comparison at
  `auth.ts:23`). A script runs only the verify node over them, several times.

**Todo**
- [x] `verify` node, `verdict` tool, fresh conversation per finding, budget
- [x] Refuted dropped, unsure demoted; contract updated on both sides
- [x] Check Run lists what was dropped on a second look
- [x] The evaluation set, and a script that measures the pass on it
- [x] Tests with the fake model: each verdict, budget, failure keeps and demotes

**Polish bar:** on the evaluation set, run five times: most known-wrong findings refuted or
demoted, the two known-right ones confirmed in most runs — and the numbers written down,
whatever they are.

**Learn:** self-verification and LLM-as-judge; why a judge needs ground truth before it is
trusted.

---

## Milestone 24 — Dedupe across pushes

A `synchronize` event reviews the new head commit from scratch, and without this every push
re-posts every comment.

- Before posting, compare each new finding with the **open, already-posted** findings of
  earlier reviews on the same PR. A match is not posted again; it is stored, linked to the
  finding it repeats (migration: `Finding.repeatOfId`), and counted in the Check Run
  ("3 already commented on").
- What is a match (trap 4): same file and the same normalised code on the anchored line,
  whatever the category. Decide whether the line number matters (it shouldn't — code moves)
  and write it down. (Decided: a window of real code within two lines of the finding, after a
  live check showed the model's chosen line wobbles — see docs/decisions.md.)
- A renamed file breaks the match; accept that and say so.
- A resolved finding (M25) that appears again is **not** a match — it came back, and is posted.

**Todo**
- [x] `Finding.repeatOfId` migration; the match rule, documented
- [x] Publisher skips repeats; Check Run counts them
- [x] Tests: repeat skipped, moved line still a repeat, changed code not a repeat, resolved-then-back posted

**Polish bar:** push an empty commit to a testbed PR that already has comments: a new review
runs, the Check Run completes, and no comment is posted twice.

**Learn:** idempotency one level up — not "the same job twice" but "the same problem again".

---

## Milestone 25 — Resolve stale findings

- **First, verify** the installation token can call `resolveReviewThread` (trap 2), on a
  testbed thread, and unresolve it again.
- On each new review of a PR: an open, posted finding from an earlier review is resolved
  when the code it anchored to has changed — GitHub's `isOutdated` on its thread, or its
  anchored line's text is no longer in the new diff at that file — **and** the new review
  didn't find it again (trap 3). Resolved means `status = RESOLVED`, `resolvedAt`, `resolvedBy
  = APP`, and the GitHub thread resolved through GraphQL.
- A person resolving the thread on GitHub (`pull_request_review_thread.resolved`) marks the
  finding `RESOLVED` with `resolvedBy = PERSON`; `unresolved` reopens it. Needs trap 7's
  checkbox.
- Resolving is best-effort and idempotent: a thread already resolved is fine; a GraphQL
  failure is logged and retried with the job, never fails the review.

**Todo**
- [ ] The mutation verified with the installation token
- [ ] `resolvedAt`, `resolvedBy` migration; the stale rule, documented
- [ ] Resolve in the database and on GitHub; idempotent
- [ ] `pull_request_review_thread` webhook: resolved / unresolved by a person
- [ ] Tests: code changed and not re-found → resolved; not re-found but unchanged → open; re-found → open; person resolves

**Polish bar:** on the testbed, fix the line a comment points at and push: that thread shows
as resolved by the App; resolve another by hand and the database agrees.

**Learn:** GitHub's GraphQL API next to REST, and why "the model stopped saying it" is not a
signal.

---

## Milestone 26 — Feedback: reactions

- A repeating BullMQ job (`upsertJobScheduler`, every few minutes) polls reactions for posted
  findings on pull requests that are open or closed within the last 14 days.
- Each request sends the `ETag` stored for that comment (migration: `Finding.reactionsEtag`);
  304 → nothing to do (trap 1).
- `+1` → `UP`, `-1` → `DOWN`, per GitHub user; other reactions are ignored; the App's own
  reactions are ignored. A reaction that disappears deletes its `Feedback` row. The unique
  `(findingId, githubUserId)` makes it idempotent; a user who switches 👍 to 👎 updates the row.
- A deleted comment (404) stops being polled.
- Feedback rate, defined once and reused by the dashboard: of posted findings, the share with
  any 👍/👎, and the share of those that are 👎.

**Todo**
- [ ] Repeating poll job; ETag per comment; 304 short-circuit
- [ ] Reactions → `Feedback` upserts and deletes; the App's own reactions ignored
- [ ] Stop polling deleted comments and old closed PRs
- [ ] Feedback-rate query, tested
- [ ] Tests: 304, new 👎, 👍→👎, reaction removed, comment deleted

**Polish bar:** 👎 a comment on #33; within one polling interval there is a `DOWN` row for
it, and removing the reaction removes the row.

**Learn:** polling done politely — conditional requests, rate limits, and repeating jobs.

---

## Milestone 27 — Dashboard API

- Read-only JSON endpoints on Nest under `/api/dashboard`: overview stats, installations and
  their repositories, reviews (paginated, filter by repo and status), one review with its
  findings, verification verdicts and feedback, and the feedback rate over time.
- **Auth:** a bearer `DASHBOARD_TOKEN`, compared in constant time; the endpoints refuse to run
  without it configured. This is a single-user, local tool; GitHub login is out of scope and
  the decision says why.
- `BigInt` → string in one serialiser (trap 6); dates as ISO strings.
- Nothing here writes.

**Todo**
- [ ] Endpoints and their response types
- [ ] Token guard; refuses without a configured token
- [ ] BigInt and date serialisation in one place
- [ ] Tests: auth, pagination, a review's detail, stats on a seeded database

**Polish bar:** `curl` with the token returns the overview; without it, 401; a review's
detail shows its findings with verdicts and feedback.

**Learn:** designing a read API for a UI; auth for a local tool.

---

## Milestone 28 — Dashboard UI

- `apps/web`: Next.js 16 (App Router), React 19, Tailwind 4. It fetches the Nest API **on the
  server**; the token never reaches the browser.
- Pages: **Overview** (reviews per day, findings by severity, posted vs dropped on a second
  look, tokens and time per review, feedback rate); **Installations & repositories**;
  **Reviews** (list, filters); **Review** (findings, where they were posted, verdicts,
  feedback, links to the PR and the Check Run).
- Honest empty states: no feedback yet is a state, not a zero.
- Works at phone width; readable in light and dark.

**Todo**
- [ ] `apps/web` scaffolded in the workspace; `npm run web`
- [ ] Server-side fetching with the token; no token in the client bundle (checked)
- [ ] The four pages
- [ ] Tests for the data-shaping code; a smoke test that pages render against a fake API

**Polish bar:** the dashboard running against the real database shows this repository's
reviews, including #33's dropped and posted findings, and a screenshot of it goes in the
README.

**Learn:** Next.js server components fetching from your own API, and keeping secrets on the
server.

---

## Milestone 29 — e2e, docs, README

- e2e (api): two pushes to one PR — the second posts no repeats; a fixed line — the finding is
  resolved and the fake GitHub records the GraphQL mutation; reaction polling with a 304 and a
  change; the dashboard API behind its token.
- The agent's suite covers verification against the fake model; the contract fixtures carry
  the new response fields.
- `docs/decisions.md` entries: verification and its measurement; what counts as a repeat; the
  stale rule; polling reactions; the dashboard's auth. `README.md`: the dashboard, the new
  settings, the screenshot.

**Todo**
- [ ] e2e for repeats, resolving, feedback polling, dashboard auth
- [ ] `decisions.md` entries above
- [ ] README current, with the dashboard screenshot

---

## Suggested pacing

| Days | Milestone |
|---|---|
| 43–46 | **23 (verification)** — the core, don't rush it |
| 47–48 | 24 (dedupe across pushes) |
| 49–50 | 25 (resolve stale findings) |
| 51–52 | 26 (feedback) |
| 53 | 27 (dashboard API) |
| 54–55 | 28 (dashboard UI) |
| 56 | 29 (e2e, docs) |

---

## Verification checklist

When weeks 7–8 are done (ask Claude to "verify week 7-8"):

1. The verification evaluation set, run five times: the numbers match `docs/decisions.md`.
2. Push an empty commit to a testbed PR with comments → a new review, no comment posted twice.
3. Fix a commented line and push → the thread is resolved by the App; resolve one by hand →
   the finding is `RESOLVED` with `resolvedBy = PERSON`.
4. 👎 a comment → a `DOWN` feedback row within one polling interval; remove it → the row goes.
5. The dashboard shows the testbed's and this repository's reviews; `curl` without the token → 401.
6. `npm test`, `npm run test:e2e`, `uv run pytest` and the dashboard's tests green, offline.
7. Anti-patterns to grep for: resolving a finding only because it wasn't re-found, a
   reaction webhook handler (there is no such event), `JSON.stringify` of a Prisma row with a
   `BigInt`, the dashboard token in client code, posting a finding that skipped verification.
