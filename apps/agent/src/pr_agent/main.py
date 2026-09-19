"""The agent's HTTP surface: a health check, and one endpoint that reviews a pull request.

Status codes tell the caller whether to retry:
- 200: reviewed (the body's `outcome` says how the agent finished)
- 401: wrong or missing shared secret
- 422: the request is invalid, the repository can't be reviewed, or the model refused the
  request as built (e.g. the local model isn't installed) — retrying won't help
- 503: something transient (GitHub, Ollama or the Anthropic API down, no API key
  configured for Claude) — retry later
"""

import hmac
import logging
from collections.abc import Callable
from dataclasses import replace
from typing import Annotated, Any

import anthropic
import httpx2
from fastapi import Depends, FastAPI, Header, HTTPException, status

from .agent.graph import DEFAULT_CONFIG, LOCAL_CONFIG, AgentConfig, ReviewAgent
from .agent.pricing import cost_usd
from .config import Settings, get_settings
from .models import ReviewRequest, ReviewResponse
from .repo.snapshot import SnapshotError, snapshot
from .repo.tools import RepoTools

logger = logging.getLogger("pr_agent")

# httpx2 logs every request's full URL at INFO. GitHub redirects a tarball download to
# codeload with a short-lived `token=` in the query string, so at INFO that token would be
# written to the log. WARNING and above carry no URLs.
logging.getLogger("httpx2").setLevel(logging.WARNING)

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

PROVIDER_NAMES = {"ollama": "Ollama", "anthropic": "Anthropic API"}


def model_client(settings: Settings) -> Any:
    """The SDK client for the configured provider. Ollama serves the same Messages API."""
    if settings.agent_provider == "anthropic":
        if settings.anthropic_api_key is None:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="AGENT_PROVIDER is anthropic but ANTHROPIC_API_KEY is not set",
            )
        return anthropic.Anthropic(
            api_key=settings.anthropic_api_key.get_secret_value(), max_retries=3
        )
    # Ollama needs no key; the SDK insists on sending one, and Ollama ignores it. Passing
    # both explicitly keeps the SDK from picking up ANTHROPIC_* from the environment.
    return anthropic.Anthropic(base_url=settings.ollama_url, api_key="ollama", max_retries=1)


def get_client_factory() -> ClientFactory:
    return model_client


def agent_config(settings: Settings) -> AgentConfig:
    base = LOCAL_CONFIG if settings.agent_provider == "ollama" else DEFAULT_CONFIG
    return replace(
        base,
        model=settings.model,
        effort=settings.agent_effort,
        max_turns=settings.agent_max_turns,
        max_tool_calls=settings.agent_max_tool_calls,
        context_tokens=settings.context_tokens,
        verify=settings.agent_verify,
        max_verifications=settings.agent_max_verifications,
    )


def _error_message(error: anthropic.APIStatusError) -> str:
    """The message in an Anthropic-shaped error body, which Ollama's errors follow too."""
    body = error.body
    if isinstance(body, dict) and isinstance(body.get("error"), dict):
        return str(body["error"].get("message", ""))
    return ""


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
    config = agent_config(settings)
    provider = PROVIDER_NAMES[settings.agent_provider]
    where = f"{request.repo}#{request.pr_number}@{request.head_sha[:7]}"
    secret = request.installation_token
    token = secret.get_secret_value() if secret is not None else None

    try:
        with (
            http,
            snapshot(
                http, request.repo, request.head_sha, token, settings.agent_tarball_cache
            ) as snap,
        ):
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
        logger.warning("review %s: %s unavailable: %s", where, provider, type(error).__name__)
        raise HTTPException(
            status_code=503, detail=f"{provider} unavailable, retry later"
        ) from error
    except anthropic.APIStatusError as error:
        # A 4xx means this request, as built, is wrong — a bug here, or a local model that
        # isn't installed — not something a retry fixes. The request ID is what Anthropic
        # support asks for.
        message = _error_message(error)
        logger.error(
            "review %s: %s refused the request: %s %s %s",
            where,
            provider,
            error.status_code,
            error.request_id,
            message,
        )
        detail = f"{provider} {error.status_code}: {message}".rstrip(": ")
        if settings.agent_provider == "ollama" and error.status_code == 404:
            detail += " — build it with `npm run agent:model`"
        raise HTTPException(status_code=422, detail=detail) from error

    # A local model costs nothing per review; Claude is priced from the published rates.
    cost = 0.0 if settings.agent_provider == "ollama" else cost_usd(result.model, result.usage)
    usage = result.usage.model_copy(update={"cost_usd": cost})
    logger.info(
        "review %s: %s after %d turn(s), %d tool call(s), %d finding(s) kept, %d dropped on a "
        "second look (%d check(s)), $%.4f",
        where,
        result.outcome,
        result.turns,
        result.tool_calls,
        len(result.findings),
        len(result.dropped),
        result.verify_calls,
        usage.cost_usd or 0,
    )
    return ReviewResponse(
        findings=result.findings,
        model=result.model,
        usage=usage,
        outcome=result.outcome,
        turns=result.turns,
        tool_calls=result.tool_calls,
        dropped=result.dropped,
        verify_calls=result.verify_calls,
    )
