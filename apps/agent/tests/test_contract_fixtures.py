"""The agent's half of the cross-language contract (see contracts/README.md).

The response file is written from this side's model, so a change to `ReviewResponse`
changes the file — and the API's contract test, which maps that file, then says whether
the API still understands it.
"""

import json
import os
from pathlib import Path

from pr_agent.models import ProposedFinding, ReviewRequest, ReviewResponse, Usage

CONTRACTS = Path(__file__).resolve().parents[3] / "contracts"
RESPONSE = CONTRACTS / "review-response.json"


def sample_response() -> ReviewResponse:
    """A response the agent could really give for the testbed's diff-shapes PR."""
    return ReviewResponse(
        findings=[
            ProposedFinding(
                file="src/auth.ts",
                line=26,
                side="RIGHT",
                severity="high",
                category="security",
                summary="verify() logs the value being verified.",
                why_it_breaks="Every call writes the token under verification to stdout, "
                "so anyone with log access can replay it.",
                suggested_fix="Remove the console.log call.",
            ),
            ProposedFinding(
                file="src/new-feature.ts",
                line=2,
                side="RIGHT",
                severity="medium",
                category="correctness",
                summary="A debugger statement is left in.",
                why_it_breaks="With an inspector attached, greet() halts until someone resumes it.",
                suggested_fix=None,
            ),
            ProposedFinding(
                file="src/helpers.ts",
                line=10,
                side="RIGHT",
                severity="low",
                category="maintainability",
                summary="A new TODO is added.",
                why_it_breaks="The ordering the TODO describes is not implemented.",
                suggested_fix=None,
            ),
        ],
        model="claude-opus-5",
        usage=Usage(
            input_tokens=2400,
            output_tokens=1800,
            cache_read_input_tokens=41000,
            cache_creation_input_tokens=9000,
            cost_usd=0.0921,
        ),
        outcome="submitted",
        turns=6,
        tool_calls=5,
    )


def test_the_response_file_is_what_the_model_serialises():
    serialised = sample_response().model_dump(mode="json", by_alias=True)

    if os.environ.get("UPDATE_CONTRACT"):
        RESPONSE.write_text(json.dumps(serialised, indent=2) + "\n")

    assert json.loads(RESPONSE.read_text()) == serialised, (
        "ReviewResponse changed shape. If intended, regenerate with UPDATE_CONTRACT=1 and run "
        "the API's agent-contract.spec.ts."
    )


def test_the_request_the_api_generated_validates():
    request = ReviewRequest.model_validate(
        json.loads((CONTRACTS / "review-request.json").read_text())
    )

    assert request.files, "the API's request carries the files under review"
