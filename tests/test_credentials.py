"""Exercise the native boundary in memory; never open the user's Keychain."""

import ctypes
import importlib
import sys
import traceback
from types import SimpleNamespace
from unittest.mock import Mock

import pytest


@pytest.fixture
def credentials(monkeypatch):
    # Fail closed even if an implementation accidentally bypasses our native double.
    monkeypatch.setattr(ctypes, "CDLL", Mock(side_effect=AssertionError("native access forbidden")))
    module = importlib.import_module("life_data.credentials")
    monkeypatch.setattr(module.sys, "platform", "darwin")
    return module


class Native:
    """Small CF object arena and Security API double, with caller-owned ref tracking."""

    def __init__(self):
        self.objects = {}
        self.owned = set()
        self.symbols = {}
        self.buffers = []
        self.items = {}
        self.statuses = {}
        self.calls = []
        self.interactive = True
        self.read_interaction = []
        self.next_ref = 2**40  # Catch pointer truncation assumptions.
        self.cf = SimpleNamespace(
            CFStringCreateWithBytes=Mock(side_effect=self.string),
            CFDataCreate=Mock(side_effect=self.data),
            CFDictionaryCreate=Mock(side_effect=self.dictionary),
            CFDataGetLength=Mock(side_effect=lambda ref: len(self.objects[ref])),
            CFDataGetBytePtr=Mock(side_effect=self.byte_pointer),
            CFDataGetTypeID=Mock(return_value=7),
            CFGetTypeID=Mock(
                side_effect=lambda ref: 7 if isinstance(self.objects[ref], bytes) else 8
            ),
            CFRelease=Mock(side_effect=self.release),
        )
        self.security = SimpleNamespace(
            SecItemCopyMatching=Mock(side_effect=self.read),
            SecItemUpdate=Mock(side_effect=self.update),
            SecItemAdd=Mock(side_effect=self.add),
            SecItemDelete=Mock(side_effect=self.delete),
            SecKeychainGetUserInteractionAllowed=Mock(side_effect=self.get_interaction),
            SecKeychainSetUserInteractionAllowed=Mock(side_effect=self.set_interaction),
        )

    def allocate(self, value, owned=True):
        self.next_ref += 1
        self.objects[self.next_ref] = value
        if owned:
            self.owned.add(self.next_ref)
        return self.next_ref

    def constant(self, library, name):
        if name not in self.symbols:
            self.symbols[name] = self.allocate(name, owned=False)
        return self.symbols[name]

    def string(self, allocator, data, length, encoding, external):
        assert allocator is None and encoding == 0x08000100 and not external
        return self.allocate(ctypes.string_at(data, length).decode("utf-8"))

    def data(self, allocator, data, length):
        assert allocator is None
        return self.allocate(ctypes.string_at(data, length))

    def dictionary(self, allocator, keys, values, count, key_callbacks, value_callbacks):
        assert allocator is None and key_callbacks and value_callbacks
        return self.allocate({self.objects[keys[i]]: self.objects[values[i]] for i in range(count)})

    def byte_pointer(self, ref):
        buf = ctypes.create_string_buffer(self.objects[ref])
        self.buffers.append(buf)
        return ctypes.addressof(buf)

    def release(self, ref):
        # Removing a non-owned or previously released reference fails the test.
        self.owned.remove(ref)

    def query(self, ref):
        query = self.objects[ref]
        assert query["kSecClass"] == "kSecClassGenericPassword"
        return query, (query["kSecAttrService"], query["kSecAttrAccount"])

    def status(self, operation):
        self.calls.append(operation)
        return self.statuses.get(operation, [0]).pop(0)

    def read(self, query_ref, result):
        self.read_interaction.append(self.interactive)
        query, key = self.query(query_ref)
        assert query["kSecReturnData"] == "kCFBooleanTrue"
        assert query["kSecMatchLimit"] == "kSecMatchLimitOne"
        status = self.status("read")
        if status:
            return status
        if key not in self.items:
            return -25300
        ctypes.cast(result, ctypes.POINTER(ctypes.c_void_p))[0] = self.allocate(self.items[key])
        return 0

    def get_interaction(self, result):
        status = self.status("get_ui")
        if not status:
            ctypes.cast(result, ctypes.POINTER(ctypes.c_ubyte))[0] = self.interactive
        return status

    def set_interaction(self, state):
        status = self.status("set_ui")
        if not status:
            self.interactive = bool(state)
        return status

    def update(self, query_ref, attributes_ref):
        query, key = self.query(query_ref)
        assert set(query) == {"kSecClass", "kSecAttrService", "kSecAttrAccount"}
        attributes = self.objects[attributes_ref]
        assert set(attributes) == {"kSecValueData"}
        status = self.status("update")
        if status:
            return status
        if key not in self.items:
            return -25300
        self.items[key] = attributes["kSecValueData"]
        return 0

    def add(self, attributes_ref, result):
        attributes, key = self.query(attributes_ref)
        assert result is None
        status = self.status("add")
        if status:
            return status
        if key in self.items:
            return -25299
        self.items[key] = attributes["kSecValueData"]
        return 0

    def delete(self, query_ref):
        _query, key = self.query(query_ref)
        status = self.status("delete")
        if status:
            return status
        if key not in self.items:
            return -25300
        del self.items[key]
        return 0


