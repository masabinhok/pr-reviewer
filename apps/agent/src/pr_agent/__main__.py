"""`python -m pr_agent` — run the service. Binds to localhost: only the API should reach it."""

import logging

import uvicorn

from .config import get_settings


def main() -> None:
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s [%(name)s] %(message)s"
    )
    uvicorn.run("pr_agent.main:app", host="127.0.0.1", port=get_settings().agent_port)


if __name__ == "__main__":
    main()
