import pytest


@pytest.fixture(autouse=True)
def isolated_data_home(tmp_path_factory, monkeypatch):
    """No test reaches the real data home: the CLI adopts a pre-rename data dir from it."""
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path_factory.mktemp("data-home")))