@pytest.fixture
def native(credentials, monkeypatch):
    native = Native()
    monkeypatch.setattr(credentials, "_frameworks", lambda: (native.security, native.cf, 1, 2))
    monkeypatch.setattr(credentials, "_constant", native.constant)
    yield native
    assert not native.owned, "leaked Core Foundation references"


def test_new_token_round_trips_exact_utf8_and_spaces(credentials, native, capsys):
    account = "https://hub.example/é:directory-digest"
    token = " dummy-密-token "
    assert credentials.store_token(account, token) is None
    assert native.items == {("life-data", account): token.encode()}
    assert credentials.read_token(account) == token
    assert capsys.readouterr() == ("", "")


def test_update_preserves_other_accounts_and_services(credentials, native):
    native.items = {
        ("life-data", "account-a"): b"old",
        ("life-data", "account-b"): b"untouched",
        ("another-service", "account-a"): b"also-untouched",
    }
    credentials.store_token("account-a", "new")
    assert native.items == {
        ("life-data", "account-a"): b"new",
        ("life-data", "account-b"): b"untouched",
        ("another-service", "account-a"): b"also-untouched",
    }
    assert native.calls == ["update"]


def test_missing_read_returns_none(credentials, native):
    assert credentials.read_token("absent") is None
    assert not native.items


@pytest.mark.parametrize("previous", [True, False])
@pytest.mark.parametrize("outcome", ["success", "missing", "denied", "decode", "interrupt"])
def test_noninteractive_read_restores_native_ui_on_every_exit(
    credentials, native, previous, outcome
):
    native.interactive = previous
    if outcome != "missing":
        native.items[("life-data", "account")] = b"dummy-private-token"
    if outcome == "denied":
        native.statuses["read"] = [-25293]
    elif outcome == "decode":
        native.items[("life-data", "account")] = b"dummy-private\xff"
    elif outcome == "interrupt":

        def interrupt(*_):
            assert native.interactive is False
            raise KeyboardInterrupt

        native.security.SecItemCopyMatching.side_effect = interrupt
    if outcome in {"denied", "decode"}:
        code = -25293 if outcome == "denied" else -26275
        with pytest.raises(credentials.KeychainError, match=f"OS status {code}"):
            credentials.read_token("account", interactive=False)
    elif outcome == "interrupt":
        with pytest.raises(KeyboardInterrupt):
            credentials.read_token("account", interactive=False)
    else:
        expected = "dummy-private-token" if outcome == "success" else None
        assert credentials.read_token("account", interactive=False) == expected
    assert native.interactive is previous
    if outcome != "interrupt":
        assert native.read_interaction == [False]


@pytest.mark.parametrize("operation", ["get_ui", "set_ui"])
def test_suppression_failure_never_attempts_the_native_read(credentials, native, operation):
    native.statuses[operation] = [-25308, 0]
    with pytest.raises(credentials.KeychainError, match="OS status -25308"):
        credentials.read_token("account", interactive=False)
    assert not native.read_interaction
    assert native.interactive is True


def test_restoration_failure_is_reported_and_releases_the_result(credentials, native):
    native.items[("life-data", "account")] = b"dummy-private-token"
    native.statuses["set_ui"] = [0, -25308]
    with pytest.raises(credentials.KeychainError, match="OS status -25308"):
        credentials.read_token("account", interactive=False)
    assert native.read_interaction == [False]
    assert not native.owned


def test_interactive_default_leaves_the_native_policy_alone(credentials, native):
    native.items[("life-data", "account")] = b"dummy"
    assert credentials.read_token("account") == "dummy"
    assert native.read_interaction == [True]
    assert native.calls == ["read"]


