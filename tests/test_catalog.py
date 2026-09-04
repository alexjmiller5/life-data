import json
from pathlib import Path

import pytest

from life_data import connect, create_table, execute_sql, init, insert_rows
from life_data.catalog import (
    ValidationError,
    Violation,
    check,
    check_rule_sql,
    derive,
    ensure_catalog,
    has_catalog,
    inputs_hash,
    properties,
    rm_property,
    rm_rule,
    rules,
    run_invariant,
    set_property,
    set_rule,
    set_table,
    validate_row,
    value_hash,
)


@pytest.fixture()
def db(tmp_path):
    return init(tmp_path / "life.db")


def test_ensure_catalog_creates_logged_tables(db):
    ensure_catalog(db)
    names = {
        r["name"] for r in execute_sql(db, "SELECT name FROM sqlite_master WHERE type='table'")
    }
    assert {
        "catalog_tables",
        "catalog_properties",
        "catalog_rules",
        "provenance",
        "catalog_log",
    } <= names
    ddls = [r["ddl"] for r in execute_sql(db, "SELECT ddl FROM _schema_log")]
    assert any("catalog_properties" in d for d in ddls)
    ensure_catalog(db)  # idempotent
    assert len([d for d in ddls if "CREATE TABLE catalog_properties" in d]) == 1


def test_has_catalog_false_on_fresh_db(db):
    with connect(db) as conn:
        assert has_catalog(conn) is False
    ensure_catalog(db)
    with connect(db) as conn:
        assert has_catalog(conn) is True


def test_set_property_upserts_and_parses(db):
    set_property(
        db,
        "places",
        "status",
        type="select",
        required=1,
        options=[{"v": "want"}, {"v": "been", "d": "confirmed"}],
    )
    set_property(db, "places", "status", description="lowercase")
    with connect(db) as conn:
        props = properties(conn, "places")
    assert len(props) == 1
    p = props[0]
    assert p["id"] == "places.status" and p["type"] == "select" and p["required"] == 1
    assert p["options"][1] == {"v": "been", "d": "confirmed"}
    assert p["description"] == "lowercase"


def test_set_property_rejects_unknown_type(db):
    with pytest.raises(ValueError, match="type"):
        set_property(db, "places", "x", type="blob")


def test_rm_property_soft_deletes(db):
    set_property(db, "places", "status", type="text")
    rm_property(db, "places", "status")
    with connect(db) as conn:
        assert properties(conn, "places") == []
    row = execute_sql(db, "SELECT deleted_at FROM catalog_properties WHERE id='places.status'")[0]
    assert row["deleted_at"] is not None


def test_set_rule_and_set_table(db):
    set_rule(db, "estate-soft-delete", scope="estate", kind="doctrine", text="soft delete only")
    set_table(db, "places", kind="table", purpose="somewhere real")
    with connect(db) as conn:
        assert rules(conn, kind="doctrine")[0]["id"] == "estate-soft-delete"
    t = execute_sql(db, "SELECT purpose FROM catalog_tables WHERE id='places'")[0]
    assert t["purpose"] == "somewhere real"


def test_set_rule_with_no_fields_revives_existing_row(db):
    set_rule(db, "r1", scope="estate", kind="doctrine", text="x")
    rm_rule(db, "r1")
    set_rule(db, "r1")
    with connect(db) as conn:
        revived = rules(conn)[0]
    assert revived["id"] == "r1" and revived["text"] == "x"
    log = execute_sql(db, "SELECT action FROM catalog_log WHERE row_id = 'r1' ORDER BY created_at")
    assert log[-1]["action"] == "set"


def test_catalog_writes_are_logged(db):
    set_property(db, "places", "status", type="text")
    set_rule(db, "r1", scope="estate", kind="doctrine", text="x")
    log = execute_sql(db, "SELECT tbl, row_id, action FROM catalog_log ORDER BY created_at")
    assert log[0] == {"tbl": "catalog_properties", "row_id": "places.status", "action": "set"}
    assert log[1] == {"tbl": "catalog_rules", "row_id": "r1", "action": "set"}


