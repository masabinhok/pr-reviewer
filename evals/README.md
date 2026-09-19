# Evaluation fixtures

Real pull requests with known answers, for measuring the reviewer (see `week9-10.md`).

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
