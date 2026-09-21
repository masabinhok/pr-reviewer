# Evaluation, 2026-09-20 05:45

pr-reviewer:qwen2.5-7b · posting bar high · 3 of 3 run(s) · 20 fixtures (14 bug, 6 clean) · commit 5a4148e · stamp 6e8b74d28cd76708

**Note:** M34 experiment: the agent was started with AGENT_VERIFY=false (no second look); the stamp is of the committed defaults, which have it on. Tuning split only. One review (clean-httpx-socks5h, run 3) was in flight while the machine slept, so its 5,674 s is wall-clock time, not review time.

**Kept** is every finding that survived the second look and validation — what the Check Run lists. **Posted** is what met the posting bar — what a person sees on the pull request. Each number is the mean over runs, with the range in brackets.

## Numbers

| split | level | recall | precision | false positives per clean PR |
|---|---|---|---|---|
| held-out | kept | — | — | — |
| held-out | posted | — | — | — |
| tune | kept | 50% (45%–55%) | 40% (37%–43%) | 1.78 (1.50–2.17) |
| tune | posted | 7% (5%–10%) | 83% (50%–100%) | 0 |
| all | kept | 50% (45%–55%) | 40% (37%–43%) | 1.78 (1.50–2.17) |
| all | posted | 7% (5%–10%) | 83% (50%–100%) | 0 |

## Cost

|  | mean | range |
|---|---|---|
| seconds per review | 118 | 3–5,674 |
| tokens in per review | 8,519 | 3,591–25,619 |
| tokens out per review | 965 | 94–4,206 |

60 review(s), 0 failed. A failed review finds nothing: its bugs count as missed.

## Fixtures

Held-out fixtures are left out: they decide, and are not looked at one by one (trap 3).

| fixture | split | run 1 | run 2 | run 3 |
|---|---|---|---|---|
| attrs-disabled-nesting | tune | 0/1 found · 1 kept, 0 posted, 0 refuted | 0/1 found · 0 kept, 0 posted, 0 refuted | 0/1 found · 0 kept, 0 posted, 0 refuted |
| clean-attrs-asdict-perf | tune | 4 kept, 0 posted, 0 refuted | 2 kept, 0 posted, 0 refuted | 5 kept, 0 posted, 0 refuted |
| clean-attrs-ne-validator | tune | 0 kept, 0 posted, 0 refuted | 1 kept, 0 posted, 0 refuted | 2 kept, 0 posted, 0 refuted |
| clean-httpx-socks5h | tune | 0 kept, 0 posted, 0 refuted | 0 kept, 0 posted, 0 refuted | 4 kept, 0 posted, 0 refuted |
| clean-humanize-natural-list | tune | 2 kept, 0 posted, 0 refuted | 4 kept, 0 posted, 0 refuted | 0 kept, 0 posted, 0 refuted |
| clean-semver-lru-delete | tune | 1 kept, 0 posted, 0 refuted | 1 kept, 0 posted, 0 refuted | 1 kept, 0 posted, 0 refuted |
| clean-ufo-filterquery | tune | 2 kept, 0 posted, 0 refuted | 2 kept, 0 posted, 0 refuted | 1 kept, 0 posted, 0 refuted |
| click-choice-brackets | tune | 1/1 found · 1 kept, 0 posted, 0 refuted | 1/1 found · 1 kept, 0 posted, 0 refuted | 1/1 found · 1 kept, 0 posted, 0 refuted |
| cookie-maxage-invalid | tune | 1/1 found · 1 kept, 0 posted, 0 refuted | 1/1 found · 1 kept, 0 posted, 0 refuted | 1/1 found · 1 kept, 0 posted, 0 refuted |
| cookie-maxage-zero | tune | 1/1 found · 1 kept, 0 posted, 0 refuted | 1/1 found · 1 kept, 0 posted, 0 refuted | 1/1 found · 1 kept, 0 posted, 0 refuted |
| cookie-priority-fallback | tune | 0/1 found · 0 kept, 0 posted, 0 refuted | 1/1 found · 1 kept, 0 posted, 0 refuted | 1/1 found · 1 kept, 0 posted, 0 refuted |
| httpx-send-timeout | tune | 0/1 found · 0 kept, 0 posted, 0 refuted | 0/1 found · 0 kept, 0 posted, 0 refuted | 1/1 found · 1 kept, 0 posted, 0 refuted |
| humanize-naturaldelta-years | tune | 0/1 found · 0 kept, 0 posted, 0 refuted | 1/1 found · 1 kept, 0 posted, 0 refuted | 1/1 found · 1 kept, 0 posted, 0 refuted |
| ky-extend-mutation-leak | tune | 1/1 found · 4 kept, 0 posted, 0 refuted | 1/1 found · 2 kept, 0 posted, 0 refuted | 1/1 found · 2 kept, 0 posted, 0 refuted |
| ky-method-uppercase | tune | 1/1 found · 1 kept, 0 posted, 0 refuted | 0/1 found · 1 kept, 1 posted, 0 refuted | 0/1 found · 1 kept, 0 posted, 0 refuted |
| planted-bugs-testbed | tune | 1/7 found · 2 kept, 1 posted, 0 refuted | 3/7 found · 10 kept, 1 posted, 0 refuted | 2/7 found · 2 kept, 1 posted, 0 refuted |
| semver-subset-prerelease | tune | 1/1 found · 2 kept, 0 posted, 0 refuted | 1/1 found · 2 kept, 0 posted, 0 refuted | 0/1 found · 0 kept, 0 posted, 0 refuted |
| ufo-base-prefix-match | tune | 1/1 found · 2 kept, 0 posted, 0 refuted | 1/1 found · 2 kept, 0 posted, 0 refuted | 1/1 found · 1 kept, 1 posted, 0 refuted |
| ufo-parsehost-port | tune | 0/1 found · 2 kept, 0 posted, 0 refuted | 0/1 found · 3 kept, 0 posted, 0 refuted | 0/1 found · 2 kept, 0 posted, 0 refuted |
| ufo-trailing-slash-query | tune | 1/1 found · 2 kept, 0 posted, 0 refuted | 0/1 found · 0 kept, 0 posted, 0 refuted | 0/1 found · 0 kept, 0 posted, 0 refuted |
