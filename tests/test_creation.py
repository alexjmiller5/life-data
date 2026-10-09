import json
from pathlib import Path

import pytest

from soma.creation import validate_creation_receipt, validate_creation_session

CASES = json.loads((Path(__file__).parent / "fixtures/creation-boundary.json").read_text())


@pytest.mark.parametrize("case", CASES, ids=lambda case: case["name"])
def test_canonical_creation_boundary(case):
    if case["kind"] == "receipt":
        result = validate_creation_receipt(case["request"], case["reply"])
        assert (result is not None) == case["accept"]
        if case["accept"]:
            assert result == case["reply"]["data"]
    else:
        assert (
            validate_creation_session(case["reply"], case["expected"], case["expectedScopes"])
            == case["accept"]
        )
