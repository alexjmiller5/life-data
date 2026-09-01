# life-data — secrets manifest (committed; values live in 1Password).
# Local dev / admin scripts: op run --env-file=.env.tpl -- <cmd>
#
# The hub's own API token is a Worker secret (wrangler secret put HUB_TOKEN),
# not an app env var. Clients read it via config.json's token_cmd.
#
# Refs are BY NAME: op-project-bootstrap parses this file to create the vault
# and items, so IDs cannot exist yet. See the global AGENTS.md exception.

# Cloudflare API token + account for admin scripts (R2 lifecycle, deploys).
CLOUDFLARE_API_TOKEN=op://Life Data/Life Data Deploy Creds/api-token
CLOUDFLARE_ACCOUNT_ID=op://Life Data/Life Data Deploy Creds/account-id

# The hub API token, for driving the hub directly from a shell.
LIFE_HUB_TOKEN=op://Life Data/Life Data Hub Token/credential