FIXTURE = Path(__file__).parent / "fixtures" / "validation-cases.json"
CASES = json.loads(FIXTURE.read_text())


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_validate_row_conformance(case):
    refs = case.get("refs", {})
    extra = case.get("extra_options", {})
    got = validate_row(
        case["properties"],
        case["before"],
        case["after"],
        in_derive=set(case.get("in_derive", [])),
        ref_ok=lambda t, i: i in refs.get(t, []),
        extra_options=lambda p: extra.get(p["col"], []),
    )
    assert [{"col": v.col, "rule": v.rule} for v in got] == case["expect"]


def test_violation_message_names_allowed_values():
    props = [
        {"tbl": "t", "col": "status", "type": "select", "options": [{"v": "want"}, {"v": "been"}]}
    ]
    v = validate_row(props, None, {"id": "a", "status": "Been"})[0]
    assert isinstance(v, Violation)
    assert v.tbl == "t" and v.row_id == "a"
    assert "want, been" in v.message


# --- write path ---------------------------------------------------------------


def _places(db):
    create_table(db, "places", ["name:text", "status:text", "tags:text", "gmaps_url:text"])
    set_property(db, "places", "name", type="text", required=1)
    set_property(
        db,
        "places",
        "status",
        type="select",
        required=1,
        default_value="want",
        options=[{"v": "want"}, {"v": "priority"}, {"v": "been"}],
    )
    set_property(db, "places", "tags", type="multi_select", options=[{"v": "bar"}, {"v": "cafe"}])


def test_insert_violation_rolls_back_whole_statement(db):
    _places(db)
    with pytest.raises(ValidationError) as ei:
        insert_rows(
            db, "places", [{"name": "Casa", "status": "want"}, {"name": "Bad", "status": "Been"}]
        )
    assert ei.value.violations[0].col == "status" and ei.value.violations[0].rule == "options"
    assert execute_sql(db, "SELECT count(*) AS n FROM places")[0]["n"] == 0


def test_update_via_sql_is_validated(db):
    _places(db)
    insert_rows(db, "places", [{"name": "Casa", "status": "want"}])
    with pytest.raises(ValidationError, match="not an option"):
        execute_sql(db, "UPDATE places SET status = 'visited'")
    assert execute_sql(db, "SELECT status FROM places")[0]["status"] == "want"


def test_only_changed_rows_are_validated(db):
    create_table(db, "places", ["name:text", "status:text"])
    insert_rows(db, "places", [{"id": "old", "name": "legacy", "status": "Weird"}])
    set_property(db, "places", "status", type="select", options=[{"v": "want"}])
    insert_rows(db, "places", [{"id": "new", "name": "n", "status": "want"}])
    execute_sql(db, "UPDATE places SET name = 'renamed' WHERE id = 'new'")  # legacy row untouched
    assert execute_sql(db, "SELECT name FROM places WHERE id='new'")[0]["name"] == "renamed"
    with pytest.raises(ValidationError):
        execute_sql(
            db, "UPDATE places SET name = 'touch' WHERE id = 'old'"
        )  # touching it forces the fix


def test_defaults_apply_on_insert(db):
    _places(db)
    insert_rows(db, "places", [{"name": "Casa"}])
    assert execute_sql(db, "SELECT status FROM places")[0]["status"] == "want"


def test_sql_default_is_evaluated(db):
    import re

    create_table(db, "tasks", ["title:text", "due:text"])
    set_property(db, "tasks", "due", type="date", default_value="sql:date('now')")
    insert_rows(db, "tasks", [{"title": "x"}])
    assert re.fullmatch(r"\d{4}-\d{2}-\d{2}", execute_sql(db, "SELECT due FROM tasks")[0]["due"])


