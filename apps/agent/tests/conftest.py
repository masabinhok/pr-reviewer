import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from pr_agent.config import Settings, get_settings
from pr_agent.main import app

FIXTURES = Path(__file__).parent / "fixtures"
SECRET = "test-agent-secret"


@pytest.fixture
def client() -> TestClient:
    # Settings come from a known value, never from whatever .env holds.
    app.dependency_overrides[get_settings] = lambda: Settings(agent_shared_secret=SECRET)
    yield TestClient(app)
    app.dependency_overrides.clear()


@pytest.fixture
def review_request() -> dict:
    """A real request: the testbed's diff-shapes PR, parsed and filtered by the API's own code."""
    return json.loads((FIXTURES / "review-request.json").read_text())


@pytest.fixture
def auth() -> dict[str, str]:
    return {"X-Agent-Secret": SECRET}