def test_delete_removes_only_the_requested_account_and_treats_missing_as_success(
    credentials, native
):
    native.items = {
        ("life-data", "account-a"): b"a",
        ("life-data", "account-b"): b"b",
    }
    credentials.delete_token("account-a")
    credentials.delete_token("missing")
    assert native.items == {("life-data", "account-b"): b"b"}
    assert native.calls == ["delete", "delete"]


@pytest.mark.parametrize("platform", ["linux", "win32"])
@pytest.mark.parametrize("operation", ["read_token", "store_token"])
def test_non_macos_recommends_generic_credentials(credentials, monkeypatch, platform, operation):
    monkeypatch.setattr(credentials.sys, "platform", platform)
    args = ("account", "dummy") if operation == "store_token" else ("account",)
    with pytest.raises(RuntimeError, match="(?i)macOS.*environment.*credential command"):
        getattr(credentials, operation)(*args)


@pytest.mark.parametrize("token", ["", " \t", "\n", "a\nb", "a\rb", "\r\n", "\u2003", "a\x00b"])
def test_invalid_token_is_rejected_before_native_access(credentials, token):
    with pytest.raises(ValueError, match="(?i)token"):
        credentials.store_token("account", token)


def test_invalid_unicode_token_error_does_not_disclose_input(credentials):
    token = "dummy-private\ud800"
    with pytest.raises(ValueError) as error:
        credentials.store_token("account", token)
    assert "dummy-private" not in "".join(traceback.format_exception(error.value))


@pytest.mark.parametrize("operation", ["read", "update", "add"])
@pytest.mark.parametrize("status", [-25293, -25308, -128])
def test_native_errors_are_status_only_and_release_refs(
    credentials, native, operation, status, capsys
):
    native.statuses[operation] = [status]
    with pytest.raises(RuntimeError) as error:
        if operation == "read":
            credentials.read_token("private-account")
        else:
            credentials.store_token("private-account", "dummy-private-token")
    assert str(error.value) == f"Keychain operation failed (OS status {status})."
    assert error.value.__cause__ is None
    assert capsys.readouterr() == ("", "")
    assert not native.items


def test_concurrent_creation_retries_update_once(credentials, native):
    native.items[("life-data", "account")] = b"concurrent"
    native.statuses["update"] = [-25300, 0]
    credentials.store_token("account", "requested")
    assert native.items[("life-data", "account")] == b"requested"
    assert native.calls == ["update", "add", "update"]


def test_racing_update_error_is_not_swallowed(credentials, native):
    native.items[("life-data", "account")] = b"concurrent"
    native.statuses["update"] = [-25300, -25308]
    with pytest.raises(RuntimeError, match="-25308"):
        credentials.store_token("account", "requested")
    assert native.items[("life-data", "account")] == b"concurrent"
    assert native.calls == ["update", "add", "update"]


@pytest.mark.parametrize("value", [b"dummy-private\xff", "unexpected CFString"])
def test_malformed_stored_data_is_sanitized_and_released(credentials, native, value):
    native.items[("life-data", "account")] = value
    with pytest.raises(RuntimeError, match="OS status -26275") as error:
        credentials.read_token("account")
    assert "dummy-private" not in "".join(traceback.format_exception(error.value))


def test_null_success_result_is_rejected(credentials, native):
    native.security.SecItemCopyMatching.side_effect = None
    native.security.SecItemCopyMatching.return_value = 0
    with pytest.raises(RuntimeError, match="OS status -26275"):
        credentials.read_token("account")


def test_cf_allocation_failure_releases_earlier_objects(credentials, native):
    native.cf.CFDataCreate.side_effect = None
    native.cf.CFDataCreate.return_value = None
    with pytest.raises(RuntimeError, match="OS status -108"):
        credentials.store_token("account", "dummy")


def test_error_result_is_released_even_when_status_is_failure(credentials, native):
    def fail_with_result(query, result):
        ctypes.cast(result, ctypes.POINTER(ctypes.c_void_p))[0] = native.allocate(b"dummy")
        return -25308

    native.security.SecItemCopyMatching.side_effect = fail_with_result
    with pytest.raises(RuntimeError, match="-25308"):
        credentials.read_token("account")


@pytest.mark.parametrize("length,pointer", [(-1, 123), (5, None)])
def test_invalid_data_buffer_is_not_dereferenced(credentials, native, length, pointer):
    native.items[("life-data", "account")] = b"dummy"
    native.cf.CFDataGetLength.side_effect = None
    native.cf.CFDataGetLength.return_value = length
    native.cf.CFDataGetBytePtr.side_effect = None
    native.cf.CFDataGetBytePtr.return_value = pointer
    with pytest.raises(RuntimeError, match="-26275"):
        credentials.read_token("account")


