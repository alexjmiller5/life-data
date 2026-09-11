import importlib.util
from pathlib import Path


def module():
    path = Path(__file__).parents[1] / "scripts" / "cf-login.py"
    spec = importlib.util.spec_from_file_location("cf_login", path)
    loaded = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(loaded)
    return loaded


class Response:
    def __init__(self, result, *, result_info=None):
        self.result = result
        self.result_info = result_info or {}

    def raise_for_status(self):
        return None

    def json(self):
        return {"success": True, "result": self.result, "result_info": self.result_info}


class Client:
    def __init__(self, responses):
        self.responses = iter(responses)
        self.calls = []

    def get(self, url, *, params=None):
        self.calls.append(("GET", url, params))
        return next(self.responses)

    def post(self, url, *, json=None):
        self.calls.append(("POST", url, json))
        return Response({"aud": "new-aud"})

    def put(self, url, *, json=None):
        self.calls.append(("PUT", url, json))
        return Response({"aud": "existing-aud"})


def test_desired_access_app_targets_only_login_with_email_otp():
    script = module()
    result = script.desired_app(
        "life-login", "https://life.example", ["alex@example.test"], "otp-id"
    )
    assert result == {
        "name": "life-login",
        "type": "self_hosted",
        "destinations": [{"type": "public", "uri": "https://life.example/login"}],
        "session_duration": "24h",
        "allowed_idps": ["otp-id"],
        "auto_redirect_to_identity": True,
        "app_launcher_visible": False,
        "policies": [
            {
                "name": "life-login allowed email",
                "decision": "allow",
                "include": [{"email": {"email": "alex@example.test"}}],
            }
        ],
    }


def test_converge_is_idempotent_and_preserves_existing_audience_on_update():
    script = module()
    want = script.desired_app("life-login", "https://life.example", ["alex@example.test"], "otp-id")
    existing = {**want, "id": "app-id", "aud": "existing-aud", "app_launcher_visible": True}
    client = Client([Response([existing]), Response([existing])])
    assert script.converge(client, "account", want, dry_run=True) == {
        "action": "update",
        "aud": "existing-aud",
    }
    assert script.converge(client, "account", want, dry_run=False) == {
        "action": "updated",
        "aud": "existing-aud",
    }
    assert client.calls[-1][2]["aud"] == "existing-aud"
