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

(Handler implementation lands in Milestone 5 — this entry covers the schema-level design
decided in Milestone 3.)
