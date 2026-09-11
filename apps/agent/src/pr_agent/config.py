"""Settings, read from the repository's root `.env` — the same file the API reads."""

from functools import lru_cache
from pathlib import Path

from pydantic import SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict

# apps/agent/src/pr_agent/config.py -> repository root
ROOT_ENV = Path(__file__).resolve().parents[4] / ".env"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=ROOT_ENV, extra="ignore")

    # Nest sends this on every request. The endpoint spends money on every call, so it is
    # authenticated even on localhost. Required: the service refuses to start without it.
    agent_shared_secret: SecretStr

    agent_port: int = 8000


@lru_cache
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]  # values come from the environment
