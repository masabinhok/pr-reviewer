"""Settings, read from the repository's root `.env` — the same file the API reads."""

from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict

# apps/agent/src/pr_agent/config.py -> repository root
ROOT_ENV = Path(__file__).resolve().parents[4] / ".env"

Provider = Literal["ollama", "anthropic"]

# The model each provider uses unless AGENT_MODEL says otherwise. The local one is the
# variant built from apps/agent/ollama/Modelfile (`npm run agent:model`): qwen2.5 7B with a
# context window big enough for a review.
DEFAULT_MODELS: dict[Provider, str] = {
    "ollama": "pr-reviewer:qwen2.5-7b",
    "anthropic": "claude-opus-5",
}

# The local model's context window — `num_ctx` in the Modelfile. Keep the two in step.
DEFAULT_LOCAL_CONTEXT_TOKENS = 32_768


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=ROOT_ENV, extra="ignore")

    # Nest sends this on every request. The endpoint can spend money on every call, so it
    # is authenticated even on localhost. Required: the service refuses to start without it.
    agent_shared_secret: SecretStr

    agent_port: int = 8000

    # Free by default: a local model through Ollama. Claude is bring-your-own-key, and must
    # be chosen here — an ANTHROPIC_API_KEY that happens to be in the environment never
    # switches the agent to a paid API by itself.
    agent_provider: Provider = "ollama"
    ollama_url: str = "http://localhost:11434"
    # Only read when the provider is anthropic; /reviews answers 503 until it is set.
    anthropic_api_key: SecretStr | None = None

    agent_model: str | None = None
    agent_effort: str = "high"  # Claude only
    agent_max_turns: int = 20
    agent_max_tool_calls: int = 40
    # The second look at each finding before it is returned (agent/verify.py). On by default:
    # dogfooding showed the reviewer's confident findings are often wrong.
    agent_verify: bool = True
    agent_max_verifications: int = 15
    # How much conversation the model can hold. Unset for Claude, whose window is far larger
    # than a review needs; set for a local model, which runs out mid-review.
    agent_context_tokens: int | None = None
    # Where public repositories' tarballs are kept between reviews (the evaluation reviews
    # the same commits run after run). Unset: nothing is cached. Private code never is.
    agent_tarball_cache: Path | None = None

    @property
    def model(self) -> str:
        return self.agent_model or DEFAULT_MODELS[self.agent_provider]

    @property
    def context_tokens(self) -> int | None:
        if self.agent_context_tokens is not None:
            return self.agent_context_tokens
        return DEFAULT_LOCAL_CONTEXT_TOKENS if self.agent_provider == "ollama" else None


@lru_cache
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]  # values come from the environment
