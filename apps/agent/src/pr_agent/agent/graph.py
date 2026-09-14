"""The review agent as a LangGraph state graph.

          ┌──────────────┐   tool calls   ┌───────────┐
start ──▶ │  call_model  │ ─────────────▶ │ run_tools │ ──▶ end, once submit_review
          │   (model)    │ ◀───────────── │           │     is called or the budget
          └──────┬───────┘    results     └───────────┘     is spent
                 │ stopped without submitting             │ submitted
                 ▼                                         ▼
              nudge ──▶ call_model (once), then end      verify ──▶ end
                                                   (a fresh check of each finding)

LangGraph owns the control flow — the nodes, the edges between them, and the state that
flows along them. Each node is a plain function: `call_model` calls the model through the
official `anthropic` SDK, `run_tools` runs the repository tools. Nothing here knows about
HTTP or FastAPI; `run()` takes a request and returns a result.

The model is Claude, or a local model served by Ollama — which speaks the same Messages
API, so the same client and the same loop drive both. Claude's own features are sent only
to Claude: Ollama accepts them and silently ignores them, which would make a request look
like it had guarantees (a strict tool, a cache) that it doesn't.
"""

import logging
from dataclasses import dataclass, field
from typing import Any, Literal, TypedDict

from langgraph.graph import END, START, StateGraph

from ..models import DroppedFinding, ProposedFinding, ReviewRequest, Usage
from ..repo.tools import RepoTools
from .prompt import SYSTEM_PROMPT, render_request
from .submit import SUBMIT_REVIEW, SUBMIT_REVIEW_TOOL, parse_submission
from .verify import (
    VERDICT_TOOL,
    VERIFY_SYSTEM_PROMPT,
    VerifyContext,
    context_for,
    parse_verdict,
    render_verification,
    verified,
)

logger = logging.getLogger("pr_agent.agent")

# Refusal fallbacks: if a safety classifier declines the request, the API re-runs it on the
# recommended model for that refusal category, inside the same call.
FALLBACK_BETA = "server-side-fallback-2026-07-01"

Outcome = Literal["submitted", "refused", "budget", "no-submission", "truncated"]

# Stop exploring once the conversation fills this much of a limited context window: the
# next tool results and the submission still have to fit in what is left.
CONTEXT_HEADROOM = 0.75


@dataclass(frozen=True)
class AgentConfig:
    model: str = "claude-opus-5"
    effort: str = "high"
    max_turns: int = 20
    max_tool_calls: int = 40
    max_tokens: int = 16_000
    # Adaptive thinking, effort, prompt caching, refusal fallbacks and strict tools.
    claude: bool = True
    # The model's context window when it is small enough to run out mid-review, else None.
    context_tokens: int | None = None
    # The second look (verify.py): whether it runs, how many findings it checks per review,
    # and the output cap for one verdict — room for Claude's thinking, little for a local model.
    verify: bool = True
    max_verifications: int = 15
    verify_max_tokens: int = 8_000


DEFAULT_CONFIG = AgentConfig()

# A local model through Ollama: none of Claude's features, a 32k window, and a smaller
# output cap — a submission is a few thousand tokens at most.
LOCAL_CONFIG = AgentConfig(
    model="pr-reviewer:qwen2.5-7b",
    claude=False,
    max_tokens=4_096,
    context_tokens=32_768,
    verify_max_tokens=1_024,
)


@dataclass
class AgentResult:
    findings: list[ProposedFinding]
    outcome: Outcome
    model: str
    usage: Usage
    turns: int
    tool_calls: int
    tools_used: list[str] = field(default_factory=list)
    dropped: list[DroppedFinding] = field(default_factory=list)
    verify_calls: int = 0


class ReviewState(TypedDict):
    messages: list[dict[str, Any]]
    pending: list[Any]  # tool_use blocks from the latest response
    findings: list[ProposedFinding] | None
    outcome: Outcome | None
    model: str
    usage: Usage
    turns: int
    tool_calls: int
    tools_used: list[str]
    nudged: bool
    context_used: int  # tokens in the conversation as of the latest response
    final_turn: bool  # the model has been told to submit now
    dropped: list[DroppedFinding]  # refuted by the second look
    verify_calls: int


