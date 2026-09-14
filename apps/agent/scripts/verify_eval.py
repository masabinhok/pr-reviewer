"""Measure the verification pass on findings whose truth is known.

Runs the checker — `graph.check_finding`, the very call the verify node makes — over every
case in evals/verify/cases.json, several times, and reports what it did with the findings
that are known to be wrong and the ones known to be right. Nothing else runs: no review, no
GitHub. The model is the service's: AGENT_MODEL on Ollama by default.

What good looks like: wrong findings refuted (dropped) or at least not confirmed (demoted, so
not posted at the default bar); right findings confirmed. The number that matters most is
wrong findings *confirmed* — those would still be posted.

Usage: uv run python scripts/verify_eval.py [--runs 5] [--only ID-SUBSTRING] [--reasons]
"""

import argparse
import json
import os
import time
from collections import Counter
from dataclasses import replace
from pathlib import Path

import anthropic

from pr_agent.agent.graph import LOCAL_CONFIG, check_finding
from pr_agent.agent.verify import VerifyContext
from pr_agent.models import ProposedFinding

CASES = Path(__file__).resolve().parents[1] / "evals" / "verify" / "cases.json"
OUTCOMES = ["refuted", "unsure", "none", "confirmed"]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--runs", type=int, default=5)
    parser.add_argument("--only", default="")
    parser.add_argument("--reasons", action="store_true", help="print every verdict's reason")
    args = parser.parse_args()

    config = replace(LOCAL_CONFIG, model=os.environ.get("AGENT_MODEL", LOCAL_CONFIG.model))
    url = os.environ.get("OLLAMA_URL", "http://localhost:11434")
    client = anthropic.Anthropic(base_url=url, api_key="ollama", max_retries=1)
    cases = [c for c in json.loads(CASES.read_text()) if args.only in c["id"]]
    print(f"{config.model} · {len(cases)} cases × {args.runs} runs\n")

    tallies: dict[str, Counter] = {}
    started = time.time()
    for case in cases:
        finding = ProposedFinding(**case["finding"])
        context = VerifyContext(hunk=case["hunk"], excerpt=case["excerpt"])
        tally: Counter = Counter()
        for _ in range(args.runs):
            answer, _response = check_finding(client, config, finding, context)
            tally[answer[0] if answer else "none"] += 1
            if args.reasons:
                print(
                    f"    {case['id']}: {answer[0] + ' — ' + answer[1] if answer else 'no verdict'}"
                )
        tallies[case["id"]] = tally
        cells = "  ".join(f"{o} {tally[o]}" for o in OUTCOMES)
        print(f"{case['expected']:5}  {case['finding']['severity']:6}  {case['id']:38}  {cells}")

    print(f"\n{time.time() - started:.0f}s\n")
    for expected in ("wrong", "right"):
        group = [c for c in cases if c["expected"] == expected]
        total = Counter()
        for c in group:
            total.update(tallies[c["id"]])
        n = sum(total.values()) or 1
        shares = ", ".join(f"{o} {100 * total[o] / n:.0f}%" for o in OUTCOMES)
        print(f"{expected} findings ({len(group)} × {args.runs}): {shares}")
    wrong_high = [
        c for c in cases if c["expected"] == "wrong" and c["finding"]["severity"] == "high"
    ]
    still_posted = sum(tallies[c["id"]]["confirmed"] for c in wrong_high)
    print(
        f"wrong high findings still confirmed — still posted at the default bar: "
        f"{still_posted} of {len(wrong_high) * args.runs}"
    )


if __name__ == "__main__":
    main()
