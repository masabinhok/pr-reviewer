# Design decisions

One paragraph per non-obvious choice, written as the choice is made — not retro-fitted
once the feature is finished. See `week1-2.md` for the milestone each of these came from.

## Own `id` (cuid) instead of GitHub's numeric ID as primary key

Every model that mirrors a GitHub entity (`Installation`, `Repo`) has its own `cuid()`
primary key plus a separate `githubId` column. Using GitHub's ID directly as the primary
key would tie every internal relation (`Review.repoId`, `Finding.reviewId`, ...) to an
identifier scheme owned by an external API. Owning the `id` means GitHub's ID is just an
attribute you look up by, not the backbone of the data model — and `cuid()` is generated
client-side before the insert happens, so a full object graph can be built and referenced
before anything hits the database.

## `BigInt` for GitHub IDs, not `Int`

Postgres `Int` tops out around 2.1 billion. GitHub's installation, repo, comment, and user
IDs already exceed that for many accounts. Using `Int` works fine in testing against small
IDs and then silently breaks in production the first time it hits a large one — so every
GitHub-sourced numeric ID (`Installation.githubId`, `Repo.githubId`,
`Finding.githubCommentId`, `Feedback.githubUserId`, `Review.checkRunId`) is `BigInt`.

## Soft delete on `Installation` and `Repo`, not hard delete

Uninstalling the App sets `deletedAt` instead of running `DELETE`. The review history is
the product — a hard delete would cascade and destroy every `Review` and `Finding` ever
generated for that repo, with no way to recover it. A nullable `deletedAt` just hides the
row from active queries; the data survives a reinstall (Milestone 7 upserts and clears
`deletedAt` rather than re-creating from scratch).

## Enums instead of raw strings for state fields

`ReviewStatus`, `Severity`, `FindingSide`, `FindingStatus`, `FeedbackSignal` are Postgres
enums. A plain `String` lets application code insert a typo (`"compelted"`) or wrong case
(`"Medium"`) that inserts fine and then silently fails every query filtering on the exact
value. An enum makes that a compile-time error and a DB-level constraint, and documents
the finite state space in one place. `FindingSide` specifically uses `LEFT`/`RIGHT`
because that's GitHub's own vocabulary for diff comment anchoring — matching it avoids a
translation layer when posting comments later.

