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
