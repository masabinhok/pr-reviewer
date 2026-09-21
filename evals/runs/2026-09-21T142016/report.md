# Evaluation, 2026-09-21 14:20

pr-reviewer:qwen2.5-7b · posting bar high · 3 of 3 run(s) · 9 fixtures (6 bug, 3 clean) · commit 8c141fa · stamp 6e8b74d28cd76708

**Note:** M34 decision run: the agent was started with AGENT_VERIFY=false (no second look); the stamp is of the committed defaults, which have it on. Held-out split only, run after the decision rule was committed (8c141fa).

**Kept** is every finding that survived the second look and validation — what the Check Run lists. **Posted** is what met the posting bar — what a person sees on the pull request. Each number is the mean over runs, with the range in brackets.

## Numbers

| split | level | recall | precision | false positives per clean PR |
|---|---|---|---|---|
| held-out | kept | 81% (57%–100%) | 76% (73%–83%) | 0.78 (0.33–1) |
| held-out | posted | 0% | — | 0 |
| tune | kept | — | — | — |
| tune | posted | — | — | — |
| all | kept | 81% (57%–100%) | 76% (73%–83%) | 0.78 (0.33–1) |
| all | posted | 0% | — | 0 |

## Cost

|  | mean | range |
|---|---|---|
| seconds per review | 25 | 10–111 |
| tokens in per review | 8,736 | 3,840–18,029 |
| tokens out per review | 910 | 353–4,172 |

27 review(s), 0 failed. A failed review finds nothing: its bugs count as missed.

## Fixtures

Held-out fixtures are left out: they decide, and are not looked at one by one (trap 3).

| fixture | split | run 1 | run 2 | run 3 |
|---|---|---|---|---|