`FindingStatus` (`OPEN`/`RESOLVED`) is a separate enum from `ReviewStatus` on purpose. A
review finishing successfully is a different fact from an individual finding still being
valid — a finding can go `RESOLVED` on a later, different review when a `synchronize`
push shows the flagged line no longer exists (week 7–8's stale-finding resolution). They
need independent lifecycles, so they're independent enums.

## Nullable fields instead of placeholder values

`Review.completedAt`, `error`, `checkRunId`, `promptTokens`, `costCents`, and
`Finding.suggestedFix`, `githubCommentId` are all nullable rather than required, because
they don't exist yet when the row is first created — a review starts before it completes,
might fail before accumulating cost, and a finding might have no obvious fix or never get
posted as a comment (the severity gate only posts high/medium). `null` means "genuinely
doesn't exist yet"; a placeholder value (`error: ""`, `checkRunId: 0`) is a lie something
downstream eventually trips over.

## `@@unique([repoId, prNumber, headSha])` on Review, not just `prNumber`

A `synchronize` webhook fires on every push to a PR, and each push should get its own
`Review` row — not overwrite the previous one — so its findings can be traced to the exact
commit they were computed against. `headSha` in the composite key is what makes that
possible; without it, a second push would either collide with the first review or leave no
way to tell which commit a given review's findings apply to.

## Insert-first idempotency on `WebhookDelivery`, not check-then-insert

`deliveryId` (GitHub's `X-GitHub-Delivery` header) is `@unique`. The design is to
`create()` the row immediately on receipt and let a unique-constraint violation (`P2002`)
signal a duplicate, rather than checking "does this ID exist?" and inserting only if not.
Check-then-insert has a race window: two concurrent redeliveries can both see "not found"
and both proceed. Letting the database arbitrate via the unique constraint removes the
race entirely — the constraint is the lock. `status` defaults to `"RECEIVED"` and
`processedAt` stays nullable so the row can be written before the payload has been
validated or handled at all — recording receipt has to be safe to do first.

(This entry covers the schema-level design decided in Milestone 3. The handler that acts
on it, and the status vocabulary it writes, are the four entries below.)

## `DeliveryStatus` is an enum, and there is deliberately no `DUPLICATE` value

`WebhookDelivery.status` started as a plain `String` defaulting to `"RECEIVED"`, which
contradicted the enum reasoning three entries up for no reason other than that it was
written first. It is now `DeliveryStatus`, with four values: `RECEIVED` (row written,
outcome not yet known — the default), `PROCESSED` (a handler ran and returned cleanly),
`IGNORED` (a verified delivery for an event nothing handles), and `FAILED` (the handler
threw; `error` holds the message).

`DUPLICATE` looks like it belongs and does not. A duplicate delivery's insert *fails*, so
no second row is ever created — the only row is the original, holding whatever status its
own run reached. A `DUPLICATE` value could therefore never be written by any honest code
path, and the only way to write it would be to overwrite the original row, destroying the
record of what actually happened. Duplicates are an event in the logs, not a state of a
row.

`IGNORED` is separate from `PROCESSED` for a similar reason: "we looked at this and chose
not to act" and "we acted successfully" are different facts, and collapsing them would
make it impossible to answer later how many deliveries the app is actually doing work for.

The value is `PROCESSED` rather than `COMPLETED` (which is what `ReviewStatus` uses for
the same idea) because it sits next to the `processedAt` column. A column and a status
disagreeing on the word for the same moment is a small, permanent friction; the
cross-enum inconsistency is visible in one file and costs nothing.

## Every delivery gets a row, including events nothing handles

The unhandled-event check runs *after* the insert, not before. Recording only the events
in `HANDLED_EVENTS` would be cheaper and is the obvious first instinct, but it makes the
idempotency guarantee conditional on the dispatch table: widen `HANDLED_EVENTS` later and
every event newly added to it has no history, so a redelivery from before the change
looks new. Inserting first makes redelivery-safety a property of the endpoint rather than
of whichever events it currently knows about, and it is what gives `IGNORED` something to
mean. The cost is table growth from events the app does not care about, which is a
retention problem to solve when it appears, not a reason to lose the audit trail now.

## The dispatch is awaited, even though the milestone says "ACK first"

GitHub times out around ten seconds, so the guidance is to acknowledge before doing the
work. Right now the "work" is a single log line, and awaiting it is both harmless and
safer than a floating promise whose rejection nothing observes. The dispatch lives behind
a private `dispatch()` seam so that when weeks 3–4 replace its body with a BullMQ enqueue,
nothing around it moves. The enqueue is itself fast, so awaiting will most likely still be
correct then — the decision to revisit is not "await or not" but "what happens if the
enqueue itself fails", which needs a real queue to answer.

## The idempotency guarantee is tested against real Postgres, not a mocked Prisma

Both exist. The unit tests in `webhooks.service.spec.ts` fake `create` rejecting with a
`P2002` error and assert the service's reaction; the integration tests in
`test/webhooks.idempotency.e2e-spec.ts` run the same paths against the database in Docker.
The unit tests are the fast feedback loop, but they cannot prove the thing this design
rests on, because a fake returns whatever it was told to — they assert a belief about
Postgres that was written by the same person writing the test. The integration test fires
two concurrent `handleWebhook` calls with the same delivery ID through `Promise.all` and
asserts exactly one row and exactly one duplicate, which is the actual claim: the
constraint is the lock. A design whose whole argument is "trust the database" needs at
least one test that involves the database.

## GitHub App auth is hand-rolled, not `@octokit/auth-app`

Milestone 6 signs the App JWT with `node:crypto` and exchanges it for installation tokens
with a bare `fetch`, because the point was to learn the two-step flow rather than import
it. In production the right call is `@octokit/auth-app`. It does the same JWT → token
exchange, but it also covers the edges this code does not: it corrects for clock drift
when GitHub rejects a JWT's timestamps, rather than failing until someone fixes the
server's clock; it can scope a token down to specific repositories and permissions; and
it plugs into Octokit's request pipeline so every API call picks up a valid token without
the caller asking. It also accepts a pluggable cache, so the Redis caching here would
survive a migration as an adapter rather than being thrown away. The hand-rolled version
is small enough to read in one sitting, which is exactly why it is a good teacher and
exactly why it should not be trusted with the long tail.

## Two token types, and only the installation token is cached

The App JWT proves "I am this App" and can only call `/app/...` endpoints; the installation
token acts on one installation's repositories with that installation's permissions. The
JWT is signed locally in microseconds, so caching it would save nothing and add a second
expiry to get wrong — `AppJwtService.mint()` returns a fresh one every call. The
installation token costs a network round trip, so it is cached in Redis under
`gh:itoken:{installationId}` for `(expires_at − now) − 60s`. Expiring the cache a minute
early is deliberate: a token served with seconds left can die mid-request, and that shows
up as a 401 roughly once an hour — the most expensive kind of flake to track down. Redis
rather than an in-process `Map` for the same reason as the delivery table: it is shared
across instances and survives a restart.

Known gap: a token revoked *before* its expiry — the installation suspended or deleted —
stays cached until its TTL runs out, and nothing evicts it on a 401 yet. Milestone 7's
suspend and delete handlers are the natural place to delete the key.

## Concurrent cache misses both mint, on purpose

Two requests that miss the cache at the same moment each exchange a JWT for their own
token, and the second `SET` overwrites the first. This looks like the check-then-insert
race from Milestone 5 and is not the same problem: there, the race produced a duplicate
review; here, it produces two independently valid tokens, both usable for their full hour.
The cost is one extra round trip to GitHub, rarely. A lock (or de-duplicating in-flight
requests per installation) would remove it, and would add a failure mode — a holder that
dies with the lock held — to prevent something harmless. Not worth it until the metrics
say otherwise.

## Webhook dispatch is a table keyed on `event.action`

`WebhooksService` routes through a `Record<string, Handler>` whose keys are either
`event.action` (`installation.created`) or a bare event (`pull_request`) that catches every
action of it, with the specific key winning. A `switch` on the event would have needed a
second, nested `switch` on the action for every event whose actions mean different things
— `installation.created` and `installation.deleted` do opposite work — and week 3 adds a
handful more. A flat table keeps adding an event to one line, and makes "what does this app
react to" readable in one place. A known event with an unknown action
(`installation.new_permissions_accepted`) has no key, so it lands as `IGNORED` rather than
falling into a neighbouring handler.

## Review history hangs off `Repo`, so a reinstall can come back under a new installation ID

The milestone plan says a reinstall should reuse the original `Installation` row. That only
happens if GitHub returns the same installation ID, and it may not — uninstalling deletes
the installation on GitHub's side, and a reinstall can be a brand-new one. The design does
not depend on which: `Installation` is upserted on its GitHub ID (so the same ID revives
the old row, `deletedAt` cleared), and each `Repo` is upserted on the *repo's* GitHub ID,
which does survive an uninstall, with `installationId` re-pointed at whichever
`Installation` row the reinstall produced. Reviews reference `Repo`, not `Installation`, so
they follow the repo either way. Both cases are covered in
`test/installations.lifecycle.e2e-spec.ts`; the live install → uninstall → reinstall on
the testbed settles which one GitHub actually does.

Settled on 2026-09-11: GitHub issues a new installation ID on every reinstall. Three rounds
on the testbed produced installations 160830774, 160830836 and 160831076, each a new
`Installation` row, the earlier ones soft-deleted. The testbed's single `Repo` row followed
all three, re-pointed each time with `deletedAt` cleared. The plan's polish bar — "the
original `Installation` row is reused" — was based on a premise GitHub does not honour;
the property it was after, history surviving a reinstall, holds through `Repo`.

## `Repo.defaultBranch` became nullable

`installation.created` and `installation_repositories.added` list repositories without
`default_branch`, so the first time this app hears about a repo it does not know that
value. Filling it would mean either a GitHub API call per repo inside a webhook handler, on
the clock of GitHub's ten-second timeout, or a placeholder such as `"main"` — which the
nullable-fields entry above rules out, and which is wrong for every repo still on `master`.
`pull_request` payloads do carry `repository.default_branch`, so week 3 fills it in the
first time a pull request arrives, which is also the first time it is needed.

## Suspending or uninstalling evicts the cached installation token

Milestone 6 left a known gap: GitHub revokes an installation's tokens the moment it is
suspended or uninstalled, but the Redis cache kept serving the revoked token until its TTL
ran out, so every call in that window would 401. `InstallationsService.suspended` and
`deleted` now call `InstallationTokenService.invalidate`, which deletes
`gh:itoken:{installationId}`. It runs even when there is no `Installation` row to update,
because the cache is keyed on GitHub's installation ID, not ours. Unsuspending does nothing
to the cache — the next call is a miss and mints a fresh token.

## The signature is verified against the raw body, never the parsed JSON

GitHub computes `X-Hub-Signature-256` over the exact bytes it sent. By the time a handler
sees `req.body`, Express has parsed those bytes into an object, and turning that object back
into a string with `JSON.stringify` does not reproduce them: key order, whitespace, and
escaping (`\u00e9` versus `é`, `\/` versus `/`) can all differ. So a guard that hashes the
re-serialised body passes on simple payloads in testing and then fails intermittently in
production on exactly the payloads that differ — the worst way for an auth check to fail.
`main.ts` creates the app with `rawBody: true`, which keeps the original `Buffer` on
`req.rawBody` alongside the parsed body, and the guard hashes only that. It rejects a
missing or empty `rawBody` with a 401 rather than falling back to anything, because a
missing raw body means the option was lost, and failing loudly is how that gets noticed.
The e2e suite's tampered-body test changes one value in the real captured bytes and expects
a 401, and removing `rawBody: true` from the test app turns every signed request into a 401.

## e2e tests run against their own database, on real captured payloads

`npm run test:e2e` points `DATABASE_URL` at `pr_reviewer_test` (created by `init.sql`),
applies migrations in a global setup, and truncates between tests — with a guard that
refuses to truncate any database with another name, so a misconfigured environment fails
the run instead of wiping development data. Files run one at a time because they share
that database. The webhook secret is a fixed test value set before `.env` is read, so
signatures in tests never involve the real one. Payloads in `test/fixtures` are copied
from the App's delivery history by `npm run capture:fixtures` rather than written by hand:
a hand-written `installation.created` contains the fields its author expected, and the
cases worth testing are the ones where GitHub sends something the author did not expect.
They are sent as the exact captured string, never re-serialised, for the reason in the
raw-body entry above.

## BullMQ v6, with its own Redis connection

The queue is BullMQ 6 through `@nestjs/bullmq` 12. v6 shipped on 2026-07-30 with breaking
changes and most examples online are still v5, so Milestone 9 started with a smoke test —
one queue, a duplicate job ID, a job that fails once — before building on it; all three
behaved, so there was no reason to pin the older major. BullMQ is given plain connection
options (`REDIS_URL`), not the app's `RedisService` client: workers use blocking Redis
commands, and v6 throws if handed an ioredis client whose `maxRetriesPerRequest` isn't
null, which `RedisService`'s isn't. Given options, BullMQ builds its own connections and
sets that itself. Every key is prefixed (`QUEUE_PREFIX`), and the e2e suite uses its own
prefix, so a running dev server's worker never picks up a test's job.

## A Review row is written before its job is enqueued, and the job carries only its ID

The `pull_request` handler inserts `Review` (`PENDING`, with base and head SHA) first and
enqueues second, with the job ID derived from the review's ID and a payload of
`{ reviewId }` alone. The insert is the same pattern as `WebhookDelivery`:
`@@unique([repoId, prNumber, headSha])` decides whether this commit is already being
reviewed, so two *different* deliveries about the same commit — which delivery-ID
idempotency cannot catch — still produce one review. The job ID makes BullMQ refuse a
duplicate job too, which is what makes one failure mode repairable: if the row was
written but the enqueue failed, a later delivery for the same commit finds the review
still `PENDING` and adds the job again, and if the job did exist that add is a no-op. The
payload is an ID because a job can wait in Redis; everything it needs is read fresh from
the database when it runs, never from a snapshot taken at webhook time.

## The worker runs inside the API process, for now

`ReviewProcessor` is a Nest provider in the same process as the webhook endpoint.
Splitting it into a separate worker process is the right shape for production — a slow
review shouldn't compete with webhook handling for the event loop, and the two should
scale separately — but it is a deployment change, not a code change: the processor class
is the same either way, only where its module is loaded moves. Until there is a deploy
target (roadmap: week 8), one process is one less thing to run locally.

## Only a job's final attempt marks the review FAILED

A review job gets three attempts with exponential backoff. An attempt that throws with
retries left leaves the row `RUNNING` and rethrows, so BullMQ schedules the retry; only the
last attempt writes `FAILED` and the error. Marking it `FAILED` on the first error would be
wrong twice over: the retry would see a settled row and skip it, and a transient GitHub
502 would read as a permanent failure. The settling happens inside the processor, awaited,
rather than in a `failed` event listener, so it cannot race the job's own completion.

## A redelivery of a FAILED delivery is processed again

Milestone 5 dropped every repeat of a delivery ID as a duplicate. That was right for the
common case and wrong for one: when a handler fails, the delivery is `FAILED` and GitHub
sees a 500, and the way to retry it is GitHub's Redeliver button — which then got dropped
as a duplicate, leaving no way to recover. Now a unique-constraint hit reclaims the row
with `updateMany where { deliveryId, status: FAILED }` → `RECEIVED` and processes it again.
The condition is what keeps it race-safe: of two concurrent redeliveries only one update
can match, and the other falls through to "duplicate". `PROCESSED` and `IGNORED`
deliveries are still never processed twice.

## One GitHub client, and "slow down" is not a failure

Every installation-authenticated call goes through `GithubApiService`, which owns the
token, the headers, `Link`-header pagination, and turning a bad response into the right
error. Rate limits get their own error, `GithubRateLimitError`, carrying when to retry:
the primary limit from `x-ratelimit-reset`, a secondary limit from `retry-after`, or a
minute when a secondary limit arrives without one. The worker catches it, moves the job to
BullMQ's delayed set until that time, and throws `DelayedError` — which BullMQ treats as
"rescheduled", so waiting for GitHub never spends one of the job's three attempts. Treating
it as an ordinary failure would have turned an hour-long rate limit into three quick
retries and a `FAILED` review. A 401 drops the cached installation token and retries the
request once, which closes Milestone 6's known gap for tokens revoked before their TTL.

## The diff comes from compare `base...head`, and that was checked, not assumed

`getDiff` uses `/compare/{base}...{head}` with the SHAs recorded on the `Review`, never
`/pulls/{n}`, whose diff moves every time the author pushes. Three dots means "from the
merge base", which is what a PR's Files changed tab shows — but that equivalence was the
kind of claim worth verifying rather than trusting, so `npm run prove:diff` fetches both
and compares them byte for byte. On the testbed's diff-shapes PR (a binary, a rename with
spaces in the name, a deletion, a mode change, a file without a final newline) they were
identical.

## Prisma's upsert can lose a race, so the pull_request path retries it

`prisma.repo.upsert` is read-then-write. Two `pull_request` deliveries for a repo the app
has never seen can both read "absent" and both insert, and the loser fails on a unique
index — here `Repo.fullName`, not the `githubId` in `where`, because Postgres reports
whichever index it checks first. The e2e race test caught it failing three runs in five.
`retryOnUniqueViolation` runs the write once more on P2002; on the second run the read
finds the winner's row and the upsert becomes an update. The alternative, raw
`INSERT … ON CONFLICT`, would only cover the one index named in the conflict clause and
would give up Prisma's typing for a single statement. The installation handlers do not
need the retry and do not have it: `Installation` has a single unique column, so its
upsert is a native `INSERT … ON CONFLICT`, and the second transaction waits on the first's
row lock — a concurrent-install test passes with or without a retry, which is how that was
established.

## A hand-rolled diff parser that fails loudly

The worker parses GitHub's diffs itself rather than with `parse-diff`. The parse is not the
hard part; what matters is which lines a comment may anchor to and on which side, and those
semantics are the whole point of the milestone, so the code that decides them should be
small and owned. It is tested against two real diffs rather than hand-written ones — one
GitHub produced for a testbed PR with every shape at once, and one real `git diff`
generated by a checked-in script for the awkward cases (quoted non-ASCII paths, the tab git
appends to `---`/`+++` when a path has a space, CRLF, omitted hunk counts, empty new files).
It checks each hunk's lines against the counts in its `@@` header and throws on a mismatch.
A lenient parser would keep going and number every later line wrong, and a review comment
on the wrong line is worse than no comment — it lands, pointing at code that is fine.

## The line map was checked against GitHub, and GitHub corrected it

`LineMap.canComment(path, line, side)` is what weeks 5–6 consult before posting, so it has
to agree with GitHub exactly — too strict drops valid findings, too loose gets the whole
review rejected with a 422. Rather than trust a reading of the docs, `npm run
prove:line-map` asks GitHub: for each probe it creates a *pending* review holding one
comment (visible only to the App, no notification), records whether GitHub accepts it, and
deletes it. The first run found a real disagreement: GitHub accepts a renamed file's *old*
path as well as its new one, on both sides. The map now accepts both and exposes
`resolvePath`, which maps either name to the new one, so a finding is stored and
fingerprinted under a single path however it was addressed. Copies are deliberately not
aliased — a copy's source is a different file that still exists. After the fix, all 13
probes agree, including the refusals: a deleted file's new side, a line between hunks, a
binary file, and a rename with no content changes.

The probes also exposed a testing trap worth recording: a pending review can only be seen
by its author, so checking for leftovers with a user's token (`gh api`) reports zero even
when one is there. The script checks as the App.

## Filtering runs in two stages, and the policy is data

The plan said a file is `binary` when GitHub's file list has no `patch` for it. On the
testbed PR that turned out to be three different things: a binary image, a rename with no
content changes, and a mode-only change all arrive without a `patch`, and so do text files
too large for GitHub to render. The file list cannot tell them apart; the parsed diff can.
So filtering happens twice. Stage one runs on the file list, before the diff is fetched —
path rules (lockfiles, generated, vendored), removed files, and the PR-level limits (50
files, 2000 changed lines, counted *after* dropping skipped files, so a lockfile bump next
to a two-line fix is still a small PR). Stage two runs on the parsed diff and drops what has
no lines to review, naming it precisely: `binary` or `no-changes`. Stage one has to come
first because GitHub refuses a very large diff rather than truncating it — the size check
must happen before the fetch that would fail.

The rules are data (`DEFAULT_FILTER_CONFIG`: basenames, suffixes, substrings, directory
names) rather than code, and they match whole names and whole directory segments —
`docs/building.md` and `src/distance.ts` are reviewed; `build/` and `dist/` directories are
not. Month 3's per-repo `.prreviewer.yml` becomes a config object passed in, with no change
to the code that applies it. A skipped review is `ReviewStatus.SKIPPED` with a
`skipReason`, a state of its own rather than `COMPLETED` with no findings, because "we
chose not to look" and "we looked and found nothing" are different answers to give an
author.

## The Check Run is created once, completed on the final outcome, and never left spinning

Each review opens one `pr-reviewer` Check Run on its head commit and stores its ID on the
`Review`, so a retried attempt completes the same run instead of adding a second spinner.
Conclusions follow what happened to the *review*, not what it found: `success` when it ran
(findings are its content, not a failure of the PR), `skipped` when the PR was too large,
`failure` only when the review itself broke after every retry. An attempt that fails with
retries left leaves the run `in_progress`, because the review really is still going; so
does a rate-limit wait.

Two orderings matter. On success the Check Run is completed *before* the row is settled:
the other way round, a failing GitHub call after the row says `COMPLETED` would make the
retry skip a settled review and the spinner would never stop. On the final failure the
Check Run is completed first but *quietly* — if GitHub is the thing that's down, that
error is logged and the row is still marked `FAILED` with the original error, which is the
one worth keeping. Checked live on the testbed: a reviewer forced to crash showed
`in_progress` through two retries, then `failure` with the error in the summary after the
third.

The summary is built by a pure function (`renderCheck`), capped below GitHub's
65,535-character limit and at 50 finding rows, with pipes and newlines escaped so a finding
can't break its table — every wording and edge case is tested without GitHub.