class ReviewAgent:
    def __init__(self, client: Any, tools: RepoTools, config: AgentConfig = DEFAULT_CONFIG):
        self.client = client
        self.tools = tools
        self.config = config
        # Built once, in a fixed order, so the tool list is byte-identical on every turn —
        # it is part of the cached prefix.
        # Only Claude enforces `strict`; elsewhere the submission is checked by
        # parse_submission alone, and a bad one goes back to the model to correct.
        self.tool_definitions = [*tools.definitions(), for_model(SUBMIT_REVIEW_TOOL, config)]
        self.graph = self._build()

    def run(self, request: ReviewRequest) -> AgentResult:
        state: ReviewState = {
            "messages": [{"role": "user", "content": render_request(request)}],
            "pending": [],
            "findings": None,
            "outcome": None,
            "model": self.config.model,
            "usage": Usage(),
            "turns": 0,
            "tool_calls": 0,
            "tools_used": [],
            "nudged": False,
            "context_used": 0,
            "final_turn": False,
            "dropped": [],
            "verify_calls": 0,
        }
        # Every turn is up to three graph steps; leave room so LangGraph's own recursion
        # guard never fires before the agent's budget does.
        final = self.graph.invoke(state, {"recursion_limit": self.config.max_turns * 3 + 10})
        return AgentResult(
            findings=final["findings"] or [],
            outcome=final["outcome"] or "no-submission",
            model=final["model"],
            usage=final["usage"],
            turns=final["turns"],
            tool_calls=final["tool_calls"],
            tools_used=final["tools_used"],
            dropped=final["dropped"],
            verify_calls=final["verify_calls"],
        )

    # ---- graph ----

    def _build(self):
        graph = StateGraph(ReviewState)
        graph.add_node("call_model", self._call_model)
        graph.add_node("run_tools", self._run_tools)
        graph.add_node("nudge", self._nudge)
        graph.add_node("verify", self._verify)
        graph.add_edge(START, "call_model")
        graph.add_conditional_edges(
            "call_model", self._after_model, {"run_tools": "run_tools", "nudge": "nudge", END: END}
        )
        graph.add_conditional_edges(
            "run_tools",
            self._after_tools,
            {"call_model": "call_model", "verify": "verify", END: END},
        )
        graph.add_edge("nudge", "call_model")
        graph.add_edge("verify", END)
        return graph.compile()

    def _request(self, messages: list[dict[str, Any]]) -> dict[str, Any]:
        return build_request(
            self.config, messages, system=SYSTEM_PROMPT, tools=self.tool_definitions
        )

    def _call_model(self, state: ReviewState) -> dict[str, Any]:
        response = self.client.beta.messages.create(**self._request(state["messages"]))
        turns = state["turns"] + 1
        usage = _add_usage(state["usage"], response.usage)
        # Ollama can answer with null content; treat it as saying nothing.
        content = response.content or []
        pending = [block for block in content if block.type == "tool_use"]
        context_used = (
            response.usage.input_tokens
            + (response.usage.cache_read_input_tokens or 0)
            + (response.usage.cache_creation_input_tokens or 0)
            + response.usage.output_tokens
        )
        logger.info(
            "turn %d: stop=%s tools=%s in=%d cache_read=%d out=%d",
            turns,
            response.stop_reason,
            [block.name for block in pending],
            response.usage.input_tokens,
            response.usage.cache_read_input_tokens or 0,
            response.usage.output_tokens,
        )

        window = self.config.context_tokens
        if window and response.usage.input_tokens >= window * 0.95:
            # Ollama doesn't fail an over-long prompt: it drops the oldest messages, which
            # here are the system prompt and the diff. Near-full input is the only sign.
            logger.warning(
                "turn %d: %d input tokens in a %d-token window; the start of the conversation "
                "may have been cut",
                turns,
                response.usage.input_tokens,
                window,
            )

        if self.config.claude and turns > 1 and not response.usage.cache_read_input_tokens:
            # From the second turn on, the whole earlier conversation should come from the
            # cache. Zero means something in the prefix changed between turns — a volatile
            # value in the system prompt or the tools — and every turn is paying full price.
            logger.warning(
                "turn %d read nothing from the prompt cache; the prefix is being invalidated",
                turns,
            )

        update: dict[str, Any] = {
            # The full content goes back — thinking and fallback blocks included — never
            # just the text, or the next turn loses what the API needs to continue.
            "messages": [*state["messages"], {"role": "assistant", "content": content}],
            "pending": pending,
            "turns": turns,
            "usage": usage,
            "model": response.model,
            "context_used": context_used,
        }
        if response.stop_reason == "refusal":
            # The whole fallback chain declined. Checked before reading content, which may
            # not match any schema after a refusal.
            update["outcome"] = "refused"
        elif response.stop_reason == "max_tokens" and not pending:
            update["outcome"] = "truncated"
        return update

    def _after_model(self, state: ReviewState) -> str:
        if state["outcome"] in ("refused", "truncated"):
            return END
        if state["pending"]:
            return "run_tools"
        return END if state["nudged"] else "nudge"

    def _nudge(self, state: ReviewState) -> dict[str, Any]:
        """The model stopped without submitting. Ask once; the second time, give up."""
        reminder = {
            "role": "user",
            "content": f"You stopped without calling {SUBMIT_REVIEW}. Call it now with your "
            "findings, or with an empty list if there are none.",
        }
        return {"messages": [*state["messages"], reminder], "nudged": True}

    def _run_tools(self, state: ReviewState) -> dict[str, Any]:
        results: list[dict[str, Any]] = []
        tool_calls = state["tool_calls"]
        tools_used = list(state["tools_used"])
        findings: list[ProposedFinding] | None = None

        for block in state["pending"]:
            if block.name == SUBMIT_REVIEW:
                try:
                    findings = parse_submission(block.input)
                    results.append(_result(block.id, "Review submitted."))
                except ValueError as error:
                    results.append(_result(block.id, str(error), is_error=True))
                continue

            if tool_calls >= self.config.max_tool_calls:
                results.append(
                    _result(
                        block.id,
                        f"Tool budget spent. Call {SUBMIT_REVIEW} now with what you have found.",
                        is_error=True,
                    )
                )
                continue

            text, is_error = self.tools.call(block.name, block.input)
            tool_calls += 1
            tools_used.append(block.name)
            results.append(_result(block.id, text, is_error=is_error))

        if findings is not None:
            return {
                "findings": findings,
                "outcome": "submitted",
                "tool_calls": tool_calls,
                "tools_used": tools_used,
            }

        content: list[dict[str, Any]] = list(results)
        update: dict[str, Any] = {
            "messages": [*state["messages"], {"role": "user", "content": content}],
            "pending": [],
            "tool_calls": tool_calls,
            "tools_used": tools_used,
        }
        if state["final_turn"] or state["turns"] >= self.config.max_turns:
            # Told to submit and called tools instead, or out of turns: stop here.
            update["outcome"] = "budget"
        elif state["turns"] >= self.config.max_turns - 1:
            # One turn left: say so, after the tool results (they must come first).
            content.append(
                {"type": "text", "text": f"This is your last turn. Call {SUBMIT_REVIEW} now."}
            )
            update["final_turn"] = True
        elif self._context_nearly_full(state):
            content.append(
                {
                    "type": "text",
                    "text": f"Your context is nearly full. Stop exploring and call "
                    f"{SUBMIT_REVIEW} now with what you have found.",
                }
            )
            update["final_turn"] = True
        return update

    def _context_nearly_full(self, state: ReviewState) -> bool:
        window = self.config.context_tokens
        return window is not None and state["context_used"] >= window * CONTEXT_HEADROOM

    def _after_tools(self, state: ReviewState) -> str:
        if state["outcome"] == "submitted":
            return "verify" if self.config.verify and state["findings"] else END
        return END if state["outcome"] == "budget" else "call_model"

    def _verify(self, state: ReviewState) -> dict[str, Any]:
        """The second look: each finding checked on its own, in a fresh conversation.

        API errors are not caught here, as they are not for the review itself: a transient
        one fails the job and it is retried; the checker saying nothing useful is not an
        error, and leaves the finding unverified and demoted.
        """
        kept: list[ProposedFinding] = []
        dropped = list(state["dropped"])
        usage = state["usage"]
        calls = state["verify_calls"]

        for finding in state["findings"] or []:
            where = f"{finding.file}:{finding.line}"
            if calls >= self.config.max_verifications:
                kept.append(
                    verified(finding, "unverified", "Not checked: the verification budget ran out.")
                )
                continue

            answer, response = check_finding(
                self.client, self.config, finding, context_for(finding, self.tools)
            )
            calls += 1
            usage = _add_usage(usage, response.usage)

            if answer is None:
                logger.info("verify %s: no verdict (stop=%s)", where, response.stop_reason)
                kept.append(verified(finding, "unverified", "The checker gave no verdict."))
            elif answer[0] == "refuted":
                logger.info("verify %s: refuted — %s", where, answer[1])
                dropped.append(DroppedFinding(finding=finding, reason=answer[1]))
            else:
                logger.info("verify %s: %s — %s", where, answer[0], answer[1])
                kept.append(verified(finding, *answer))

        return {"findings": kept, "dropped": dropped, "usage": usage, "verify_calls": calls}


