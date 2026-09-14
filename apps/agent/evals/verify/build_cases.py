"""Build cases.json — the verification evaluation set — from sources.json.

Each source names a finding whose truth is known, and the pull request and head commit it
was made against. This attaches exactly what the checker would read in production: the
diff hunk and the code around the line, computed by `verify.context_for` from the request
the API sends and a snapshot of the repository at that commit. The result is self-contained,
so the evaluation runs with no GitHub, database or checkout.

Inputs, prepared once:
  --requests DIR   <owner>__<repo>__<pr>.json, each written by
                   `DUMP_REQUEST=... npm run try:review <owner/repo> <pr>` (in apps/api)
  --checkouts DIR  <owner>__<repo>@<head>/, the repository at that commit
                   (`git archive <head> | tar -x -C ...`, or the GitHub tarball)

Usage: uv run python evals/verify/build_cases.py --requests DIR --checkouts DIR
"""

import argparse
import json
from pathlib import Path

from pr_agent.agent.verify import context_for
from pr_agent.models import ProposedFinding, ReviewRequest
from pr_agent.repo.tools import RepoTools

HERE = Path(__file__).resolve().parent


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--requests", type=Path, required=True)
    parser.add_argument("--checkouts", type=Path, required=True)
    args = parser.parse_args()

    cases = []
    for source in json.loads((HERE / "sources.json").read_text()):
        slug = source["repo"].replace("/", "__")
        raw = json.loads((args.requests / f"{slug}__{source['pr']}.json").read_text())
        if not raw["headSha"].startswith(source["head"]):
            raise SystemExit(
                f"{source['id']}: request is at {raw['headSha'][:7]}, not {source['head']}"
            )
        raw["installationToken"] = "ghs_not_needed_offline"
        request = ReviewRequest.model_validate(raw)
        tools = RepoTools(args.checkouts / f"{slug}@{source['head']}", request)

        context = context_for(ProposedFinding(**source["finding"]), tools)
        missing = [
            name
            for name, text in (("hunk", context.hunk), ("excerpt", context.excerpt))
            if not text
        ]
        if missing:
            print(f"note: {source['id']} has no {' or '.join(missing)}")
        cases.append({**source, "hunk": context.hunk, "excerpt": context.excerpt})

    (HERE / "cases.json").write_text(json.dumps(cases, indent=2) + "\n")
    print(f"wrote {len(cases)} cases to {HERE / 'cases.json'}")


if __name__ == "__main__":
    main()
