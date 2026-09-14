from pr_agent.config import Settings, get_settings
from pr_agent.main import app
from pr_agent.models import ProposedFinding, ReviewRequest, ReviewResponse, Usage

from .conftest import SECRET


def test_healthz(client):
    assert client.get("/healthz").json() == {"status": "ok"}


def test_answers_503_when_claude_is_chosen_without_a_key(client, review_request, auth):
    app.dependency_overrides[get_settings] = lambda: Settings(
        _env_file=None, agent_shared_secret=SECRET, agent_provider="anthropic"
    )

    response = client.post("/reviews", json=review_request, headers=auth)

    assert response.status_code == 503
    assert "ANTHROPIC_API_KEY" in response.json()["detail"]


def test_parses_the_real_request_into_python_names(review_request):
    parsed = ReviewRequest.model_validate(review_request)

    assert parsed.pr_number == 3
    assert [f.path for f in parsed.files] == ["src/auth.ts", "src/helpers.ts", "src/new-feature.ts"]
    first_add = next(line for line in parsed.files[0].hunks[0].lines if line.kind == "add")
    assert first_add.new_line == 8


def test_rejects_a_request_with_an_unknown_field(client, review_request, auth):
    # A field the agent doesn't know means the two sides have drifted apart — say so
    # loudly instead of reviewing with half the information.
    review_request["files"][0]["surprise"] = True

    assert client.post("/reviews", json=review_request, headers=auth).status_code == 422


def test_rejects_a_malformed_sha(client, review_request, auth):
    review_request["headSha"] = "not-a-sha"

    assert client.post("/reviews", json=review_request, headers=auth).status_code == 422


def test_never_echoes_the_installation_token_in_a_validation_error(client, review_request, auth):
    review_request["installationToken"] = "ghs_do_not_leak_me"
    review_request["prNumber"] = -1  # make validation fail

    response = client.post("/reviews", json=review_request, headers=auth)

    assert response.status_code == 422
    assert "ghs_do_not_leak_me" not in response.text


def test_token_is_hidden_from_repr(review_request):
    parsed = ReviewRequest.model_validate(review_request)

    assert "ghs_placeholder_for_tests" not in repr(parsed)
    assert parsed.installation_token.get_secret_value() == "ghs_placeholder_for_tests"


def test_findings_serialise_in_the_api_s_field_names():
    finding = ProposedFinding(
        file="src/auth.ts",
        line=26,
        side="RIGHT",
        severity="low",
        category="debugging",
        summary="console.log left in",
        why_it_breaks="writes to stdout in production",
    )
    body = ReviewResponse(findings=[finding], model="m", usage=Usage()).model_dump(by_alias=True)

    assert body["findings"][0] == {
        "file": "src/auth.ts",
        "line": 26,
        "side": "RIGHT",
        "severity": "low",
        "category": "debugging",
        "summary": "console.log left in",
        "whyItBreaks": "writes to stdout in production",
        "suggestedFix": None,
        "verification": None,
    }
