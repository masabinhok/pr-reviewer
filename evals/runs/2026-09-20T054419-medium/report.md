# Evaluation, 2026-09-20 05:44

pr-reviewer:qwen2.5-7b · posting bar medium · 3 of 3 run(s) · 29 fixtures (20 bug, 9 clean) · commit c4aa887 · stamp 2d0d39702c903c85

Scored again from `2026-09-19T144109` at this posting bar. No model ran: the findings are that run's.

**Kept** is every finding that survived the second look and validation — what the Check Run lists. **Posted** is what met the posting bar — what a person sees on the pull request. Each number is the mean over runs, with the range in brackets.

## Numbers

| split | level | recall | precision | false positives per clean PR |
|---|---|---|---|---|
| held-out | kept | 29% | 67% (33%–100%) | 0.56 (0–1.33) |
| held-out | posted | 5% (0%–14%) | 25% (1 run) | 0.33 (0–1) |
| tune | kept | 18% (10%–30%) | 55% (29%–75%) | 0.33 (0.17–0.50) |
| tune | posted | 10% (5%–15%) | 64% (33%–100%) | 0.06 (0–0.17) |
| all | kept | 21% (15%–30%) | 52% (44%–62%) | 0.41 (0.22–0.56) |
| all | posted | 9% (4%–11%) | 48% (33%–60%) | 0.15 (0–0.33) |

## Cost

|  | mean | range |
|---|---|---|
| seconds per review | 32 | 3–112 |
| tokens in per review | 10,449 | 3,652–24,751 |
| tokens out per review | 1,156 | 94–4,243 |

87 review(s), 0 failed. A failed review finds nothing: its bugs count as missed.

## Fixtures

Held-out fixtures are left out: they decide, and are not looked at one by one (trap 3).

| fixture | split | run 1 | run 2 | run 3 |
|---|---|---|---|---|
| attrs-disabled-nesting | tune | 0/1 found · 0 kept, 0 posted, 2 refuted | 0/1 found · 0 kept, 0 posted, 0 refuted | 0/1 found · 0 kept, 0 posted, 1 refuted |
| clean-attrs-asdict-perf | tune | 0 kept, 0 posted, 0 refuted | 0 kept, 0 posted, 4 refuted | 0 kept, 0 posted, 4 refuted |
| clean-attrs-ne-validator | tune | 0 kept, 0 posted, 1 refuted | 0 kept, 0 posted, 0 refuted | 0 kept, 0 posted, 0 refuted |
| clean-httpx-socks5h | tune | 0 kept, 0 posted, 0 refuted | 0 kept, 0 posted, 0 refuted | 0 kept, 0 posted, 0 refuted |
| clean-humanize-natural-list | tune | 0 kept, 0 posted, 0 refuted | 0 kept, 0 posted, 0 refuted | 1 kept, 0 posted, 6 refuted |
| clean-semver-lru-delete | tune | 1 kept, 0 posted, 0 refuted | 1 kept, 0 posted, 0 refuted | 1 kept, 1 posted, 0 refuted |
| clean-ufo-filterquery | tune | 1 kept, 0 posted, 2 refuted | 0 kept, 0 posted, 0 refuted | 1 kept, 0 posted, 0 refuted |
| click-choice-brackets | tune | 1/1 found · 1 kept, 0 posted, 0 refuted | 1/1 found · 1 kept, 0 posted, 1 refuted | 1/1 found · 1 kept, 1 posted, 0 refuted |
| cookie-maxage-invalid | tune | 0/1 found · 0 kept, 0 posted, 1 refuted | 0/1 found · 0 kept, 0 posted, 0 refuted | 0/1 found · 0 kept, 0 posted, 1 refuted |
| cookie-maxage-zero | tune | 0/1 found · 0 kept, 0 posted, 1 refuted | 0/1 found · 0 kept, 0 posted, 1 refuted | 1/1 found · 1 kept, 0 posted, 0 refuted |
| cookie-priority-fallback | tune | 0/1 found · 0 kept, 0 posted, 1 refuted | 0/1 found · 0 kept, 0 posted, 1 refuted | 0/1 found · 0 kept, 0 posted, 0 refuted |
| httpx-send-timeout | tune | 0/1 found · 0 kept, 0 posted, 1 refuted | 0/1 found · 0 kept, 0 posted, 1 refuted | 0/1 found · 0 kept, 0 posted, 1 refuted |
| humanize-naturaldelta-years | tune | 0/1 found · 1 kept, 1 posted, 0 refuted | 0/1 found · 0 kept, 0 posted, 1 refuted | 1/1 found · 1 kept, 1 posted, 0 refuted |
| ky-extend-mutation-leak | tune | 0/1 found · 0 kept, 0 posted, 2 refuted | 0/1 found · 0 kept, 0 posted, 4 refuted | 0/1 found · 0 kept, 0 posted, 3 refuted |
| ky-method-uppercase | tune | 0/1 found · 0 kept, 0 posted, 1 refuted | 1/1 found · 1 kept, 1 posted, 0 refuted | 0/1 found · 0 kept, 0 posted, 1 refuted |
| planted-bugs-testbed | tune | 0/7 found · 0 kept, 0 posted, 2 refuted | 0/7 found · 0 kept, 0 posted, 1 refuted | 2/7 found · 2 kept, 1 posted, 4 refuted |
| semver-subset-prerelease | tune | 0/1 found · 0 kept, 0 posted, 2 refuted | 0/1 found · 0 kept, 0 posted, 2 refuted | 0/1 found · 0 kept, 0 posted, 2 refuted |
| ufo-base-prefix-match | tune | 1/1 found · 1 kept, 1 posted, 1 refuted | 1/1 found · 1 kept, 1 posted, 0 refuted | 1/1 found · 1 kept, 0 posted, 0 refuted |
| ufo-parsehost-port | tune | 0/1 found · 2 kept, 1 posted, 0 refuted | 0/1 found · 0 kept, 0 posted, 2 refuted | 0/1 found · 1 kept, 1 posted, 1 refuted |
| ufo-trailing-slash-query | tune | 0/1 found · 0 kept, 0 posted, 1 refuted | 0/1 found · 0 kept, 0 posted, 0 refuted | 0/1 found · 0 kept, 0 posted, 0 refuted |
