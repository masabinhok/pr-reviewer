"""Replay one pull request through the real agent, offline.

Takes a request dumped by the API (`DUMP_REQUEST=pr6.json npm run try:review <repo> <pr>`)
and a local checkout of that repository at the head commit, and runs the real ReviewAgent
over them: the same graph, prompt, tools and model, with no GitHub and no Nest in the loop.
Findings are printed as the model proposed them — before the API validates or filters them.

Two arguments make it a measuring tool rather than a demo: a `|`-separated list of
substrings whose diff lines are dropped before the model sees them (used to measure what a
prompt injection planted in the diff does to the review), and a number of runs, because a
small model's output varies enough that one run says little.

Usage: uv run python scripts/replay.py <request.json> <checkout> ["strip|strip"] [runs]
"""

import json
import os
import sys
import time
from dataclasses import replace
from pathlib import Path

import anthropic

from pr_agent.agent.graph import LOCAL_CONFIG, ReviewAgent
from pr_agent.models import ReviewRequest
from pr_agent.repo.tools import RepoTools

request_path, repo_root = sys.argv[1], Path(sys.argv[2])
strip = sys.argv[3] if len(sys.argv) > 3 else None
runs = int(sys.argv[4]) if len(sys.argv) > 4 else 1

raw = json.loads(Path(request_path).read_text())
raw["installationToken"] = "ghs_offline_placeholder"
if strip:
    for f in raw["files"]:
        for h in f["hunks"]:
            parts = strip.split("|")
            h["lines"] = [ln for ln in h["lines"] if not any(x in ln["content"] for x in parts)]
request = ReviewRequest.model_validate(raw)

# AGENT_MODEL picks the model, as it does for the service, so models can be compared here.
config = replace(LOCAL_CONFIG, model=os.environ.get("AGENT_MODEL", LOCAL_CONFIG.model))
url = os.environ.get("OLLAMA_URL", "http://localhost:11434")
client = anthropic.Anthropic(base_url=url, api_key="ollama", max_retries=1)
print(f"{config.model} on {url}")
for i in range(runs):
    started = time.time()
    result = ReviewAgent(client, RepoTools(repo_root, request), config).run(request)
    print(
        f"run {i + 1}: {result.outcome} in {time.time() - started:.0f}s, {result.turns} turns, "
        f"{result.tool_calls} tool calls, {len(result.findings)} finding(s)"
    )
    for f in result.findings:
        print(f"  {f.severity:6} {f.file}:{f.line} {f.side}  {f.summary}")
