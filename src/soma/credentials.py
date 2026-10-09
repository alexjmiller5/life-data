"""Generic passwords in the macOS Keychain, through Apple's `security` tool.

Why a subprocess and not SecItem: the file-based Keychain gates every item
behind a partition list that securityd fills with the CREATING binary's code
identity. A Nix-built, ad-hoc-signed python is a new identity on every
rebuild, so an item it stored becomes a consent prompt for the next build -
and the sync daemon runs with prompts disabled. `/usr/bin/security` is an
Apple tool with one identity for the life of the OS: an item it stores with
`-A` (any application) in the `apple-tool:` partition is readable by it
without a prompt, on every build, forever. The secret only ever crosses a
pipe (stdin on store, stdout on read) - never argv, the environment or disk.
"""

import subprocess
import sys

_SERVICE = "soma"
_SECURITY = "/usr/bin/security"
_NOT_FOUND = -25300
_INTERACTION = -25308
_UNAVAILABLE = -25291
_NONINTERACTIVE_TIMEOUT = 10.0


class KeychainError(RuntimeError):
    """An OS status that is safe to show without exposing credential data."""


def _status(returncode: int) -> int:
    """`security` exits with the low byte of the OSStatus; map the errSec range back."""
    if 0 < returncode < 256:
        return -(25344 - returncode)
    return returncode


def _check(status: int) -> None:
    if status:
        raise KeychainError(f"Keychain operation failed (OS status {status}).") from None


def _require_macos() -> None:
    if sys.platform != "darwin":
        raise RuntimeError(
            "Keychain storage requires macOS; use an environment variable or credential command."
        )


def _run(args: list[str], *, stdin: str | None = None, timeout: float | None = None):
    try:
        return subprocess.run(
            [_SECURITY, *args],
            input=stdin,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except FileNotFoundError:
        _check(_UNAVAILABLE)
    except subprocess.TimeoutExpired:
        # Only a consent or unlock prompt keeps `security` waiting; with prompts
        # forbidden that is the same outcome SecItem reports as -25308.
        _check(_INTERACTION)


def _validate(token: str) -> None:
    if not token.strip() or any(char in token for char in "\r\n\x00"):
        raise ValueError("Token must be nonblank and contain no newlines or NUL bytes.")
    try:
        token.encode("utf-8")
    except UnicodeError:
        raise ValueError("Token must be valid UTF-8 text.") from None
    if any(char in token for char in '"\\'):
        raise ValueError("Token must not contain quotes or backslashes.")


def store_token(account: str, token: str, service: str = _SERVICE) -> None:
    """Create or replace the caller's token under `service`.

    Replaces rather than updates: only a freshly added item gets the
    any-application access list, so an item stored by an earlier build (with
    that build's identity pinned) is deleted first.
    """
    _require_macos()
    _validate(token)
    # `security -i` reads commands from stdin: the token never appears in argv.
    script = (
        f"delete-generic-password -s {service} -a {_quote(account)}\n"
        f"add-generic-password -s {service} -a {_quote(account)} -w {_quote(token)} -A\n"
    )
    result = _run(["-i"], stdin=script)
    # Interactive mode reports each command on stderr; the add is the last one.
    if "could not be added" in result.stderr or _unauthorized(result.stderr):
        _check(_status(result.returncode) if result.returncode else _INTERACTION)
    if read_token(account, interactive=True, service=service) != token:
        _check(_status(result.returncode) if result.returncode else -25299)


def _unauthorized(stderr: str) -> bool:
    return "Unable to obtain authorization" in stderr or "interaction is not allowed" in stderr


def _quote(value: str) -> str:
    if any(char in value for char in '"\\\r\n\x00'):
        raise ValueError(
            "Keychain account and token must not contain quotes, backslashes or newlines."
        )
    return f'"{value}"'


def read_token(account: str, *, interactive: bool = True, service: str = _SERVICE) -> str | None:
    """Read a token; noninteractive reads fail if native consent or unlocking is needed."""
    _require_macos()
    result = _run(
        ["find-generic-password", "-s", service, "-a", account, "-w"],
        timeout=None if interactive else _NONINTERACTIVE_TIMEOUT,
    )
    if result.returncode:
        status = _status(result.returncode)
        if status == _NOT_FOUND:
            return None
        _check(status)
    return result.stdout.rstrip("\n")


def delete_token(account: str, service: str = _SERVICE) -> None:
    """Delete the caller's token, returning successfully when it is absent."""
    _require_macos()
    result = _run(["delete-generic-password", "-s", service, "-a", account])
    if result.returncode and _status(result.returncode) != _NOT_FOUND:
        _check(_status(result.returncode))
