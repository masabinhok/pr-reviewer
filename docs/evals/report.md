# The reviewer, measured

The baseline: `pr-reviewer:qwen2.5-7b` (a 7B model on one 8 GB GPU), posting bar **high**, 29 real
pull requests, 3 runs each — 87 reviews, none failed. Run `2026-09-19T144109`, commit `c4aa887`,
stamp `6e8b74d28cd76708`. The full tables are in
[`evals/runs/2026-09-19T144109/report.md`](../../evals/runs/2026-09-19T144109/report.md); how the
fixtures were made is in [`evals/README.md`](../../evals/README.md).

## The numbers

Every number is the mean over the three runs, with the range. **Posted** is what a person would
have seen on the pull request; **kept** is everything that survived the second look and validation,
which the Check Run lists but nobody is notified about.

| | recall | precision | false positives per clean PR |
|---|---|---|---|
| **posted** (the comments a user sees) | **2%** (0–7%) | 50% (0–100%) | **0.04** (0–0.11) |
| kept (the Check Run's list) | 20% (15–26%) | 49% (44–54%) | 0.41 (0.22–0.56) |
| held-out only, kept | 29% | 67% (33–100%) | 0.56 (0–1.33) |

So the honest headline is: **the reviewer posts almost nothing. It found 2% of known bugs as
comments, at 0.04 false comments per clean pull request.** Quiet, and nearly useless.

Every match was read by hand (trap 6): of 20 location matches, 16 describe the bug and 4 point at
the right line while describing something else — a complaint about leap years where the defect was a
missing `round()`, or "the regex has been modified" with no idea what broke. Those 4 are scored as
misses. Every finding on a clean pull request was audited too (trap 5): all 11 are false positives,
none was a real bug, so no answer key grew.

Cost: 26 s per review at the median, 61 s at the 90th percentile, 112 s at worst; 10,400 tokens in
and 1,200 out on average. Free, on this machine.

## Where the findings go

Across 87 reviews the model proposed 118 findings. What happened to them:

| | count |
|---|---|
| refuted by the second look, never stored | 85 |
| dropped by validation (outside the diff, no failure scenario) | 1 |
| kept: low | 18 |
| kept: medium | 11 |
| kept: high | 3 |
| **posted** (high or above) | **3** |

Three comments in 87 reviews. One was the real double-bracketing bug in click, one was the planted
SQL injection in the testbed, and one was a false positive on a clean attrs change. The severity
distribution is the whole story of the posted numbers: the model calls almost nothing high, and the
bar is high.

The second look refutes **72%** of what the model proposes. Weeks 7–8 measured it on 29 findings of
known truth and it was right 85% of the time on wrong findings; at this rate it is also the main
suspect for the missed bugs, and the eval can now settle that — the agent returns each refuted
finding, and the runner records only the count today.

## What it finds, and what it doesn't

**Found in every run** (2 bugs): a condition deleted from a line that is plainly about brackets
(click), and a removed boundary check in string prefix matching (ufo). Both are "this line lost a
guard" — visible without leaving the diff.

**Found in one run of three** (7 bugs): a removed `Math.floor`, a removed `.toLowerCase()`, a
removed `round()`, a removed array-type check, a lower-case lookup of an un-lower-cased value, the
planted SQL injection, and the planted timing comparison. All findable, none reliable — the same
review on the same code finds it a third of the time.

**Never found, in any run** (11 of 20 bug fixtures): `attrs-disabled-nesting`,
`cookie-maxage-invalid`, `cookie-maxage-zero`, `cookie-priority-fallback`, `httpx-digest-cookies`,
`httpx-send-timeout`, `ky-extend-mutation-leak`, `semver-subset-prerelease`, `ufo-parsehost-port`,
`ufo-parsequery-prototype`, `ufo-trailing-slash-query`. These share a shape: the bug is in what the
changed line *means elsewhere* — a falsy check that eats `0`, a fallback that is reached by another
path, state shared between two calls, a regex that is wrong rather than missing. Reading the diff
is not enough; you have to know the callers, or read the regex character by character.

Two failure modes to keep in mind when reading the numbers: 5 reviews of 87 ended without a
submission (3 `no-submission`, 2 `truncated`) — the model ran out of turns or context rather than
answering; and its confident-sounding findings on clean pull requests are all speculation
("assumes the input is valid", "could lead to unexpected behaviour"), which is exactly what the
posting bar is filtering out.

## What this number is not

- It is one 7B model on one machine. It measures this reviewer, not the idea of an LLM reviewer;
  the same harness with Claude would give another number entirely.
- The answer keys were written by reading each fix (mostly by Claude), not by a second person.
- "Clean" is a belief: these pull requests merged and nobody fixed them afterwards.
- 29 pull requests is small. A 20% recall has a wide error bar, and the range over three runs
  (15–26%) is the honest width of it.
