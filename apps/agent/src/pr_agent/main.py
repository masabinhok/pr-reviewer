"""The agent's HTTP surface: a health check, and one endpoint that reviews a pull request.

Status codes tell the caller whether to retry:
- 200: reviewed (the body's `outcome` says how the agent finished)
- 401: wrong or missing shared secret
- 422: the request is invalid, or the repository can't be reviewed — retrying won't help
- 503: something transient (GitHub, the Anthropic API, no API key configured) — retry later
"""

import hmac
import logging
from collections.abc import Callable
from typing import Annotated, Any

import anthropic
import httpx2
from fastapi import Depends, FastAPI, Header, HTTPException, status

from .agent.graph import AgentConfig, ReviewAgent
from .agent.pricing import cost_usd
from .config import Settings, get_settings
from .models import ReviewRequest, ReviewResponse
from .repo.snapshot import SnapshotError, snapshot
from .repo.tools import RepoTools

logger = logging.getLogger("pr_agent")

app = FastAPI(title="pr-reviewer agent", docs_url=None, redoc_url=None)


def require_secret(
    settings: Annotated[Settings, Depends(get_settings)],
    x_agent_secret: Annotated[str | None, Header()] = None,
) -> None:
    expected = settings.agent_shared_secret.get_secret_value()
    # Constant-time, like the API's webhook signature check.
    if x_agent_secret is None or not hmac.compare_digest(
        x_agent_secret.encode(), expected.encode()
    ):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="missing or wrong X-Agent-Secret"
        )


ClientFactory = Callable[[Settings], Any]


def anthropic_client(settings: Settings) -> Any:
    if settings.anthropic_api_key is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="ANTHROPIC_API_KEY is not configured on the agent",
        )
    return anthropic.Anthropic(api_key=settings.anthropic_api_key.get_secret_value(), max_retries=3)


def get_client_factory() -> ClientFactory:
    return anthropic_client


def get_http_client() -> httpx2.Client:
    return httpx2.Client(timeout=60)


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/reviews", dependencies=[Depends(require_secret)], response_model_by_alias=True)
def review(
    request: ReviewRequest,
    settings: Annotated[Settings, Depends(get_settings)],
    make_client: Annotated[ClientFactory, Depends(get_client_factory)],
    http: Annotated[httpx2.Client, Depends(get_http_client)],
) -> ReviewResponse:
    client = make_client(settings)
    config = AgentConfig(
        model=settings.agent_model,
        effort=settings.agent_effort,
        max_turns=settings.agent_max_turns,
        max_tool_calls=settings.agent_max_tool_calls,
    )
    where = f"{request.repo}#{request.pr_number}@{request.head_sha[:7]}"
    token = request.installation_token.get_secret_value()

    try:
        with http, snapshot(http, request.repo, request.head_sha, token) as snap:
            result = ReviewAgent(client, RepoTools(snap.root, request), config).run(request)
    except SnapshotError as error:
        logger.warning("review %s: snapshot failed: %s", where, error)
        raise HTTPException(
            status_code=503 if error.retryable else 422, detail=f"repository snapshot: {error}"
        ) from error
    except (
        anthropic.RateLimitError,
        anthropic.APIConnectionError,
        anthropic.InternalServerError,
    ) as error:
        logger.warning("review %s: Anthropic API unavailable: %s", where, type(error).__name__)
        raise HTTPException(
            status_code=503, detail="Anthropic API unavailable, retry later"
        ) from error
    except anthropic.APIStatusError as error:
        # A 4xx from the Anthropic API means this request, as built, is wrong — a bug here,
        # not something a retry fixes. The request ID is what Anthropic support asks for.
        logger.error(
            "review %s: Anthropic API refused the request: %s %s",
            where,
            error.status_code,
            error.request_id,
        )
        raise HTTPException(status_code=422, detail=f"Anthropic API {error.status_code}") from error

    usage = result.usage.model_copy(update={"cost_usd": cost_usd(result.model, result.usage)})
    logger.info(
        "review %s: %s after %d turn(s), %d tool call(s), %d finding(s), $%.4f",
        where,
        result.outcome,
        result.turns,
        result.tool_calls,
        len(result.findings),
        usage.cost_usd or 0,
    )
    return ReviewResponse(
        findings=result.findings,
        model=result.model,
        usage=usage,
        outcome=result.outcome,
        turns=result.turns,
        tool_calls=result.tool_calls,
    )
