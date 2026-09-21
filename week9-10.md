# Week 9–10 Build Guide: Evals

## Context

Weeks 1–8 built the reviewer and then spent four weeks fighting its noise: a posting bar, a
second look, dedupe across pushes, retiring stale comments, feedback from reactions, and a
dashboard to watch it. Every one of those decisions was measured on a handful of cases — the
planted-bugs PR, five dogfooded PRs, 29 findings of known truth.

Weeks 9–10 replace the handful with **an evaluation**: a fixed set of real pull requests
with known answers, a runner that reviews each one through the production code, and two
numbers that say how good the reviewer is:

- **Recall** — of the known bugs, how many did it find?
- **False positives per clean PR** — on a pull request with nothing wrong, how many comments
  did it post?

The roadmap's goal is one sentence in the README — "measured N% recall at M false positives
per clean PR" — backed by a report anyone can rerun. And a prompt change should not be able to
land without being measured.

Everything still runs for free, on the local model, on this machine.

---

## Definition of done

Weeks 9–10 are complete when all of these are true:

1. `evals/` holds **about 20 real pull requests with known bugs** from open-source repositories,
   each with an answer key, and **about 10 clean pull requests**, plus the testbed's planted-bugs
   PR. Every fixture says where it came from and how its answer was decided.
2. One command runs the evaluation **through the production code** — the same agent, the same
   validation, second look, posting bar and dedupe — and writes a report.
3. The report gives recall and precision at two levels (**kept**, and **posted** — what a user
   would actually see), false positives per clean PR, and time per review, each over several
   runs with the spread shown, never a single run.
4. `docs/evals/report.md` holds the baseline, and the README's opening states the headline
   number, linking to it.
5. **At least one change to the reviewer is decided by the eval** — kept if it improves the held-out
   numbers, reverted if it doesn't — and written down either way.
6. **CI** runs lint and the unit and e2e suites of the API, the agent and the dashboard on every push
   — the CI carried over since week 2 — and fails a change to the prompt or the reviewer's
   configuration that has no eval report made with it.
7. `docs/decisions.md` has an entry per non-obvious choice.

---

## Verified environment facts

Checked on 2026-09-18.

| Thing | Status |
|---|---|
| Public repository tarballs | Download **without a token**: `api.github.com/repos/{o}/{r}/tarball/{sha}` redirects to `codeload`, 200 — the eval needs no App installation on the repos it reviews |
| GitHub API without a token | 60 requests an hour; with `gh`'s token, 5000 — fixture building uses `gh`'s |
| This repository | **Private** — GitHub Actions minutes are limited on the free plan |
| Time per review, local model | 15 s – 3 min with the second look; ~20k–140k tokens in |
| The existing measuring tools | `try:review` (a live PR, printed), `DUMP_REQUEST` (the agent's exact request), `scripts/replay.py` (offline, a request and a checkout), `scripts/verify_eval.py` (the second look alone) |

### Traps — read before starting

**1. CI cannot run the model.** GitHub's runners have no GPU; a 7B model on their CPUs would take
many minutes per turn, for every fixture, on every push — and this repository's CI minutes are
limited. So CI doesn't run the eval. It checks that the eval *was* run: a report records the hash
of everything that shapes the reviewer's answers (prompts, tool definitions, the agent's
settings, the posting rules), and CI fails if those files changed without a report carrying the
new hash. The eval runs here, on the GPU; CI makes skipping it visible.

**2. A small model is noisy.** The same PR gave 1, 2 and 5 findings on three runs. One run of the
eval says little: every number is reported over several runs with its range, and a change is
only "better" if it beats the baseline by more than the spread.

**3. Don't tune on the test set.** It is easy to adjust a prompt until the fixtures pass and
learn nothing. Split the fixtures once, up front — a **tuning** set to look at while changing
things, a **held-out** set that decides — and never look at the held-out results case by case
while tuning.

**4. "Known bug" has to mean something.** The honest source is a real bug fix: take a merged
commit that fixed a bug, and review the change *that introduced the fix's reverse* — the code
before the fix, as if it were a new pull request. The answer key is then the lines the real fix
changed. Where that reversal isn't a sensible pull request, don't use the fix.

**5. "Clean" is a belief, not a fact.** A merged PR that nobody fixed later is probably clean, not
certainly. Count every posted comment on a clean PR as a false positive, then audit each by
hand: a real bug found there is recorded as such, and the fixture's answer key grows.

**6. A location match is not a correct finding.** A comment on the right line that describes a
different problem found nothing. Match on location first (same file, within three lines of the
bug), then read every match once and confirm it describes the bug — cheap at this size, and the
number stays honest.

**7. The machine forgets.** Postgres, Redis and Ollama must be up before a run; a full evaluation
is an hour or two of GPU time, so it runs in the background and writes as it goes.

---

## Workflow

**Changed from weeks 3–8:** no GitHub issues, milestones or pull requests. Each milestone is
worked on `main` directly, in as many commits as it needs, and ends with a separate `complete
milestone N` commit that ticks its boxes in this file.

---

## Milestone 30 — The fixtures

- An `evals/` directory with a fixture format: the pull request (repository, base and head
  commits), the agent's request as the API would build it (parsed and filtered diff — the
  `DUMP_REQUEST` shape), and an answer key (for each bug: file, the lines, one sentence on what
  goes wrong), and for clean ones an empty key. Plus provenance: where it came from, which fix, who
  judged it.
- A builder, `npm run eval:fixture`, that takes a repository and a bug-fix commit, makes the
  reversed change into a fixture — fetching the diff with `gh`'s token and parsing and filtering it
  with the API's own code — and writes the answer key from the fix's changed lines, for a person to
  check and edit.
