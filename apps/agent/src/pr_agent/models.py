"""The contract between the API (NestJS) and the agent.

These mirror `ReviewContext` and `ProposedFinding` in apps/api/src/reviewer/reviewer.ts and
the parsed-diff types in apps/api/src/diff/diff.types.ts. JSON on the wire is camelCase,
as the API writes it; Python code uses snake_case.
"""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, SecretStr
from pydantic.alias_generators import to_camel


class Wire(BaseModel):
    """camelCase on the wire, snake_case in Python, and unknown fields are an error."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid")


Side = Literal["LEFT", "RIGHT"]
Severity = Literal["high", "medium", "low"]


class DiffLine(Wire):
    kind: Literal["add", "del", "context"]
    old_line: int | None = None
    new_line: int | None = None
    content: str
    no_newline_at_end: bool | None = None


class Hunk(Wire):
    old_start: int
    old_lines: int
    new_start: int
    new_lines: int
    section: str
    lines: list[DiffLine]


class DiffFile(Wire):
    path: str
    old_path: str
    status: Literal["added", "removed", "modified", "renamed", "copied"]
    binary: bool
    mode_change: dict[str, str] | None = None
    hunks: list[Hunk]


class ReviewRequest(Wire):
    repo: str = Field(pattern=r"^[\w.-]+/[\w.-]+$")
    pr_number: int = Field(gt=0)
    title: str
    body: str
    base_sha: str = Field(pattern=r"^[0-9a-f]{7,40}$")
    head_sha: str = Field(pattern=r"^[0-9a-f]{7,40}$")
    # Short-lived (one hour at most) and scoped to one installation. SecretStr keeps it out
    # of reprs, logs and validation errors.
    installation_token: SecretStr
    # Only files that survived the API's filters — the ones a comment may go on.
    files: list[DiffFile]


class ProposedFinding(Wire):
    """The roadmap's agent output schema. The API validates each one against its line map."""

    file: str
    line: int = Field(gt=0)
    side: Side
    severity: Severity
    category: str
    summary: str
    why_it_breaks: str
    suggested_fix: str | None = None


class Usage(Wire):
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_input_tokens: int = 0
    cache_creation_input_tokens: int = 0


class ReviewResponse(Wire):
    findings: list[ProposedFinding]
    model: str
    usage: Usage
