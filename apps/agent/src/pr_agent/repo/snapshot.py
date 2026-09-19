"""The repository at the PR's head commit, on local disk, for the agent's tools to read.

One tarball download per review, instead of one GitHub API call per file the agent wants:
no rate limit to spend, no network in the middle of the agent's loop, and every read is of
exactly the commit under review — never `main`, never a newer push.

A request with no installation token is for a public repository — the evaluation reviews
open-source fixes the App isn't installed on. Its tarball is downloaded anonymously and may
be cached on disk, keyed by the commit, since a commit never changes. A download made with a
token is never cached: that code is private.
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


def download_tarball(client: httpx2.Client, repo: str, sha: str, token: str | None) -> bytes:
    """The tarball of `repo` at `sha`, capped at MAX_TARBALL_BYTES while it streams.

    With no token the download is anonymous, which works for a public repository only.
    """
    url = f"{GITHUB_API}/repos/{repo}/tarball/{sha}"
    headers = {
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "pr-reviewer-agent",
    }
    if token is not None:
        headers["Authorization"] = f"Bearer {token}"
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


def public_tarball(client: httpx2.Client, repo: str, sha: str, cache: Path | None) -> bytes:
    """An anonymous download, read from and saved to `cache` when there is one.

    Only a full 40-character SHA is cached: a short one could come to name another commit.
    """
    path = cache / f"{repo.replace('/', '__')}@{sha}.tar.gz" if cache and len(sha) == 40 else None
    if path is not None and path.is_file():
        return path.read_bytes()
    body = download_tarball(client, repo, sha, None)
    if path is not None:
        path.parent.mkdir(parents=True, exist_ok=True)
        # Written whole then renamed, so a stopped run never leaves half a tarball behind.
        partial = path.with_suffix(".partial")
        partial.write_bytes(body)
        partial.replace(path)
    return body


@contextmanager
def snapshot(
    client: httpx2.Client, repo: str, sha: str, token: str | None, cache: Path | None = None
) -> Iterator[Snapshot]:
    """The repo at `sha` in a temporary directory, removed however the review ends."""
    workdir = Path(tempfile.mkdtemp(prefix="pr-agent-"))
    try:
        tarball = (
            download_tarball(client, repo, sha, token)
            if token is not None
            else public_tarball(client, repo, sha, cache)
        )
        root = extract(tarball, workdir)
        yield Snapshot(root=root, repo=repo, sha=sha)
    finally:
        shutil.rmtree(workdir, ignore_errors=True)