- About **20 bug fixtures** from small-to-medium open-source TypeScript and Python repositories:
  logic bugs a reviewer could see (not typos, docs or flaky tests), fixes touching at most three
  files. About **10 clean fixtures**: merged pull requests with no later fix. The planted-bugs PR
  joins as one more, with its existing key.
- The split (trap 3), recorded in the fixtures.

**Todo**
- [x] Fixture format and its validation (a fixture that doesn't parse or whose key points outside the diff is an error)
- [x] `npm run eval:fixture`: fix → reversed fixture, key drafted from the fix
- [x] ~20 bug fixtures, ~10 clean ones, the planted-bugs PR — each key checked by hand (keys written by Claude from reading each diff and fix; a second look by you is still welcome — the fixture notes say which)
- [x] The tuning / held-out split
- [x] Tests: the builder on a recorded fix, and the validation

**Learn:** what makes a benchmark honest — ground truth you didn't make up, and a split you don't peek at.

---

## Milestone 31 — The runner and the scoring

- `npm run eval` runs every fixture through the **production path**: the agent reviews the fixture's
  request against a snapshot of the repository at its head commit (a public tarball, cached
  locally); the API's `validateFindings`, posting bar and dedupe decide what would have been
  stored and posted.
- The agent accepts a request with no installation token for a **public** repository, and
  downloads its tarball without one (trap 4's fixtures live in repositories the App isn't
  installed on).
- Scoring: a finding matches a bug when it is in the same file within three lines of the bug's
  lines (trap 6); recall and precision at the kept and posted levels; false positives per clean PR;
  time and tokens per review. Several runs (default 3), each reported, then mean and range.
- Results written as the run goes, so a stopped run keeps what it did.

**Todo**
- [x] Token-free snapshots for public repositories, in the agent (tested)
- [x] The runner, reusing the production validation and posting rules, not copying them
- [x] Scoring, with the matching rule, tested on hand-made results
- [x] Runs, spread, and writing as it goes
- [x] A report: overall, per fixture, per run

**Learn:** measuring a nondeterministic system — spread, not single numbers.

---

## Milestone 32 — The baseline

- The full evaluation on the current reviewer, 3 runs, every fixture.
- Every match read once (trap 6), every false positive on a clean PR audited (trap 5), the verdicts
  recorded in the report.
- `docs/evals/report.md`: the headline numbers, what the reviewer is good and bad at by kind of bug,
  and the worst fixtures.
- The README's opening gets the sentence: "measured N% recall at M false positives per clean PR".

**Todo**
- [x] Baseline run, 3 × all fixtures
- [x] Matches confirmed and false positives audited by hand
- [x] `docs/evals/report.md`
- [x] The README's headline number, linked to the report

**Learn:** reading an eval: where the number comes from, and which failures it hides.

---

## Milestone 33 — CI, and the eval as a gate

- GitHub Actions: lint and unit tests for the API, the agent and the dashboard; the API's e2e suite
  with Postgres and Redis as services; the dashboard's build and smoke test. On every push.
- The eval stamp (trap 1): a hash over everything that shapes the reviewer's answers, written into
  every report. A CI job recomputes it and fails if the latest report's stamp doesn't match —
  "the prompt changed; run `npm run eval` and commit the report".
- Kept within the free minutes: cache dependencies, and skip jobs for the parts a push didn't touch.

**Todo**
- [x] Workflow: lint, unit, e2e (with services), dashboard build and smoke
- [x] The eval stamp, computed the same way locally and in CI
- [x] The stamp check, failing with a message that says what to run
- [x] Caching and path filters

**Learn:** CI for a system whose real test is too expensive to run in CI.

---

## Milestone 34 — Improve it, with the eval deciding

- Pick the reviewer's biggest weakness from the baseline report. The obvious candidates: the
  prompt injection costing findings (weeks 5–6), a small model missing bugs in long diffs (review
  file by file), the second look's 20% of real bugs refuted.
- Make **one** change at a time on the tuning set; run the held-out set only to decide. Keep a
  change only if it beats the baseline by more than the spread (trap 2).
- Record every attempt — kept or reverted — with its numbers.

**Todo**
- [x] One or more changes, each measured on tuning then held-out
- [x] Kept or reverted by the numbers, recorded
- [x] Report and README updated if the headline moves (it didn't: both changes reverted; the README's number was corrected to the re-judged baseline)

**Learn:** hill-climbing against an eval without fooling yourself.

---

## Milestone 35 — Docs

- `docs/decisions.md` entries: the fixture source and why reversed fixes, the matching rule, why
  CI checks a stamp instead of running the eval, the split, what the improvement round learned.
- README: the eval section — how to run it, how long it takes, what the numbers mean.

**Todo**
- [ ] `decisions.md` entries above
- [ ] README current

---

## Suggested pacing

| Days | Milestone |
|---|---|
| 57–59 | 30 (fixtures) — the slow, careful part |
| 60–62 | **31 (runner and scoring)** |
| 63–64 | 32 (baseline) |
| 65–66 | 33 (CI and the gate) |
| 67–69 | 34 (improve, measured) |
| 70 | 35 (docs) |

---

## Verification checklist

When weeks 9–10 are done (ask Claude to "verify week 9-10"):

1. `npm run eval` from a clean checkout reproduces the report's numbers within their spread.
2. Every fixture validates; every bug fixture's key points at lines in its diff; the split is
   recorded and the held-out set was only used to decide.
3. The README's number matches `docs/evals/report.md`.
4. Change a word of the prompt and push: CI fails and says to run the eval; run it, commit the
   report, and CI passes.
5. CI runs lint, unit, e2e and the dashboard smoke test green.
6. Anti-patterns to grep for: a score from a single run, a runner that reimplements validation
   instead of calling it, a fixture without provenance, held-out results read while tuning.
