"""`python -m pr_agent` — run the service.

Binds to localhost by default: only the API should reach it. AGENT_HOST=0.0.0.0 in a container,
where the API reaches it over a private network. Read here, not in config.py, which the eval
gate hashes: where the service listens can't change a review.
"""

import logging
import os

import uvicorn

from .config import get_settings


def main() -> None:
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s [%(name)s] %(message)s"
    )
    uvicorn.run(
        "pr_agent.main:app",
        host=os.environ.get("AGENT_HOST", "127.0.0.1"),
        port=get_settings().agent_port,
    )


if __name__ == "__main__":
    main()
