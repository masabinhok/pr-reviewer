import pytest


@pytest.mark.parametrize(
    "headers",
    [{}, {"X-Agent-Secret": "wrong"}, {"X-Agent-Secret": ""}],
    ids=["missing", "wrong", "empty"],
)
def test_rejects_a_request_without_the_shared_secret(client, review_request, headers):
    assert client.post("/reviews", json=review_request, headers=headers).status_code == 401


def test_health_needs_no_secret(client):
    assert client.get("/healthz").status_code == 200
