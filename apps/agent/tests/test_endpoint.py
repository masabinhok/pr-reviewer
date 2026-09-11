"""POST /reviews end to end inside the agent: the real snapshot, tools and graph, with
GitHub replaced by an httpx2 mock transport and Claude by the scripted fake."""

import httpx2
import pytest

from pr_agent.config import Settings, get_settings
from pr_agent.main import app, get_client_factory, get_http_client

from .fake_claude import FakeClaude, finding, message, tool_use
from .test_snapshot import tarball

SECRET = "test-agent-secret"


@pytest.fixture
def serve(review_request):
    """Wires the app to a fake GitHub and a scripted Claude; returns a function to call it."""
    github_calls: list[str] = []

    def github(request: httpx2.Request) -> httpx2.Response:
        github_calls.append(str(request.url))
        return httpx2.Response(
            200,
            content=tarball(
                {"src/auth.ts": "export function verify() {\n  console.log('x');\n}\n"}
            ),
        )

    def call(claude: FakeClaude, github_handler=github):
        app.dependency_overrides[get_settings] = lambda: Settings(
            _env_file=None, agent_shared_secret=SECRET, anthropic_api_key="sk-test"
        )
        app.dependency_overrides[get_client_factory] = lambda: lambda _settings: claude
        app.dependency_overrides[get_http_client] = lambda: httpx2.Client(
            transport=httpx2.MockTransport(github_handler)
        )
        from fastapi.testclient import TestClient

        return TestClient(app).post(
            "/reviews", json=review_request, headers={"X-Agent-Secret": SECRET}
        )

    yield call, github_calls
    app.dependency_overrides.clear()


def test_reviews_and_answers_in_the_contract_shape(serve):
    call, github_calls = serve
    claude = FakeClaude(
        message(tool_use("get_file", path="src/auth.ts"), cache_write=3000),
        message(tool_use("submit_review", findings=[finding()]), cache_read=3000),
    )

    response = call(claude)

    assert response.status_code == 200
    body = response.json()
    assert body["outcome"] == "submitted"
    assert body["model"] == "claude-opus-5"
    assert (body["turns"], body["toolCalls"]) == (2, 1)
    assert body["findings"] == [
        {
            "file": "src/auth.ts",
            "line": 26,
            "side": "RIGHT",
            "severity": "low",
            "category": "debugging",
            "summary": "console.log is left in.",
            "whyItBreaks": "Every call to verify() writes the token being verified to stdout.",
            "suggestedFix": None,
        }
    ]
    assert body["usage"]["cacheReadInputTokens"] == 3000
    assert body["usage"]["costUsd"] > 0
    assert github_calls[0].endswith("/tarball/6ac523cfcd000061512a81ba4f9676e09e573ae3")


def test_a_refusal_is_a_200_with_no_findings(serve):
    call, _ = serve

    body = call(FakeClaude(message({"type": "text", "text": ""}, stop_reason="refusal"))).json()

    assert (body["outcome"], body["findings"]) == ("refused", [])


@pytest.mark.parametrize(
    ("status", "expected"),
    [(502, 503), (404, 422)],
    ids=["github-down-is-retryable", "github-refused-is-not"],
)
def test_tells_the_caller_whether_a_snapshot_failure_is_worth_retrying(serve, status, expected):
    call, _ = serve

    response = call(FakeClaude(), lambda _request: httpx2.Response(status))

    assert response.status_code == expected
    assert "ghs_" not in response.text


# Found on the first live run: httpx2 logged the codeload redirect URL, which carries a
# short-lived download token in its query string.
def test_never_logs_the_download_token_in_githubs_redirect(serve, caplog):
    import logging

    call, _ = serve
    caplog.set_level(logging.DEBUG)
    body = tarball({"a.ts": "x"})

    def github(request: httpx2.Request) -> httpx2.Response:
        if request.url.host == "api.github.com":
            return httpx2.Response(
                302,
                headers={"location": "https://codeload.github.com/x.tar.gz?token=CODELOADSECRET"},
            )
        return httpx2.Response(200, content=body)

    call(FakeClaude(message(tool_use("submit_review", findings=[]))), github)

    assert "CODELOADSECRET" not in caplog.text
    assert "ghs_" not in caplog.text
