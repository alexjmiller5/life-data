# soma — task interface

# venv outside iCloud: on iCloud-synced dirs macOS intermittently stamps
# uv-written files UF_HIDDEN and Python 3.13+ ignores hidden .pth files,
# breaking the editable install. Always invoke uv through just.
export UV_PROJECT_ENVIRONMENT := env_var('HOME') + "/.cache/uv-venvs/soma"

# run the CLI against your real data dir
run *args:
    uv run soma {{args}}

test:
    uv run pytest
    # subprocess SQLite fixtures (worker/test/limited-d1.js) outlast bun's 5 s
    # default timeout on a loaded host
    cd worker && bun test --timeout 60000
    cd core && bun test

# all static analysis, read-only
check:
    uv run ruff check .
    uv run ruff format --check .
    cd core && bun run check

# auto-fix formatting and lints
fmt:
    uv run ruff format .
    uv run ruff check --fix .

# deploy the hub (CI does this on push to main; local runs are break-glass)
deploy:
    cd worker && bunx wrangler@4 deploy
