# Evaluation fixtures

Real pull requests with known answers, for measuring the reviewer (see `../docs/journal/week9-10.md`).

Each `fixtures/<id>.json` is one pull request:

- **`kind: "bug"`** — a real bug fix from an open-source repository, **reversed**: the review
  goes from the fixed code (`reviewed.base`) back to the code before the fix
  (`reviewed.head`), so the head really has the bug. `bugs` is the answer key: where the fix
  changed code (`head` and `base` line ranges, and `alsoAt` for the same defect in another
  place), and one sentence on what goes wrong.
- **`kind: "clean"`** — a real merged change with no later fix found, reviewed as merged.
  Believed clean, not proven: any comment on one is audited by hand.
- **`split`** — `tune` fixtures can be looked at while changing the reviewer; `heldout` ones
  only decide whether a change is kept.
- **`request`** — exactly what the agent is sent (the API's parsed and filtered diff), without
  an installation token. Only source files are in it: a fix's tests and changelog would give the
  answer away, and the title is neutral for the same reason.
- **`source`** and **`notes`** — where it came from and how its answer was decided.

Add one with:

```bash
cd apps/api
npm run eval:fixture -- --repo owner/name --commit <sha> --kind bug --id <id> --split tune
```

It prints the reviewed diff and a drafted key. Merge and trim the drafted regions, describe each
bug, write the notes; `npm test` fails until the fixture is sound (`src/evals/fixture.spec.ts`).

## Running the evaluation

```bash
npm run agent:eval               # the agent, keeping public tarballs in evals/.cache
cd apps/api && npm run eval      # 3 runs of every fixture — an hour or two on the local model
```

Postgres isn't needed; Ollama is, and Redis for the testbed's token. Each run gets a directory
`evals/runs/<time>/`:

- `meta.json` — the commit, posting bar, fixtures and number of runs it was started with;
- `results.jsonl` — one line per review, written as each finishes, so `--resume <dir>` carries on
  a stopped run;
- `judgments.json` — yours: each location match read and marked `right` or `wrong` (trap 6);
  `--report <dir>` then rewrites
- `report.md` — recall, precision and false positives per clean PR, kept and posted, as the mean
  and range over runs; cost; the tuning fixtures one by one.

The posting bar is applied after the model has answered, so a finished run can be scored again at
another bar without spending any GPU time:

```bash
cd apps/api && npm run eval -- --rescore ../../evals/runs/<dir> --bar medium
```

That writes a new run directory with the same findings and the new posting decisions, and both its
`meta.json` and its report say which run it came from.

A finding is at a bug when it is in the bug's file within three lines of it (`MATCH_DISTANCE`),
on the side it comments on. The held-out fixtures are scored but not shown one by one, in the
report or while running, unless `--show-heldout`: they decide whether a change is kept, and
aren't to be tuned against.
