"""Generic passwords in the macOS Keychain, without subprocesses or secret files."""

import ctypes
import sys
from contextlib import ExitStack

_SERVICE = "life-data"
_NOT_FOUND = -25300
_DUPLICATE = -25299
_DECODE = -26275
_UNAVAILABLE = -25291
_REQUIRE_PASSPHRASE = 0x0001  # kSecKeychainPromptRequirePassphase


def _any_application_access(security, cf, own, string):
    """An access object whose entries trust ANY application (what
    `security add-generic-password -A` does). The default access trusts only
    the binary that stored the item, and a Nix rebuild moves that binary, so
    every later reader (the sync daemon included) would face a consent prompt
    it cannot answer. The entry that protects changing the access itself still
    requires the keychain passphrase, so it is left alone.
    """
    access = ctypes.c_void_p()
    _check(security.SecAccessCreate(string(_SERVICE), None, ctypes.byref(access)))
    own(access.value)
    acls = ctypes.c_void_p()
    _check(security.SecAccessCopyACLList(access.value, ctypes.byref(acls)))
    own(acls.value)
    for i in range(cf.CFArrayGetCount(acls.value)):
        acl = cf.CFArrayGetValueAtIndex(acls.value, i)
        apps, description, prompt = ctypes.c_void_p(), ctypes.c_void_p(), ctypes.c_uint16()
        _check(
            security.SecACLCopyContents(
                acl, ctypes.byref(apps), ctypes.byref(description), ctypes.byref(prompt)
            )
        )
        if apps.value:
            own(apps.value)
        if description.value:
            own(description.value)
        if prompt.value & _REQUIRE_PASSPHRASE:
            continue
        _check(security.SecACLSetContents(acl, None, description.value, prompt.value))
    return access.value


class KeychainError(RuntimeError):
    """An OS status that is safe to show without exposing credential data."""


def _check(status: int) -> None:
    if status:
        raise KeychainError(f"Keychain operation failed (OS status {status}).") from None


def _require_macos() -> None:
    if sys.platform != "darwin":
        raise RuntimeError(
            "Keychain storage requires macOS; use an environment variable or credential command."
        )


def _frameworks():
    """Bind lazily with pointer-sized CF references and signed 32-bit OSStatus."""
    ptr = ctypes.c_void_p
    refs = ctypes.POINTER(ptr)
    index = ctypes.c_long  # CFIndex is signed long on macOS.
    try:
        security = ctypes.CDLL("/System/Library/Frameworks/Security.framework/Security")
        cf = ctypes.CDLL("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation")
        for name, args in (
            ("SecItemCopyMatching", [ptr, refs]),
            ("SecItemAdd", [ptr, refs]),
            ("SecItemUpdate", [ptr, ptr]),
            ("SecItemDelete", [ptr]),
            ("SecKeychainGetUserInteractionAllowed", [ctypes.POINTER(ctypes.c_ubyte)]),
            ("SecKeychainSetUserInteractionAllowed", [ctypes.c_ubyte]),
            ("SecAccessCreate", [ptr, ptr, refs]),
            ("SecAccessCopyACLList", [ptr, refs]),
            ("SecACLCopyContents", [ptr, refs, refs, ctypes.POINTER(ctypes.c_uint16)]),
            ("SecACLSetContents", [ptr, ptr, ptr, ctypes.c_uint16]),
        ):
            function = getattr(security, name)
            function.argtypes = args
            function.restype = ctypes.c_int32
        for name, args, result in (
            ("CFStringCreateWithBytes", [ptr, ptr, index, ctypes.c_uint32, ctypes.c_ubyte], ptr),
            ("CFDataCreate", [ptr, ptr, index], ptr),
            ("CFDictionaryCreate", [ptr, refs, refs, index, ptr, ptr], ptr),
            ("CFDataGetLength", [ptr], index),
            ("CFDataGetBytePtr", [ptr], ptr),
            ("CFArrayGetCount", [ptr], index),
            ("CFArrayGetValueAtIndex", [ptr, index], ptr),
            ("CFDataGetTypeID", [], ctypes.c_ulong),
            ("CFGetTypeID", [ptr], ctypes.c_ulong),
            ("CFRelease", [ptr], None),
        ):
            function = getattr(cf, name)
            function.argtypes = args
            function.restype = result
        # These exported symbols are STRUCTS, unlike the pointer-valued constants.
        keys = ctypes.byref(ctypes.c_byte.in_dll(cf, "kCFTypeDictionaryKeyCallBacks"))
        values = ctypes.byref(ctypes.c_byte.in_dll(cf, "kCFTypeDictionaryValueCallBacks"))
    except (OSError, AttributeError, ValueError):
        _check(_UNAVAILABLE)
    return security, cf, keys, values


def _constant(library, name):
    try:
        return ctypes.c_void_p.in_dll(library, name).value
    except (AttributeError, ValueError):
        _check(_UNAVAILABLE)


