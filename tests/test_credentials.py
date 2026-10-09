"""The credential store drives Apple's `security` tool; never touch the real Keychain."""

import importlib
import subprocess
from types import SimpleNamespace

import pytest

SECURITY = "/usr/bin/security"


@pytest.fixture
def credentials(monkeypatch):
    module = importlib.import_module("soma.credentials")
    monkeypatch.setattr(module.sys, "platform", "darwin")
    return module


class FakeSecurity:
    """An in-memory keychain behind the `security` subcommands the module uses."""

    def __init__(self):
        self.items = {}
        self.calls = []
        self.fail = {}  # subcommand -> returncode to force
        self.hang = set()  # subcommands that would prompt

    def __call__(self, argv, *, input=None, capture_output, text, timeout, check):
        assert argv[0] == SECURITY and capture_output and text and not check
        if argv[1] == "-i":
            self.calls.append(("interactive", input))
            stderr = ""
            for line in input.splitlines():
                stderr += self._interactive(line)
            return SimpleNamespace(returncode=0, stdout="", stderr=stderr)
        sub = argv[1]
        self.calls.append((sub, argv[2:], timeout))
        if sub in self.hang:
            raise subprocess.TimeoutExpired(argv, timeout)
        if sub in self.fail:
            return SimpleNamespace(returncode=self.fail[sub], stdout="", stderr="security: failed")
        account = argv[argv.index("-a") + 1]
        if sub == "find-generic-password":
            if account not in self.items:
                return SimpleNamespace(returncode=44, stdout="", stderr="not found")
            return SimpleNamespace(returncode=0, stdout=self.items[account] + "\n", stderr="")
        if sub == "delete-generic-password":
            if account not in self.items:
                return SimpleNamespace(returncode=44, stdout="", stderr="not found")
            del self.items[account]
            return SimpleNamespace(returncode=0, stdout="", stderr="")
        raise AssertionError(sub)

    def _interactive(self, line):
        parts = line.split('"')
        account = parts[1]
        if line.startswith("delete-generic-password"):
            self.items.pop(account, None)
            return ""
        if line.startswith("add-generic-password"):
            assert line.endswith(" -A"), "items must trust any application"
            assert '-w "' in line
            self.items[account] = parts[3]
            return ""
        raise AssertionError(line)


@pytest.fixture
def security(credentials, monkeypatch):
    fake = FakeSecurity()
    monkeypatch.setattr(credentials.subprocess, "run", fake)
    return fake


def test_store_replaces_with_an_any_application_item_and_verifies(credentials, security):
    security.items["account"] = "old"
    credentials.store_token("account", " dummy-密-token ")
    assert security.items == {"account": " dummy-密-token "}
    kinds = [c[0] for c in security.calls]
    assert kinds == ["interactive", "find-generic-password"]  # stored via stdin, then verified
    script = security.calls[0][1]
    assert script.splitlines()[0].startswith("delete-generic-password")
    assert " dummy-密-token " not in str(security.calls[1])  # the token never reaches argv


def test_read_round_trips_and_strips_only_the_trailing_newline(credentials, security):
    security.items["account"] = "tok en"
    assert credentials.read_token("account") == "tok en"


def test_missing_read_returns_none(credentials, security):
    assert credentials.read_token("absent") is None


def test_noninteractive_read_times_out_as_interaction_not_allowed(credentials, security):
    security.hang.add("find-generic-password")
    with pytest.raises(credentials.KeychainError, match="-25308"):
        credentials.read_token("account", interactive=False)
    assert security.calls[0][2] == credentials._NONINTERACTIVE_TIMEOUT


def test_interactive_read_has_no_timeout(credentials, security):
    security.items["account"] = "x"
    credentials.read_token("account")
    assert security.calls[0][2] is None


@pytest.mark.parametrize("rc,status", [(36, -25308), (51, -25293), (1, -25343)])
def test_native_errors_are_status_only(credentials, security, rc, status, capsys):
    security.fail["find-generic-password"] = rc
    with pytest.raises(credentials.KeychainError) as error:
        credentials.read_token("private-account")
    assert str(error.value) == f"Keychain operation failed (OS status {status})."
    assert error.value.__cause__ is None
    assert capsys.readouterr() == ("", "")


def test_delete_treats_missing_as_success(credentials, security):
    security.items["account"] = "x"
    credentials.delete_token("account")
    credentials.delete_token("missing")
    assert security.items == {}


def test_delete_error_is_raised(credentials, security):
    security.fail["delete-generic-password"] = 36
    with pytest.raises(credentials.KeychainError, match="-25308"):
        credentials.delete_token("account")


def test_store_failure_is_reported_when_verification_disagrees(credentials, security):
    security.items["account"] = "old"
    original = security._interactive

    def refuse(line):
        return "The specified item could not be added" if line.startswith("add") else original(line)

    security._interactive = refuse
    with pytest.raises(credentials.KeychainError):
        credentials.store_token("account", "new")


@pytest.mark.parametrize("platform", ["linux", "win32"])
@pytest.mark.parametrize("operation", ["read_token", "store_token"])
def test_non_macos_recommends_generic_credentials(credentials, monkeypatch, platform, operation):
    monkeypatch.setattr(credentials.sys, "platform", platform)
    args = ("account", "dummy") if operation == "store_token" else ("account",)
    with pytest.raises(RuntimeError, match="environment variable or credential command"):
        getattr(credentials, operation)(*args)


@pytest.mark.parametrize(
    "token", ["", " \t", "\n", "a\nb", "a\rb", "\r\n", " ", "a\x00b", 'a"b', "a\\b"]
)
def test_invalid_token_is_rejected_before_any_subprocess(credentials, security, token):
    with pytest.raises(ValueError):
        credentials.store_token("account", token)
    assert security.calls == []


def test_missing_security_tool_is_unavailable(credentials, monkeypatch):
    def missing(*a, **k):
        raise FileNotFoundError

    monkeypatch.setattr(credentials.subprocess, "run", missing)
    with pytest.raises(credentials.KeychainError, match="-25291"):
        credentials.read_token("account")
