import json
from pathlib import Path

import pytest

from soma.login import valid_profile_scopes

CASES = json.loads((Path(__file__).parent / "fixtures" / "enrollment-scopes.json").read_text())[
    "cases"
]


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_profile_scope_grammar_matches_core(case):
    assert valid_profile_scopes(case["scopes"]) is case["valid"]
