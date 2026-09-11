import pytest
from pydantic import ValidationError

from pr_agent.config import Settings


def test_refuses_to_start_without_a_shared_secret(monkeypatch):
    # An unauthenticated endpoint that spends money must not come up by accident.
    monkeypatch.delenv("AGENT_SHARED_SECRET", raising=False)

    with pytest.raises(ValidationError, match="agent_shared_secret"):
        Settings(_env_file=None)


def test_reads_the_secret_without_exposing_it(monkeypatch):
    monkeypatch.setenv("AGENT_SHARED_SECRET", "s3cret")

    settings = Settings(_env_file=None)

    assert settings.agent_shared_secret.get_secret_value() == "s3cret"
    assert "s3cret" not in repr(settings)