def test_ref_checks_target_table(db):
    create_table(db, "people", ["name:text"])
    insert_rows(db, "people", [{"id": "p1", "name": "Ada"}])
    create_table(db, "links", ["person:text"])
    set_property(db, "links", "person", type="ref", ref_table="people")
    insert_rows(db, "links", [{"person": "p1"}])
    with pytest.raises(ValidationError, match="No people row"):
        insert_rows(db, "links", [{"person": "p9"}])


def test_options_sql_extends_allowlist(db):
    create_table(db, "place_tags", ["name:text"])
    insert_rows(db, "place_tags", [{"name": "sports bar"}])
    create_table(db, "tasks", ["tag:text"])
    set_property(
        db,
        "tasks",
        "tag",
        type="select",
        options=[{"v": "chore"}],
        options_sql="SELECT name FROM place_tags WHERE deleted_at IS NULL",
    )
    insert_rows(db, "tasks", [{"tag": "sports bar"}])
    with pytest.raises(ValidationError):
        insert_rows(db, "tasks", [{"tag": "dive bar"}])


def test_reads_are_not_wrapped(db):
    _places(db)
    assert execute_sql(db, "SELECT 1 AS one") == [{"one": 1}]


def test_uncataloged_table_is_unconstrained(db):
    _places(db)
    create_table(db, "scratch", ["v:text"])
    insert_rows(db, "scratch", [{"v": "anything"}])


def test_engine_tables_are_never_validated_against_themselves(db):
    _places(db)
    set_property(db, "catalog_properties", "type", type="select", options=[{"v": "text"}])
    set_property(
        db, "places", "extra", type="url"
    )  # would fail if catalog_properties were validated


# --- invariants -----------------------------------------------------------


def test_rule_sql_rejects_nondeterminism():
    for bad in ("SELECT random()", "SELECT datetime('now')", "SELECT date('now','localtime')"):
        with pytest.raises(ValueError):
            check_rule_sql(bad)
    check_rule_sql("SELECT id FROM t WHERE x > (SELECT ts FROM now)")


def test_set_rule_compiles_invariant(db):
    with pytest.raises(ValueError, match="no such table"):
        set_rule(
            db,
            "bad",
            scope="table",
            tbl="places",
            kind="invariant",
            enforce=1,
            sql="SELECT id FROM nope",
        )


def test_enforced_invariant_blocks_write(db):
    create_table(db, "places", ["category:text", "tags:text"])
    set_property(db, "places", "tags", type="multi_select", options=[{"v": "bar"}, {"v": "cafe"}])
    set_property(db, "places", "category", type="select", options=[{"v": "bar"}, {"v": "cafe"}])
    set_rule(
        db,
        "cat-in-tags",
        scope="table",
        tbl="places",
        kind="invariant",
        enforce=1,
        text="Category must be one of the tags.",
        sql="SELECT id FROM places WHERE deleted_at IS NULL AND category IS NOT NULL "
        "AND NOT EXISTS (SELECT 1 FROM json_each(tags) WHERE value = places.category)",
    )
    insert_rows(db, "places", [{"category": "bar", "tags": ["bar"]}])
    with pytest.raises(ValidationError, match="Category must be one of the tags"):
        insert_rows(db, "places", [{"category": "cafe", "tags": ["bar"]}])


def test_unenforced_invariant_does_not_block(db):
    create_table(db, "places", ["category:text", "tags:text"])
    set_property(db, "places", "category", type="text")
    set_rule(
        db,
        "cat-in-tags",
        scope="table",
        tbl="places",
        kind="invariant",
        enforce=0,
        text="x",
        sql="SELECT id FROM places WHERE category = 'zzz'",
    )
    insert_rows(db, "places", [{"category": "zzz", "tags": "[]"}])


