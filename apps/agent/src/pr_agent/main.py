"""The agent's HTTP surface: a health check, and one endpoint that reviews a pull request."""

import hmac
import logging
from typing import Annotated

from fastapi import Depends, FastAPI, Header, HTTPException, status

from .config import Settings, get_settings
from .models import ReviewRequest, ReviewResponse, Usage

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


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/reviews", dependencies=[Depends(require_secret)], response_model_by_alias=True)
def review(request: ReviewRequest) -> ReviewResponse:
    """Placeholder until milestone 18: accepts the contract, returns no findings."""
    lines = sum(len(h.lines) for f in request.files for h in f.hunks)
    logger.info(
        "review %s#%s at %s: %d file(s), %d diff line(s)",
        request.repo,
        request.pr_number,
        request.head_sha[:7],
        len(request.files),
        lines,
    )
    return ReviewResponse(findings=[], model="none", usage=Usage())
