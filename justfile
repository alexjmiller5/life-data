# life-data — task interface

# venv outside iCloud: on iCloud-synced dirs macOS intermittently stamps
# uv-written files UF_HIDDEN and Python 3.13+ ignores hidden .pth files,
# breaking the editable install. Always invoke uv through just.
export UV_PROJECT_ENVIRONMENT := env_var('HOME') + "/.cache/uv-venvs/life-data"

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