def test_transition_rule_uses_before_and_changed(db):
    create_table(db, "places", ["status:text"])
    set_property(db, "places", "status", type="select", options=[{"v": "want"}, {"v": "been"}])
    set_rule(
        db,
        "no-unbeen",
        scope="table",
        tbl="places",
        kind="invariant",
        enforce=1,
        text="A been place never goes back to want.",
        sql="SELECT c.id FROM changed c JOIN before b ON b.id = c.id "
        "WHERE b.status = 'been' AND c.status = 'want'",
    )
    insert_rows(db, "places", [{"id": "x", "status": "want"}])
    execute_sql(db, "UPDATE places SET status = 'been' WHERE id = 'x'")
    with pytest.raises(ValidationError, match="never goes back"):
        execute_sql(db, "UPDATE places SET status = 'want' WHERE id = 'x'")


def test_now_is_injected_not_read(db):
    create_table(db, "tasks", ["due:text"])
    set_property(db, "tasks", "due", type="date")
    set_rule(
        db,
        "not-past",
        scope="table",
        tbl="tasks",
        kind="invariant",
        enforce=0,
        text="due in the past",
        sql="SELECT id FROM tasks WHERE due < substr((SELECT ts FROM now), 1, 10)",
    )
    insert_rows(db, "tasks", [{"id": "a", "due": "2001-01-01"}])
    with connect(db) as conn:
        rule = rules(conn, kind="invariant")[0]
        assert run_invariant(conn, rule, now="2000-01-01T00:00:00.000Z") == []
        assert [r["id"] for r in run_invariant(conn, rule, now="2026-01-01T00:00:00.000Z")] == ["a"]


def test_ddl_recompiles_rules(db):
    create_table(db, "places", ["category:text"])
    set_rule(
        db,
        "r",
        scope="table",
        tbl="places",
        kind="invariant",
        enforce=1,
        text="x",
        sql="SELECT id FROM places WHERE category = 'z'",
    )
    with pytest.raises(ValidationError, match="no longer compiles"):
        execute_sql(db, "ALTER TABLE places RENAME COLUMN category TO cat")


def test_before_and_changed_share_shape_for_set_ops(db):
    create_table(db, "places", ["status:text"])
    set_property(db, "places", "status", type="text")
    set_rule(
        db,
        "frozen",
        scope="table",
        tbl="places",
        kind="invariant",
        enforce=1,
        text="rows may not change",
        sql="SELECT id FROM (SELECT * FROM before EXCEPT SELECT * FROM changed)",
    )
    insert_rows(db, "places", [{"id": "x", "status": "a"}])
    execute_sql(db, "UPDATE places SET status = 'z' WHERE id = 'nope'")  # touches no row
    with pytest.raises(ValidationError, match="rows may not change"):
        execute_sql(db, "UPDATE places SET status = 'b' WHERE id = 'x'")


def test_dropped_table_recompile_raises_validation_not_sqlite_error(db):
    create_table(db, "places", ["status:text"])
    set_rule(
        db,
        "watch",
        scope="table",
        tbl="places",
        kind="invariant",
        enforce=1,
        text="x",
        sql="SELECT id FROM changed",
    )
    with pytest.raises(ValidationError, match="no longer compiles"):
        execute_sql(db, "DROP TABLE places")


# --- check ------------------------------------------------------------------


def test_check_reports_legacy_violations_and_unenforced_rules(db):
    create_table(db, "places", ["status:text"])
    insert_rows(db, "places", [{"id": "old", "status": "Weird"}])
    set_property(db, "places", "status", type="select", options=[{"v": "want"}])
    set_rule(
        db,
        "r",
        scope="table",
        tbl="places",
        kind="invariant",
        enforce=0,
        text="no old",
        sql="SELECT id FROM places WHERE id = 'old'",
    )
    findings = check(db)
    assert {(f["row_id"], f["rule"]) for f in findings} == {("old", "options"), ("old", "r")}


def test_cli_check_exit_code(monkeypatch, tmp_path, capsys):
    monkeypatch.setenv("LIFE_DATA_DIR", str(tmp_path))
    from life_data import main

    main(["init"])
    main(["table", "create", "pets", "name:text"])
    assert main(["check"]) == 0
    main(["property", "set", "pets.name", "--type", "select", "--options", "cat,dog"])
    import sqlite3 as s

    s.connect(tmp_path / "life.db").execute(
        "INSERT INTO pets (name) VALUES ('rat')"
    ).connection.commit()
    capsys.readouterr()  # discard prior commands' stdout; isolate this check's output
    assert main(["check"]) == 1
    assert json.loads(capsys.readouterr().out)[0]["rule"] == "options"


