import importlib.util
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "notion_option_colors", Path(__file__).parents[1] / "scripts" / "notion-option-colors.py"
)
script = importlib.util.module_from_spec(spec)
spec.loader.exec_module(script)


def test_pairs_by_name_then_meaningful_overlap():
    choices = {"Tags (imported)": {"A": "red"}, "Activity": {"Run": "blue", "Other": "gray"}}
    assert script.pair("legacy_tags", {"A"}, choices) == ("Tags (imported)", "name")
    assert script.pair("kind", {"Run", "Other"}, choices) == ("Activity", "overlap")
    assert script.pair("race", {"Road", "Track", "Other"}, choices) is None


def test_recolors_matching_options_only():
    options = [{"v": "Done", "d": "x"}, {"v": "todo"}, {"v": "New"}]
    out, n = script.recolor(options, {"Done": "green", "To Do": "red", "TODO": "blue"})
    assert (out, n) == (
        [{"v": "Done", "d": "x", "color": "green"}, {"v": "todo", "color": "blue"}, {"v": "New"}],
        2,
    )
