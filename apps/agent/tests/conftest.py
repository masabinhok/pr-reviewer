import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from pr_agent.config import Settings, get_settings
from pr_agent.main import app

# The API <-> agent contract, shared by both test suites: the API generates the request
# fixture from its real AgentReviewer, the agent generates the response fixture from its
# models, and each side tests the other's file. See contracts/README.md.
CONTRACTS = Path(__file__).resolve().parents[3] / "contracts"
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
    return json.loads((CONTRACTS / "review-request.json").read_text())


@pytest.fixture
def auth() -> dict[str, str]:
    return {"X-Agent-Secret": SECRET}
