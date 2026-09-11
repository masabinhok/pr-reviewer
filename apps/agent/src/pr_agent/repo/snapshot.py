"""The repository at the PR's head commit, on local disk, for the agent's tools to read.

One tarball download per review, instead of one GitHub API call per file the agent wants:
no rate limit to spend, no network in the middle of the agent's loop, and every read is of
exactly the commit under review — never `main`, never a newer push.
"""

import io
import shutil
import tarfile
import tempfile
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path

import httpx2

GITHUB_API = "https://api.github.com"

# Caps against a repository — or a tarball — that would fill the disk.
MAX_TARBALL_BYTES = 50 * 1024 * 1024
MAX_EXTRACTED_BYTES = 200 * 1024 * 1024
MAX_MEMBERS = 50_000


class SnapshotError(Exception):
    """The snapshot could not be taken. `retryable` says whether trying again could help:
    GitHub being down could clear up; a repository over the size cap never will."""

    def __init__(self, message: str, *, retryable: bool = False):
        super().__init__(message)
        self.retryable = retryable


@dataclass(frozen=True)
class Snapshot:
    root: Path
    repo: str
    sha: str


def download_tarball(client: httpx2.Client, repo: str, sha: str, token: str) -> bytes:
    """The tarball of `repo` at `sha`, capped at MAX_TARBALL_BYTES while it streams."""
    url = f"{GITHUB_API}/repos/{repo}/tarball/{sha}"
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "pr-reviewer-agent",
    }
    # GitHub answers with a redirect to codeload; follow it.
    try:
        with client.stream("GET", url, headers=headers, follow_redirects=True) as response:
            if response.status_code != 200:
                # Never include the request: it carries the token.
                raise SnapshotError(
                    f"GitHub {response.status_code} downloading {repo}@{sha[:7]}",
                    retryable=response.status_code >= 500 or response.status_code == 429,
                )
            buffer = io.BytesIO()
            for chunk in response.iter_bytes():
                buffer.write(chunk)
                if buffer.tell() > MAX_TARBALL_BYTES:
                    raise SnapshotError(
                        f"{repo} is over {MAX_TARBALL_BYTES // 2**20} MB compressed"
                    )
            return buffer.getvalue()
    except httpx2.TransportError as error:
        raise SnapshotError(
            f"network error downloading {repo}@{sha[:7]}: {type(error).__name__}", retryable=True
        ) from error


def extract(tarball: bytes, into: Path) -> Path:
    """Extracts safely and returns the repository root inside `into`.

    The `data` filter (PEP 706) is the defence against hostile archives: it refuses absolute
    paths, `..` components, links that point outside `into`, and device files. On top of it,
    caps on the member count and the total size stop an archive that is legal but huge.
    """
    with tarfile.open(fileobj=io.BytesIO(tarball), mode="r:gz") as archive:
        members = archive.getmembers()
        if len(members) > MAX_MEMBERS:
            raise SnapshotError(f"archive has {len(members)} entries, over {MAX_MEMBERS}")
        total = sum(m.size for m in members if m.isfile())
        if total > MAX_EXTRACTED_BYTES:
            raise SnapshotError(f"archive expands to {total // 2**20} MB, over the cap")
        try:
            archive.extractall(into, filter="data")
        except tarfile.FilterError as error:
            raise SnapshotError(f"archive rejected: {error}") from error

    # GitHub's tarballs hold one top-level directory, `owner-repo-sha/`.
    entries = [p for p in into.iterdir()]
    if len(entries) != 1 or not entries[0].is_dir():
        raise SnapshotError("expected a single top-level directory in the archive")
    return entries[0]


@contextmanager
def snapshot(client: httpx2.Client, repo: str, sha: str, token: str) -> Iterator[Snapshot]:
    """The repo at `sha` in a temporary directory, removed however the review ends."""
    workdir = Path(tempfile.mkdtemp(prefix="pr-agent-"))
    try:
        root = extract(download_tarball(client, repo, sha, token), workdir)
        yield Snapshot(root=root, repo=repo, sha=sha)
    finally:
        shutil.rmtree(workdir, ignore_errors=True)
