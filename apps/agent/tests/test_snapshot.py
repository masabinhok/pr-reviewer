import io
import tarfile
from pathlib import Path

import httpx2
import pytest

from pr_agent.repo import snapshot as snap
from pr_agent.repo.snapshot import SnapshotError, download_tarball, extract, snapshot

PREFIX = "octo-widgets-abc1234"


def tarball(files: dict[str, str] | None = None, *, extra=None) -> bytes:
    """A gzipped tarball shaped like GitHub's: one `owner-repo-sha/` directory on top."""
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
        top = tarfile.TarInfo(PREFIX)
        top.type = tarfile.DIRTYPE
        archive.addfile(top)
        for name, text in (files or {}).items():
            data = text.encode()
            info = tarfile.TarInfo(f"{PREFIX}/{name}")
            info.size = len(data)
            archive.addfile(info, io.BytesIO(data))
        for info in extra or []:
            archive.addfile(info, io.BytesIO(b"x" * info.size) if info.size else None)
    return buffer.getvalue()


def entry(name: str, *, link: str | None = None, size: int = 1) -> tarfile.TarInfo:
    info = tarfile.TarInfo(name)
    if link is not None:
        info.type = tarfile.SYMTYPE
        info.linkname = link
        info.size = 0
    else:
        info.size = size
    return info


class TestExtract:
    def test_returns_the_repository_root_inside_the_archive(self, tmp_path):
        root = extract(tarball({"src/auth.ts": "export {}\n", "README.md": "# hi\n"}), tmp_path)

        assert root.name == PREFIX
        assert (root / "src/auth.ts").read_text() == "export {}\n"

    # A tarball is untrusted input: every one of these would write outside the target.
    @pytest.mark.parametrize(
        "hostile",
        [
            entry("../evil.txt"),
            entry(f"{PREFIX}/../../evil.txt"),
            entry(f"{PREFIX}/passwd", link="/etc/passwd"),
            entry(f"{PREFIX}/escape", link="../../../outside"),
        ],
        ids=["dot-dot", "nested-dot-dot", "symlink-absolute", "symlink-escaping"],
    )
    def test_refuses_an_entry_that_escapes_the_extraction_directory(self, tmp_path, hostile):
        into = tmp_path / "into"
        into.mkdir()

        with pytest.raises(SnapshotError, match="archive rejected"):
            extract(tarball({"ok.txt": "fine"}, extra=[hostile]), into)

        assert not (tmp_path / "evil.txt").exists()

    # The `data` filter doesn't reject a leading slash — it strips it, so the entry lands
    # *inside* the target. Nothing is written to the absolute path either way.
    def test_keeps_an_absolute_path_inside_the_extraction_directory(self, tmp_path):
        target = tmp_path / "absolute-evil.txt"
        into = tmp_path / "into"
        into.mkdir()

        with pytest.raises(SnapshotError):  # a second top-level entry: not GitHub's shape
            extract(tarball({"ok.txt": "fine"}, extra=[entry(str(target))]), into)

        assert not target.exists()
        assert (into / str(target).lstrip("/")).exists()

    def test_keeps_a_symlink_that_stays_inside(self, tmp_path):
        root = extract(
            tarball({"real.ts": "x"}, extra=[entry(f"{PREFIX}/alias.ts", link="real.ts")]),
            tmp_path,
        )

        assert (root / "alias.ts").read_text() == "x"

    def test_refuses_an_archive_that_expands_too_far(self, tmp_path, monkeypatch):
        monkeypatch.setattr(snap, "MAX_EXTRACTED_BYTES", 10)

        with pytest.raises(SnapshotError, match="expands to"):
            extract(tarball({"big.txt": "x" * 100}), tmp_path)

    def test_refuses_an_archive_with_too_many_entries(self, tmp_path, monkeypatch):
        monkeypatch.setattr(snap, "MAX_MEMBERS", 3)

        with pytest.raises(SnapshotError, match="entries"):
            extract(tarball({f"f{i}.txt": "x" for i in range(5)}), tmp_path)


def github(handler) -> httpx2.Client:
    return httpx2.Client(transport=httpx2.MockTransport(handler))


class TestDownload:
    def test_downloads_the_exact_commit_following_githubs_redirect(self):
        body = tarball({"a.txt": "a"})
        seen = []

        def handler(request: httpx2.Request) -> httpx2.Response:
            seen.append((str(request.url), request.headers.get("authorization")))
            if request.url.host == "api.github.com":
                return httpx2.Response(
                    302, headers={"location": "https://codeload.github.com/x.tgz"}
                )
            return httpx2.Response(200, content=body)

        assert download_tarball(github(handler), "octo/widgets", "abc1234", "ghs_t") == body
        assert seen[0] == (
            "https://api.github.com/repos/octo/widgets/tarball/abc1234",
            "Bearer ghs_t",
        )

    def test_reports_a_refusal_without_leaking_the_token(self):
        client = github(lambda _: httpx2.Response(404, json={"message": "Not Found"}))

        with pytest.raises(SnapshotError) as error:
            download_tarball(client, "octo/widgets", "abc1234", "ghs_secret_token")

        assert "404" in str(error.value)
        assert "ghs_secret_token" not in str(error.value)

    def test_stops_reading_once_the_download_is_over_the_cap(self, monkeypatch):
        monkeypatch.setattr(snap, "MAX_TARBALL_BYTES", 1000)
        client = github(lambda _: httpx2.Response(200, content=b"x" * 5000))

        with pytest.raises(SnapshotError, match="compressed"):
            download_tarball(client, "octo/widgets", "abc1234", "t")


def test_the_snapshot_is_removed_however_the_review_ends():
    client = github(lambda _: httpx2.Response(200, content=tarball({"a.txt": "a"})))
    seen: list[Path] = []

    with pytest.raises(RuntimeError), snapshot(client, "octo/widgets", "abc1234", "t") as snap_:
        seen.append(snap_.root)
        assert (snap_.root / "a.txt").exists()
        raise RuntimeError("the review blew up")

    assert not seen[0].exists()
    assert not seen[0].parent.exists()
