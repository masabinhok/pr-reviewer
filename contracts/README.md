# The API ↔ agent contract

Two JSON files, one per direction, shared by both test suites so neither side can drift
without the other's tests failing:

| File | Written by | Checked by |
|---|---|---|
| `review-request.json` | the API — `AgentReviewer` builds it from a real testbed PR (`apps/api/src/reviewer/agent-contract.spec.ts`) | the agent — it must validate against `ReviewRequest` (`apps/agent/tests/`) |
| `review-response.json` | the agent — serialised from its `ReviewResponse` model (`apps/agent/tests/test_contract_fixtures.py`) | the API — `AgentReviewer` must map it (`agent-contract.spec.ts`) |

When a change to one side is intended, regenerate that side's file and commit it with the
change:

```bash
cd apps/api   && UPDATE_CONTRACT=1 npx vitest run src/reviewer/agent-contract.spec.ts
cd apps/agent && UPDATE_CONTRACT=1 uv run pytest tests/test_contract_fixtures.py
```

Then run the *other* side's tests: that is the check that the change is compatible.