def for_model(tool: dict[str, Any], config: AgentConfig) -> dict[str, Any]:
    """A tool definition as this model takes it: `strict` is Claude's alone."""
    return tool if config.claude else {k: v for k, v in tool.items() if k != "strict"}


def build_request(
    config: AgentConfig,
    messages: list[dict[str, Any]],
    *,
    system: str,
    tools: list[dict[str, Any]],
    max_tokens: int | None = None,
) -> dict[str, Any]:
    """The Messages API request for this model — Claude's own features only for Claude."""
    request: dict[str, Any] = {
        "model": config.model,
        "max_tokens": max_tokens or config.max_tokens,
        "system": system,
        "tools": tools,
        "messages": messages,
    }
    if config.claude:
        request |= {
            "thinking": {"type": "adaptive"},
            "output_config": {"effort": config.effort},
            # Automatic caching: the whole prefix up to the last block is cached each
            # turn, so turn N+1 reads turns 1..N from cache instead of paying again.
            "cache_control": {"type": "ephemeral"},
            "betas": [FALLBACK_BETA],
            "fallbacks": "default",
        }
    return request


def check_finding(
    client: Any, config: AgentConfig, finding: ProposedFinding, context: VerifyContext
) -> tuple[tuple[str, str] | None, Any]:
    """One verdict on one finding, in a conversation of its own.

    Returns ((verdict, reason) or None when there is no usable verdict, the raw response).
    The verify node uses it for every finding; scripts/verify_eval.py uses it to measure the
    checker on findings whose truth is known — so both run exactly the same call.
    """
    response = client.beta.messages.create(
        **build_request(
            config,
            [{"role": "user", "content": render_verification(finding, context)}],
            system=VERIFY_SYSTEM_PROMPT,
            tools=[for_model(VERDICT_TOOL, config)],
            max_tokens=config.verify_max_tokens,
        )
    )
    return parse_verdict(response), response


def _result(tool_use_id: str, content: str, *, is_error: bool = False) -> dict[str, Any]:
    block: dict[str, Any] = {"type": "tool_result", "tool_use_id": tool_use_id, "content": content}
    if is_error:
        block["is_error"] = True
    return block


def _add_usage(total: Usage, usage: Any) -> Usage:
    return Usage(
        input_tokens=total.input_tokens + (usage.input_tokens or 0),
        output_tokens=total.output_tokens + (usage.output_tokens or 0),
        cache_read_input_tokens=total.cache_read_input_tokens
        + (usage.cache_read_input_tokens or 0),
        cache_creation_input_tokens=total.cache_creation_input_tokens
        + (usage.cache_creation_input_tokens or 0),
    )
