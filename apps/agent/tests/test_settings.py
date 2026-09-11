from pathlib import Path

import pytest
from pydantic import ValidationError

from pr_agent.config import DEFAULT_LOCAL_CONTEXT_TOKENS, DEFAULT_MODELS, Settings

ROOT_PACKAGE = Path(__file__).resolve().parents[3] / "package.json"


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


def test_is_free_by_default_a_local_model_with_a_bounded_context(monkeypatch):
    monkeypatch.setenv("AGENT_SHARED_SECRET", "s")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-in-the-environment")

    settings = Settings(_env_file=None)

    assert settings.agent_provider == "ollama"
    assert settings.model == "pr-reviewer:qwen2.5-7b"
    assert settings.context_tokens == 32_768


def test_claude_is_chosen_explicitly_and_has_no_context_cap(monkeypatch):
    monkeypatch.setenv("AGENT_SHARED_SECRET", "s")
    monkeypatch.setenv("AGENT_PROVIDER", "anthropic")

    settings = Settings(_env_file=None)

    assert settings.model == "claude-opus-5"
    assert settings.context_tokens is None


def test_the_model_and_its_window_can_be_overridden(monkeypatch):
    monkeypatch.setenv("AGENT_SHARED_SECRET", "s")
    monkeypatch.setenv("AGENT_MODEL", "qwen2.5-coder:7b")
    monkeypatch.setenv("AGENT_CONTEXT_TOKENS", "16384")

    settings = Settings(_env_file=None)

    assert (settings.model, settings.context_tokens) == ("qwen2.5-coder:7b", 16_384)


def test_the_local_default_window_matches_the_modelfile():
    modelfile = (Path(__file__).resolve().parents[1] / "ollama" / "Modelfile").read_text()

    assert f"PARAMETER num_ctx {DEFAULT_LOCAL_CONTEXT_TOKENS}" in modelfile
    assert f"ollama create {DEFAULT_MODELS['ollama']} " in ROOT_PACKAGE.read_text()
