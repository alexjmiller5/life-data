# life-data — task interface

# run the CLI against your real data dir
run *args:
    uv run life {{args}}

test:
    uv run pytest

# all static analysis, read-only
check:
    uv run ruff check .
    uv run ruff format --check .

# auto-fix formatting and lints
fmt:
    uv run ruff format .
    uv run ruff check --fix .
