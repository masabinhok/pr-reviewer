"""The verification evaluation set stays usable: every source became a case, every finding
still parses, and the known-right and known-wrong findings are both there."""

import json
from pathlib import Path

from pr_agent.models import ProposedFinding

VERIFY = Path(__file__).resolve().parents[1] / "evals" / "verify"


def test_every_source_is_a_built_case_with_the_same_finding():
    sources = json.loads((VERIFY / "sources.json").read_text())
    cases = json.loads((VERIFY / "cases.json").read_text())

    assert [c["id"] for c in cases] == [s["id"] for s in sources], (
        "sources.json changed; rebuild cases.json with evals/verify/build_cases.py"
    )
    for source, case in zip(sources, cases, strict=True):
        assert case["finding"] == source["finding"] and case["expected"] == source["expected"]


def test_cases_parse_and_carry_the_code_the_checker_reads():
    cases = json.loads((VERIFY / "cases.json").read_text())

    assert len({c["id"] for c in cases}) == len(cases)
    assert {c["expected"] for c in cases} == {"right", "wrong"}
    for case in cases:
        ProposedFinding(**case["finding"])
        assert case["excerpt"] or case["hunk"], f"{case['id']} gives the checker nothing to read"
