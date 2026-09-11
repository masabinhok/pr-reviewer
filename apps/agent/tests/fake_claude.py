"""A scripted stand-in for the Anthropic client.

The `anthropic` 1.x SDK sends its requests through `httpx2`, which HTTP-mocking libraries
don't see — so the agent's tests don't mock HTTP. They give the agent an object with the
same `beta.messages.create` method, returning real SDK `BetaMessage`s built from a script,
and record every request the agent made.
"""

from itertools import count
from typing import Any

from anthropic.types.beta import BetaMessage

_ids = count(1)


def tool_use(name: str, **input: Any) -> dict[str, Any]:
    return {"type": "tool_use", "id": f"toolu_{next(_ids):04d}", "name": name, "input": input}


def text(value: str) -> dict[str, Any]:
    return {"type": "text", "text": value}


def message(
    *content: dict[str, Any],
    stop_reason: str | None = None,
    model: str = "claude-opus-5",
    input_tokens: int = 1000,
    output_tokens: int = 100,
    cache_read: int = 0,
    cache_write: int = 0,
) -> BetaMessage:
    if stop_reason is None:
        stop_reason = "tool_use" if any(c["type"] == "tool_use" for c in content) else "end_turn"
    return BetaMessage.model_validate(
        {
            "id": f"msg_{next(_ids):04d}",
            "type": "message",
            "role": "assistant",
            "model": model,
            "content": list(content),
            "stop_reason": stop_reason,
            "stop_sequence": None,
            "usage": {
                "input_tokens": input_tokens,
                "output_tokens": output_tokens,
                "cache_read_input_tokens": cache_read,
                "cache_creation_input_tokens": cache_write,
            },
        }
    )


class FakeClaude:
    """Returns the scripted messages in order; fails loudly if the agent asks for more.

    It stands in for a local model through Ollama too — same client, same message shapes.
    A scripted exception is raised instead of answered, as the SDK would.
    """

    def __init__(self, *script: BetaMessage | Exception):
        self.script = list(script)
        self.requests: list[dict[str, Any]] = []
        self.beta = self
        self.messages = self

    def create(self, **request: Any) -> BetaMessage:
        # Snapshot the conversation as sent: the agent keeps appending to its own list.
        self.requests.append({**request, "messages": list(request["messages"])})
        if not self.script:
            raise AssertionError(f"the agent made request {len(self.requests)}, beyond the script")
        answer = self.script.pop(0)
        if isinstance(answer, Exception):
            raise answer
        return answer


def finding(**overrides: Any) -> dict[str, Any]:
    """A submit_review finding in the tool's snake_case schema."""
    return {
        "file": "src/auth.ts",
        "line": 26,
        "side": "RIGHT",
        "severity": "low",
        "category": "debugging",
        "summary": "console.log is left in.",
        "why_it_breaks": "Every call to verify() writes the token being verified to stdout.",
        "suggested_fix": None,
        **overrides,
    }