def _access(account: str, token: bytes | None = None, *, interactive: bool = True) -> bytes | None:
    security, cf, key_callbacks, value_callbacks = _frameworks()
    with ExitStack() as cleanup:

        def own(ref):
            if not ref:
                _check(-108)  # errSecAllocate
            cleanup.callback(cf.CFRelease, ref)
            return ref

        def string(value):
            try:
                data = value.encode("utf-8")
            except UnicodeError:
                _check(_DECODE)
            return own(cf.CFStringCreateWithBytes(None, data, len(data), 0x08000100, False))

        def dictionary(attributes):
            refs = ctypes.c_void_p * len(attributes)
            return own(
                cf.CFDictionaryCreate(
                    None,
                    refs(*attributes),
                    refs(*attributes.values()),
                    len(attributes),
                    key_callbacks,
                    value_callbacks,
                )
            )

        # SecItem defaults to the file-based Keychain on macOS, which supports
        # command-line tools without an app bundle or access-group entitlements.
        query = {
            _constant(security, "kSecClass"): _constant(security, "kSecClassGenericPassword"),
            _constant(security, "kSecAttrService"): string(_SERVICE),
            _constant(security, "kSecAttrAccount"): string(account),
        }
        if token is not None:
            # Replace rather than update: an item stored by an earlier binary
            # carries that binary's access list, and only a fresh item gets the
            # any-application access below.
            attributes = {
                _constant(security, "kSecValueData"): own(cf.CFDataCreate(None, token, len(token))),
                _constant(security, "kSecAttrAccess"): _any_application_access(
                    security, cf, own, string
                ),
            }
            query_ref, add_ref = dictionary(query), dictionary(query | attributes)
            for attempt in range(2):
                status = security.SecItemDelete(query_ref)
                if status != _NOT_FOUND:
                    _check(status)
                status = security.SecItemAdd(add_ref, None)
                if status != _DUPLICATE or attempt:
                    break  # a concurrent writer recreated it: delete and add once more
            _check(status)
            return None

        query[_constant(security, "kSecReturnData")] = _constant(cf, "kCFBooleanTrue")
        query[_constant(security, "kSecMatchLimit")] = _constant(security, "kSecMatchLimitOne")
        query_ref = dictionary(query)
        result = ctypes.c_void_p()
        previous = ctypes.c_ubyte()
        if not interactive:
            # File-based SecItem uses the legacy UI policy, shared within this process.
            _check(security.SecKeychainGetUserInteractionAllowed(ctypes.byref(previous)))
        try:
            if not interactive:
                _check(security.SecKeychainSetUserInteractionAllowed(False))
            status = security.SecItemCopyMatching(query_ref, ctypes.byref(result))
        finally:
            if result.value:
                own(result.value)
            if not interactive:
                _check(security.SecKeychainSetUserInteractionAllowed(previous.value))
        if status == _NOT_FOUND:
            return None
        _check(status)
        if not result.value or cf.CFGetTypeID(result.value) != cf.CFDataGetTypeID():
            _check(_DECODE)
        length = cf.CFDataGetLength(result.value)
        data = cf.CFDataGetBytePtr(result.value)
        if length < 0 or (length and not data):
            _check(_DECODE)
        return ctypes.string_at(data, length) if length else b""


def store_token(account: str, token: str) -> None:
    """Create or update a token for the caller's account under service life-data."""
    _require_macos()
    if not token.strip() or any(char in token for char in "\r\n\x00"):
        raise ValueError("Token must be nonblank and contain no newlines or NUL bytes.")
    try:
        data = token.encode("utf-8")
    except UnicodeError:
        raise ValueError("Token must be valid UTF-8 text.") from None
    _access(account, data)


def read_token(account: str, *, interactive: bool = True) -> str | None:
    """Read a token; noninteractive reads fail if native consent or unlocking is needed."""
    _require_macos()
    data = _access(account, interactive=interactive)
    if data is None:
        return None
    try:
        return data.decode("utf-8")
    except UnicodeError:
        _check(_DECODE)


def delete_token(account: str) -> None:
    """Delete the caller's token, returning successfully when it is absent."""
    _require_macos()
    security, cf, key_callbacks, value_callbacks = _frameworks()
    with ExitStack() as cleanup:

        def own(ref):
            if not ref:
                _check(-108)
            cleanup.callback(cf.CFRelease, ref)
            return ref

        def string(value):
            try:
                data = value.encode("utf-8")
            except UnicodeError:
                _check(_DECODE)
            return own(cf.CFStringCreateWithBytes(None, data, len(data), 0x08000100, False))

        attrs = {
            _constant(security, "kSecClass"): _constant(security, "kSecClassGenericPassword"),
            _constant(security, "kSecAttrService"): string(_SERVICE),
            _constant(security, "kSecAttrAccount"): string(account),
        }
        refs = ctypes.c_void_p * len(attrs)
        query = own(
            cf.CFDictionaryCreate(
                None,
                refs(*attrs),
                refs(*attrs.values()),
                len(attrs),
                key_callbacks,
                value_callbacks,
            )
        )
        status = security.SecItemDelete(query)
        if status == _NOT_FOUND:
            return
        _check(status)
