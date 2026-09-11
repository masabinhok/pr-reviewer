"""`submit_review`: how the agent hands in its answer.

A strict tool: with `strict: true` the API guarantees the tool's input matches this schema,
so the findings arrive as valid JSON by construction instead of being parsed out of prose.
The schema is written out by hand because strict mode supports only part of JSON Schema —
every object closed with `additionalProperties: false`, every property required (an
optional value is a nullable one), no numeric or length constraints. Those finer rules
(a line number above zero) are then checked by pydantic, in `parse_submission`.
"""

from typing import Any

from pydantic import TypeAdapter, ValidationError

from ..models import ProposedFinding

SUBMIT_REVIEW = "submit_review"

_FINDING_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "file": {"type": "string", "description": "Path of the file, as shown in the diff."},
        "line": {"type": "integer", "description": "Line number on the given side."},
        "side": {
            "type": "string",
            "enum": ["LEFT", "RIGHT"],
            "description": "RIGHT for added or context lines (new numbers), LEFT for deleted "
            "lines (old numbers).",
        },
        "severity": {"type": "string", "enum": ["high", "medium", "low"]},
        "category": {
            "type": "string",
            "description": "One word or phrase, e.g. correctness, security, concurrency, "
            "error-handling, performance, data-loss.",
        },
        "summary": {"type": "string", "description": "One sentence stating the defect."},
        "why_it_breaks": {
            "type": "string",
            "description": "The concrete failure scenario: specific inputs or state, then the "
            "wrong result, crash or damage.",
        },
        "suggested_fix": {
            "anyOf": [{"type": "string"}, {"type": "null"}],
            "description": "How to fix it, or null.",
        },
    },
    "required": [
        "file",
        "line",
        "side",
        "severity",
        "category",
        "summary",
        "why_it_breaks",
        "suggested_fix",
    ],
    "additionalProperties": False,
}

SUBMIT_REVIEW_TOOL: dict[str, Any] = {
    "name": SUBMIT_REVIEW,
    "description": "Submit the review. Call this exactly once, when you are done, with every "
    "finding. Pass an empty list if the change has no defects.",
    "strict": True,
    "input_schema": {
        "type": "object",
        "properties": {"findings": {"type": "array", "items": _FINDING_SCHEMA}},
        "required": ["findings"],
        "additionalProperties": False,
    },
}

_findings = TypeAdapter(list[ProposedFinding])


def parse_submission(tool_input: dict[str, Any]) -> list[ProposedFinding]:
    """The findings from a submit_review call, validated. Raises ValueError if unusable."""
    try:
        return _findings.validate_python(tool_input.get("findings"), by_name=True)
    except ValidationError as error:
        raise ValueError(
            f"submit_review input is invalid: {error.errors(include_url=False)}"
        ) from error
