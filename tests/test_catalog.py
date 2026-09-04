import json
import re
from pathlib import Path

import pytest

from life_data import connect, create_table, execute_sql, init, insert_rows
from life_data.catalog import (
    ValidationError,
    Violation,
    audit,
    check,
    check_rule_sql,
    derive,
    doc,
    ensure_catalog,
    has_catalog,
    infer,
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


def test_derive_skips_rows_deleted_before_write(db):
    _movies(db)
    insert_rows(
        db,
        "movies",
        [{"id": "m1", "title": "a", "tmdb_id": "1"}, {"id": "m2", "title": "b", "tmdb_id": "2"}],
    )
    derive(db, "movies", "slug")
    execute_sql(db, "UPDATE movies SET deleted_at = updated_at WHERE id = 'm1'")
    import sqlite3

    conn = sqlite3.connect(db)
    conn.execute("DELETE FROM movies WHERE id = 'm2'")
    conn.commit()
    conn.close()
    assert derive(db, "movies", "slug", where="id IN ('m1', 'm2')") == 0


def test_cmd_derivation_returning_no_columns_is_skipped(db, tmp_path):
    _movies(db)
    script = tmp_path / "empty.py"
    script.write_text("import sys,json\nsys.stdin.read()\nprint(json.dumps({}))\n")
    insert_rows(db, "movies", [{"id": "m1", "title": "x", "tmdb_id": "78"}])
    assert derive(db, "movies", "genres", commands={"tmdb": f"python3 {script}"}) == 0
    assert execute_sql(db, "SELECT genres FROM movies")[0]["genres"] is None
    assert execute_sql(db, "SELECT * FROM provenance") == []


# --- audit --------------------------------------------------------------------


def test_audit_runs_command_and_reports_findings(db, tmp_path):
    script = tmp_path / "check_tmdb.py"
    script.write_text(
        "import json\nprint(json.dumps([{'tbl':'movies','row_id':'m1','col':'title','message':'not TMDB-exact'}]))\n"
    )
    set_rule(
        db,
        "tmdb-exact",
        scope="table",
        tbl="movies",
        kind="audit",
        cmd="tmdb-exact",
        text="Titles must be TMDB-exact",
    )
    findings = audit(db, commands={"tmdb-exact": f"python3 {script}"})
    assert findings == [
        {
            "tbl": "movies",
            "row_id": "m1",
            "col": "title",
            "rule": "tmdb-exact",
            "message": "not TMDB-exact",
        }
    ]


def test_audit_raises_without_configured_command(db):
    set_rule(
        db, "tmdb-exact", scope="table", tbl="movies", kind="audit", cmd="tmdb-exact", text="x"
    )
    with pytest.raises(RuntimeError, match="no command configured"):
        audit(db)


def test_audit_filters_by_rule_id(db, tmp_path):
    script = tmp_path / "ok.py"
    script.write_text("import json\nprint(json.dumps([]))\n")
    set_rule(db, "a", scope="table", tbl="movies", kind="audit", cmd="a", text="a")
    set_rule(db, "b", scope="table", tbl="movies", kind="audit", cmd="b", text="b")
    assert audit(db, rule_id="a", commands={"a": f"python3 {script}"}) == []


# --- infer ----------------------------------------------------------------


def test_infer_proposes_required_select_date_url_ref(db):
    create_table(db, "people", ["name:text"])
    insert_rows(db, "people", [{"id": f"p{i}", "name": f"n{i}"} for i in range(25)])
    create_table(
        db, "places", ["name:text", "status:text", "went:text", "url:text", "who:text", "tags:text"]
    )
    insert_rows(
        db,
        "places",
        [
            {
                "name": f"x{i}",
                "status": ("want", "been")[i % 2],
                "went": f"2026-01-{i + 1:02d}",
                "url": f"https://maps.app.goo.gl/{i}",
                "who": f"p{i}",
                "tags": ["bar"] if i % 3 else ["cafe"],
            }
            for i in range(25)
        ],
    )
    props = {p["col"]: p for p in infer(db, "places")}
    assert props["name"]["required"] == 1 and props["name"]["type"] == "text"
    assert props["status"]["type"] == "select" and {o["v"] for o in props["status"]["options"]} == {
        "want",
        "been",
    }
    assert props["went"]["type"] == "date"
    assert props["url"]["type"] == "url" and props["url"]["pattern"].startswith("^https://")
    assert props["who"] == {
        "tbl": "places",
        "col": "who",
        "type": "ref",
        "ref_table": "people",
        "required": 1,
    }
    assert props["tags"]["type"] == "multi_select" and {
        o["v"] for o in props["tags"]["options"]
    } == {"bar", "cafe"}


def test_infer_skips_cataloged_columns_and_small_tables(db):
    create_table(db, "places", ["name:text"])
    insert_rows(db, "places", [{"name": "a"}])
    assert infer(db, "places") == []


# --- doc ------------------------------------------------------------------


def test_doc_renders_tables_properties_and_rules(db):
    set_table(db, "places", kind="table", purpose="somewhere real", id_semantics="Google place_id")
    set_property(
        db,
        "places",
        "status",
        type="select",
        required=1,
        sort=1,
        options=[{"v": "want", "d": "saved"}, {"v": "been"}],
        description="lowercase",
    )
    set_property(
        db, "places", "slug", type="text", sort=2, derived_by="sql:lower(name)", inputs=["name"]
    )
    set_rule(db, "estate-soft-delete", scope="estate", kind="doctrine", text="soft delete only")
    with connect(db) as conn:
        md = doc(conn)
    assert "### places" in md and "somewhere real" in md and "Google place_id" in md
    assert "| status | select | yes | `want` (saved), `been` | lowercase |" in md
    assert "derived by `sql:lower(name)` from name" in md
    assert "## Estate rules" in md and "soft delete only" in md
    with connect(db) as conn:
        assert doc(conn) == md  # deterministic


def test_doc_scoped_to_one_table_omits_estate_rules(db):
    set_table(db, "places", kind="table", purpose="somewhere real")
    set_table(db, "movies", kind="table", purpose="watched films")
    set_rule(db, "estate-soft-delete", scope="estate", kind="doctrine", text="soft delete only")
    with connect(db) as conn:
        md = doc(conn, "places")
    assert "### places" in md and "### movies" not in md
    assert "## Estate rules" not in md


def test_doc_escapes_pipe_in_cells(db):
    set_property(db, "places", "status", type="text", description="a | b")
    with connect(db) as conn:
        md = doc(conn)
    rows = [line for line in md.splitlines() if line.startswith("| status")]
    assert rows == ["| status | text |  |  | a \\| b |"]
    cells = re.split(r"(?<!\\)\|", rows[0])[1:-1]  # drop the leading/trailing empty splits
    assert len(cells) == 5


def test_infer_ref_prefers_tightest_fitting_table(db):
    # created first, so sqlite_master order alone would pick it over people
    create_table(db, "everything", ["name:text"])
    insert_rows(db, "everything", [{"id": f"p{i}", "name": f"n{i}"} for i in range(50)])
    create_table(db, "people", ["name:text"])
    insert_rows(db, "people", [{"id": f"p{i}", "name": f"n{i}"} for i in range(25)])
    create_table(db, "places", ["who:text"])
    insert_rows(db, "places", [{"who": f"p{i}"} for i in range(25)])
    props = {p["col"]: p for p in infer(db, "places")}
    assert props["who"]["ref_table"] == "people"


# --- write-path escapes and temp-table safety --------------------------------


def test_cte_write_is_validated(db):
    create_table(db, "places", ["name:text", "status:select(want|been)"])
    with pytest.raises(ValidationError):
        execute_sql(
            db,
            "WITH v(n,s) AS (VALUES('x','TOTALLY_BAD')) "
            "INSERT INTO places (name,status) SELECT n,s FROM v",
        )
    assert execute_sql(db, "SELECT count(*) AS c FROM places")[0]["c"] == 0


def test_cte_read_still_works(db):
    create_table(db, "places", ["name:text"])
    insert_rows(db, "places", [{"id": "p1", "name": "x"}])
    rows = execute_sql(db, "WITH v AS (SELECT name FROM places) SELECT * FROM v")
    assert [r["name"] for r in rows] == ["x"]


def test_temp_context_never_drops_a_user_table_named_changed(db):
    create_table(db, "changed", ["name:text"])
    create_table(db, "notes", ["body:text"])
    insert_rows(db, "changed", [{"id": "c1", "name": "keep"}])
    set_rule(
        db,
        "r",
        scope="table",
        tbl="notes",
        kind="invariant",
        enforce=1,
        text="x",
        sql="SELECT id FROM changed WHERE 0",
    )
    insert_rows(db, "notes", [{"id": "n1", "body": "b"}])
    assert [r["name"] for r in execute_sql(db, "SELECT name FROM changed")] == ["keep"]


def test_inputs_hash_renders_reals_the_way_sqlite_stored_them(db):
    import hashlib

    create_table(db, "orders", ["qty:number"])
    insert_rows(db, "orders", [{"id": "o1", "qty": 4}])
    with connect(db) as conn:
        assert inputs_hash(conn, "orders", "o1", ["qty"]) == hashlib.sha256(b'["4.0"]').hexdigest()
        assert value_hash(conn, "orders", "o1", "qty") == hashlib.sha256(b"4.0").hexdigest()


def test_check_reports_orphan_provenance_after_a_hard_delete(db):
    import sqlite3 as s

    _movies(db)
    insert_rows(db, "movies", [{"id": "m1", "title": "x", "tmdb_id": "78"}])
    derive(db, "movies", "slug")
    conn = s.connect(db)
    conn.execute("DELETE FROM movies WHERE id = 'm1'")
    conn.commit()
    conn.close()
    findings = check(db)
    assert ("m1", "orphan") in {(f["row_id"], f["rule"]) for f in findings}


def test_set_rule_requires_sql_for_an_invariant(db):
    create_table(db, "places", ["status:text"])
    with pytest.raises(ValueError, match="sql"):
        set_rule(db, "r", scope="table", tbl="places", kind="invariant", enforce=1, text="x")


def test_check_reports_rule_error_instead_of_crashing(db):
    import sqlite3 as s

    create_table(db, "places", ["status:text"])
    set_rule(
        db,
        "r",
        scope="table",
        tbl="places",
        kind="invariant",
        enforce=0,
        text="x",
        sql="SELECT id FROM places WHERE status = 'z'",
    )
    conn = s.connect(db)
    conn.execute("DROP TABLE places")
    conn.commit()
    conn.close()
    errs = [f for f in check(db) if f["rule"] == "rule-error"]
    assert errs and errs[0]["message"].startswith("r failed to run:")


def test_enforced_invariant_runs_for_a_table_with_no_properties(db):
    execute_sql(
        db,
        "CREATE TABLE widgets (id TEXT PRIMARY KEY, kind TEXT, "
        "created_at TEXT, updated_at TEXT, deleted_at TEXT)",
    )
    set_rule(
        db,
        "no-bad",
        scope="table",
        tbl="widgets",
        kind="invariant",
        enforce=1,
        text="kind must not be bad",
        sql="SELECT id FROM widgets WHERE kind = 'bad'",
    )
    with pytest.raises(ValidationError, match="kind must not be bad"):
        execute_sql(
            db,
            "INSERT INTO widgets (id, kind, updated_at) "
            "VALUES ('w1','bad','2026-01-01T00:00:00.000Z')",
        )
    assert execute_sql(db, "SELECT count(*) AS c FROM widgets")[0]["c"] == 0


def test_set_rule_rejects_an_enforced_estate_invariant(db):
    create_table(db, "places", ["status:text"])
    with pytest.raises(ValueError, match="estate"):
        set_rule(
            db,
            "r",
            scope="estate",
            kind="invariant",
            enforce=1,
            text="x",
            sql="SELECT id FROM places WHERE 0",
        )


def test_unenforced_rule_on_a_legacy_table_does_not_break_other_writes(db):
    create_table(db, "places", ["name:text"])
    execute_sql(db, "CREATE TABLE legacy (k TEXT)")  # no id/updated_at
    set_rule(
        db,
        "legacy-r",
        scope="table",
        tbl="legacy",
        kind="invariant",
        enforce=0,
        text="x",
        sql="SELECT k FROM legacy WHERE k = 'bad'",
    )
    insert_rows(db, "places", [{"id": "p1", "name": "ok"}])
    assert execute_sql(db, "SELECT count(*) AS c FROM places")[0]["c"] == 1


def test_set_rule_rejects_enforcing_a_table_without_sync_columns(db):
    execute_sql(db, "CREATE TABLE legacy (k TEXT)")
    with pytest.raises(ValueError, match="sync columns"):
        set_rule(
            db,
            "legacy-r",
            scope="table",
            tbl="legacy",
            kind="invariant",
            enforce=1,
            text="x",
            sql="SELECT k FROM legacy WHERE k = 'bad'",
        )
