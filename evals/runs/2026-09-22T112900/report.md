# Evaluation, 2026-09-22 11:29

pr-reviewer:qwen2.5-7b · posting bar high · 3 of 3 run(s) · 29 fixtures (20 bug, 9 clean) · commit 7079343 · stamp 6e8b74d28cd76708

**Note:** Verification of weeks 9-10: a fresh clone of 7079343 with its own agent and an empty tarball cache, to reproduce the baseline.

**Kept** is every finding that survived the second look and validation — what the Check Run lists. **Posted** is what met the posting bar — what a person sees on the pull request. Each number is the mean over runs, with the range in brackets.

## Numbers

| split | level | recall | precision | false positives per clean PR |
|---|---|---|---|---|
| held-out | kept | 43% (29%–57%) | 80% (60%–100%) | 0.22 (0–0.33) |
| held-out | posted | 5% (0%–14%) | 100% (1 run) | 0 |
| tune | kept | 18% (15%–20%) | 58% (38%–80%) | 0.22 (0.17–0.33) |
| tune | posted | 3% (0%–5%) | 75% (50%–100%) | 0 |
| all | kept | 25% (22%–26%) | 64% (54%–70%) | 0.22 (0.11–0.33) |
| all | posted | 4% (0%–7%) | 83% (67%–100%) | 0 |

## Cost

|  | mean | range |
|---|---|---|
| seconds per review | 27 | 3–95 |
| tokens in per review | 10,334 | 3,658–21,549 |
| tokens out per review | 1,025 | 94–4,113 |

87 review(s), 0 failed. A failed review finds nothing: its bugs count as missed.

## Fixtures

Held-out fixtures are left out: they decide, and are not looked at one by one (trap 3).

| fixture | split | run 1 | run 2 | run 3 |
|---|---|---|---|---|
| attrs-disabled-nesting | tune | 0/1 found · 0 kept, 0 posted, 2 refuted | 0/1 found · 0 kept, 0 posted, 1 refuted | 0/1 found · 0 kept, 0 posted, 2 refuted |
| clean-attrs-asdict-perf | tune | 0 kept, 0 posted, 1 refuted | 0 kept, 0 posted, 0 refuted | 0 kept, 0 posted, 3 refuted |
| clean-attrs-ne-validator | tune | 0 kept, 0 posted, 4 refuted | 0 kept, 0 posted, 1 refuted | 0 kept, 0 posted, 0 refuted |
| clean-httpx-socks5h | tune | 0 kept, 0 posted, 0 refuted | 0 kept, 0 posted, 0 refuted | 0 kept, 0 posted, 0 refuted |
| clean-humanize-natural-list | tune | 0 kept, 0 posted, 0 refuted | 0 kept, 0 posted, 0 refuted | 0 kept, 0 posted, 0 refuted |
| clean-semver-lru-delete | tune | 1 kept, 0 posted, 0 refuted | 1 kept, 0 posted, 0 refuted | 0 kept, 0 posted, 1 refuted |
| clean-ufo-filterquery | tune | 1 kept, 0 posted, 1 refuted | 0 kept, 0 posted, 1 refuted | 1 kept, 0 posted, 2 refuted |
| click-choice-brackets | tune | 1/1 found · 1 kept, 0 posted, 0 refuted | 1/1 found · 1 kept, 0 posted, 0 refuted | 0/1 found · 0 kept, 0 posted, 1 refuted |
| cookie-maxage-invalid | tune | 0/1 found · 0 kept, 0 posted, 1 refuted | 1/1 found · 1 kept, 0 posted, 0 refuted | 0/1 found · 0 kept, 0 posted, 1 refuted |
| cookie-maxage-zero | tune | 0/1 found · 0 kept, 0 posted, 0 refuted | 0/1 found · 0 kept, 0 posted, 1 refuted | 1/1 found · 1 kept, 0 posted, 0 refuted |
| cookie-priority-fallback | tune | 0/1 found · 0 kept, 0 posted, 1 refuted | 0/1 found · 0 kept, 0 posted, 0 refuted | 0/1 found · 0 kept, 0 posted, 1 refuted |
| httpx-send-timeout | tune | 0/1 found · 0 kept, 0 posted, 1 refuted | 0/1 found · 0 kept, 0 posted, 1 refuted | 0/1 found · 0 kept, 0 posted, 1 refuted |
| humanize-naturaldelta-years | tune | 0/1 found · 0 kept, 0 posted, 1 refuted | 0/1 found · 0 kept, 0 posted, 1 refuted | 0/1 found · 0 kept, 0 posted, 1 refuted |
| ky-extend-mutation-leak | tune | 0/1 found · 0 kept, 0 posted, 4 refuted | 0/1 found · 0 kept, 0 posted, 4 refuted | 1/1 found · 1 kept, 0 posted, 1 refuted |
| ky-method-uppercase | tune | 0/1 found · 1 kept, 0 posted, 0 refuted | 1/1 found · 1 kept, 0 posted, 0 refuted | 1/1 found · 1 kept, 0 posted, 0 refuted |
| planted-bugs-testbed | tune | 1/7 found · 1 kept, 1 posted, 0 refuted | 1/7 found · 2 kept, 2 posted, 2 refuted | 0/7 found · 0 kept, 0 posted, 3 refuted |
| semver-subset-prerelease | tune | 0/1 found · 0 kept, 0 posted, 1 refuted | 0/1 found · 0 kept, 0 posted, 2 refuted | 0/1 found · 0 kept, 0 posted, 2 refuted |
| ufo-base-prefix-match | tune | 0/1 found · 0 kept, 0 posted, 1 refuted | 0/1 found · 0 kept, 0 posted, 0 refuted | 1/1 found · 1 kept, 0 posted, 1 refuted |
| ufo-parsehost-port | tune | 1/1 found · 3 kept, 0 posted, 0 refuted | 0/1 found · 1 kept, 0 posted, 2 refuted | 0/1 found · 0 kept, 0 posted, 3 refuted |
| ufo-trailing-slash-query | tune | 0/1 found · 0 kept, 0 posted, 1 refuted | 0/1 found · 0 kept, 0 posted, 0 refuted | 0/1 found · 0 kept, 0 posted, 0 refuted |
