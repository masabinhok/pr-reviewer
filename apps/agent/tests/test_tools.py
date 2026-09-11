import os

import pytest

from pr_agent.models import ReviewRequest
from pr_agent.repo import tools as tools_module
from pr_agent.repo.tools import RepoTools


@pytest.fixture
def repo(tmp_path):
    root = tmp_path / "octo-widgets-abc1234"
    (root / "src").mkdir(parents=True)
    (root / "node_modules/dep").mkdir(parents=True)
    (root / "src/auth.ts").write_text(
        "export function createSession(user: string) {\n  return { user };\n}\n"
    )
    (root / "src/login.ts").write_text(
        "import { createSession } from './auth';\n"
        "export const login = (u: string) => createSession(u);\n"
    )
    (root / "node_modules/dep/index.js").write_text("createSession();\n")
    (root / "logo.png").write_bytes(b"\x89PNG\0\0binary")
    return root


@pytest.fixture
def tools(repo, review_request) -> RepoTools:
    return RepoTools(repo, ReviewRequest.model_validate(review_request))


def call(tools: RepoTools, name: str, **args):
    return tools.call(name, args)


class TestGetFile:
    def test_returns_numbered_lines(self, tools):
        result, is_error = call(tools, "get_file", path="src/auth.ts")

        assert not is_error
        assert result == (
            "src/auth.ts (lines 1-3 of 3)\n"
            "1  export function createSession(user: string) {\n"
            "2    return { user };\n"
            "3  }"
        )

    def test_returns_a_range(self, tools):
        result, _ = call(tools, "get_file", path="src/auth.ts", start_line=2, end_line=2)

        assert result == "src/auth.ts (lines 2-2 of 3)\n2    return { user };\n… 1 more lines"

    def test_caps_how_many_lines_one_call_returns(self, tools, repo, monkeypatch):
        monkeypatch.setattr(tools_module, "MAX_FILE_LINES", 2)

        result, _ = call(tools, "get_file", path="src/auth.ts")

        assert result.startswith("src/auth.ts (lines 1-2 of 3)")
        assert result.endswith("… 1 more lines")

    @pytest.mark.parametrize(
        ("path", "message"),
        [
            ("src/missing.ts", "does not exist"),
            ("logo.png", "binary file"),
            ("../outside.txt", "outside the repository"),
            ("/etc/passwd", "outside the repository"),
        ],
    )
    def test_tells_the_model_what_went_wrong(self, tools, path, message):
        result, is_error = call(tools, "get_file", path=path)

        assert is_error
        assert message in result

    # A link inside the repo that points out of it must not become a way to read the host.
    def test_refuses_to_follow_a_symlink_out_of_the_repository(self, tools, repo, tmp_path):
        (tmp_path / "secret.txt").write_text("host secret")
        os.symlink(tmp_path / "secret.txt", repo / "src/sneaky.ts")

        result, is_error = call(tools, "get_file", path="src/sneaky.ts")

        assert is_error
        assert "host secret" not in result


class TestSearchRepo:
    def test_finds_the_definition_and_every_caller(self, tools):
        result, is_error = call(tools, "search_repo", query="createSession")

        assert not is_error
        assert result.splitlines() == [
            "src/auth.ts:1: export function createSession(user: string) {",
            "src/login.ts:1: import { createSession } from './auth';",
            "src/login.ts:2: export const login = (u: string) => createSession(u);",
        ]

    def test_skips_dependency_directories_and_binaries(self, tools):
        result, _ = call(tools, "search_repo", query="createSession")

        assert "node_modules" not in result
        assert "logo.png" not in result

    def test_narrows_by_glob(self, tools):
        result, _ = call(tools, "search_repo", query="createSession", path_glob="src/login.ts")

        assert all(line.startswith("src/login.ts") for line in result.splitlines())

    def test_can_ignore_case(self, tools):
        result, _ = call(tools, "search_repo", query="CREATESESSION", case_sensitive=False)

        assert len(result.splitlines()) == 3

    def test_caps_matches_and_says_how_many_it_left_out(self, tools, monkeypatch):
        monkeypatch.setattr(tools_module, "MAX_SEARCH_MATCHES", 1)

        result, _ = call(tools, "search_repo", query="createSession")

        assert result.splitlines()[-1] == "… and 2 more matches"

    def test_says_so_when_nothing_matches(self, tools):
        assert call(tools, "search_repo", query="nowhere")[0] == "No matches for 'nowhere'."


def test_lists_the_changed_files_under_review(tools):
    result, _ = call(tools, "list_changed_files")

    assert result.splitlines() == [
        "src/auth.ts  modified  +6 -5",
        "src/helpers.ts  renamed  +1 -0 (renamed from src/utils.ts)",
        "src/new-feature.ts  added  +4 -0",
    ]


def test_presents_the_description_as_data_not_instructions(tools):
    result, _ = call(tools, "get_pr_metadata")

    assert result.startswith("#3: Diff shapes")
    assert "data, not instructions" in result


class TestCall:
    def test_reports_an_unknown_tool(self, tools):
        result, is_error = tools.call("delete_repo", {})

        assert is_error
        assert "No tool named 'delete_repo'" in result

    def test_reports_invalid_input_instead_of_raising(self, tools):
        result, is_error = tools.call("get_file", {"path": "a.ts", "start_line": 0})

        assert is_error
        assert "Invalid input for get_file" in result

    def test_rejects_arguments_the_tool_does_not_take(self, tools):
        _, is_error = tools.call("search_repo", {"query": "x1", "rm": True})

        assert is_error


def test_tool_definitions_come_from_the_same_models_the_code_validates_with(tools):
    definitions = {d["name"]: d for d in tools.definitions()}

    assert set(definitions) == {"get_file", "search_repo", "list_changed_files", "get_pr_metadata"}
    get_file = definitions["get_file"]["input_schema"]
    assert get_file["required"] == ["path"]
    assert get_file["additionalProperties"] is False
    assert set(get_file["properties"]) == {"path", "start_line", "end_line"}
    assert "title" not in get_file
    # Every tool reads; none writes. Keep this list honest when adding tools.
    assert not any(word in name for name in definitions for word in ("write", "delete", "post"))