# --- derivations & provenance -------------------------------------------------


def _movies(db):
    create_table(db, "movies", ["title:text", "tmdb_id:text", "genres:text", "slug:text"])
    set_property(db, "movies", "tmdb_id", type="text", required=1)
    set_property(db, "movies", "genres", type="json", derived_by="cmd:tmdb", inputs=["tmdb_id"])
    set_property(
        db,
        "movies",
        "slug",
        type="text",
        derived_by="sql:lower(replace(title, ' ', '-'))",
        inputs=["title"],
    )


def test_sql_derivation_writes_value_and_provenance(db):
    _movies(db)
    insert_rows(db, "movies", [{"id": "m1", "title": "Blade Runner", "tmdb_id": "78"}])
    assert derive(db, "movies", "slug") == 1
    assert execute_sql(db, "SELECT slug FROM movies")[0]["slug"] == "blade-runner"
    prov = execute_sql(db, "SELECT * FROM provenance WHERE id = 'movies:m1:slug'")[0]
    with connect(db) as conn:
        assert prov["inputs_hash"] == inputs_hash(conn, "movies", "m1", ["title"])
        assert prov["value_hash"] == value_hash(conn, "movies", "m1", "slug")


def test_cmd_derivation_runs_command_with_inputs(db, tmp_path):
    _movies(db)
    script = tmp_path / "tmdb.py"
    script.write_text(
        "import json,sys\nd=json.load(sys.stdin)\n"
        "print(json.dumps({'genres': ['Sci-Fi'], '_source_ref': 'tmdb:'+d['inputs']['tmdb_id']}))\n"
    )
    insert_rows(db, "movies", [{"id": "m1", "title": "x", "tmdb_id": "78"}])
    assert derive(db, "movies", "genres", commands={"tmdb": f"python3 {script}"}) == 1
    assert json.loads(execute_sql(db, "SELECT genres FROM movies")[0]["genres"]) == ["Sci-Fi"]
    assert execute_sql(db, "SELECT source_ref FROM provenance")[0]["source_ref"] == "tmdb:78"


def test_hand_edit_to_derived_column_is_rejected(db):
    _movies(db)
    insert_rows(db, "movies", [{"id": "m1", "title": "x", "tmdb_id": "78"}])
    derive(db, "movies", "slug")
    with pytest.raises(ValidationError, match="derived"):
        execute_sql(db, "UPDATE movies SET slug = 'hand' WHERE id = 'm1'")


def test_check_reports_stale_and_underived(db):
    _movies(db)
    insert_rows(db, "movies", [{"id": "m1", "title": "x", "tmdb_id": "78"}])
    derive(db, "movies", "slug")
    execute_sql(db, "UPDATE movies SET title = 'y' WHERE id = 'm1'")  # input changed
    rules_hit = {(f["col"], f["rule"]) for f in check(db)}
    assert ("slug", "stale") in rules_hit and ("genres", "underived") in rules_hit


def test_cmd_derived_column_cannot_be_required(db):
    create_table(db, "movies", ["genres:text"])
    with pytest.raises(ValueError, match="required"):
        set_property(
            db, "movies", "genres", type="json", required=1, derived_by="cmd:tmdb", inputs=[]
        )


def test_derive_where_filters(db):
    _movies(db)
    insert_rows(
        db,
        "movies",
        [{"id": "m1", "title": "a", "tmdb_id": "1"}, {"id": "m2", "title": "b", "tmdb_id": "2"}],
    )
    assert derive(db, "movies", "slug", where="id = 'm2'") == 1
    assert execute_sql(db, "SELECT slug FROM movies WHERE id='m1'")[0]["slug"] is None