def test_empty_stored_data_is_not_treated_as_missing(credentials, native):
    native.items[("life-data", "account")] = b""
    assert credentials.read_token("account") == ""


def test_framework_loading_failure_is_sanitized(credentials, monkeypatch):
    monkeypatch.setattr(ctypes, "CDLL", Mock(side_effect=OSError("private loader detail")))
    with pytest.raises(RuntimeError, match="OS status -25291") as error:
        credentials.read_token("account")
    assert "private loader detail" not in "".join(traceback.format_exception(error.value))


def test_import_does_not_load_frameworks_or_touch_keychain(credentials):
    # The fixture forbids CDLL, and reloading must be harmless on every platform.
    importlib.reload(credentials)


@pytest.mark.skipif(sys.platform != "darwin", reason="Core Foundation ABI smoke requires macOS")
def test_real_cf_abi_with_security_calls_replaced(monkeypatch):
    """Use real CF allocation and callbacks, but NEVER invoke real SecItem calls."""
    module = importlib.import_module("life_data.credentials")
    security, cf, keys, values = module._frameworks()
    monkeypatch.setattr(module, "_frameworks", lambda: (security, cf, keys, values))
    cf.CFDictionaryGetValue.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    cf.CFDictionaryGetValue.restype = ctypes.c_void_p
    cf.CFStringGetCString.argtypes = [
        ctypes.c_void_p,
        ctypes.c_void_p,
        ctypes.c_long,
        ctypes.c_uint32,
    ]
    cf.CFStringGetCString.restype = ctypes.c_ubyte
    items = {}

    def attribute(query, name):
        return cf.CFDictionaryGetValue(query, module._constant(security, name))

    def string(ref):
        buffer = ctypes.create_string_buffer(128)
        assert cf.CFStringGetCString(ref, buffer, len(buffer), 0x08000100)
        return buffer.value.decode("utf-8")

    def identity(query):
        assert attribute(query, "kSecClass") == module._constant(
            security, "kSecClassGenericPassword"
        )
        return string(attribute(query, "kSecAttrService")), string(
            attribute(query, "kSecAttrAccount")
        )

    def data(attributes):
        ref = attribute(attributes, "kSecValueData")
        return ctypes.string_at(cf.CFDataGetBytePtr(ref), cf.CFDataGetLength(ref))

    def read(query, result):
        key = identity(query)
        if key not in items:
            return -25300
        payload = items[key]
        ctypes.cast(result, ctypes.POINTER(ctypes.c_void_p))[0] = cf.CFDataCreate(
            None, payload, len(payload)
        )
        return 0

    def add(query, result):
        assert result is None
        items[identity(query)] = data(query)
        return 0

    def update(query, attributes):
        key = identity(query)
        if key not in items:
            return -25300
        items[key] = data(attributes)
        return 0

    for name, implementation in (
        ("SecItemCopyMatching", read),
        ("SecItemAdd", add),
        ("SecItemUpdate", update),
    ):
        function = getattr(security, name)
        assert function.restype is ctypes.c_int32
        expected_args = [
            ctypes.c_void_p,
            ctypes.c_void_p if name == "SecItemUpdate" else ctypes.POINTER(ctypes.c_void_p),
        ]
        assert function.argtypes == expected_args
        monkeypatch.setattr(security, name, implementation)

    interaction = [True]

    def get_interaction(result):
        ctypes.cast(result, ctypes.POINTER(ctypes.c_ubyte))[0] = interaction[0]
        return 0

    def set_interaction(state):
        interaction[0] = bool(state)
        return 0

    for name, implementation, args in (
        ("SecKeychainGetUserInteractionAllowed", get_interaction, [ctypes.POINTER(ctypes.c_ubyte)]),
        ("SecKeychainSetUserInteractionAllowed", set_interaction, [ctypes.c_ubyte]),
    ):
        function = getattr(security, name)
        assert function.restype is ctypes.c_int32 and function.argtypes == args
        monkeypatch.setattr(security, name, implementation)

    account = "https://hub.example/é:dummy-digest"
    assert module.read_token(account) is None
    module.store_token(account, "dummy-密-value")
    assert module.read_token(account) == "dummy-密-value"
    module.store_token(account, "replacement")
    assert module.read_token(account, interactive=False) == "replacement"
    assert interaction == [True]
    assert items == {("life-data", account): b"replacement"}
