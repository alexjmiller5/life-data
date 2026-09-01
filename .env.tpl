# life-data — secrets manifest (committed; values live in 1Password).
# Local dev / admin scripts: op run --env-file=.env.tpl -- <cmd>
#
# Every field here is minted by scripts/provision.py — bootstrap never
# prompts for a value.
#
# Refs are BY NAME: op-project-bootstrap parses this file to create the vault
# and items, so IDs cannot exist yet. See the global AGENTS.md exception.
#
# NOT here on purpose: the hub's own API token (what clients present as a
# bearer token, and what the Worker holds as its HUB_TOKEN secret). It lives
# in the AI Agent vault because the machines' launchd sync agent reads it with
# the agent service account, which cannot see project vaults. CI never needs
# it — Worker secrets persist across deploys.

CLOUDFLARE_API_TOKEN=op://Life Data/Life Data Deploy Creds/api-token
CLOUDFLARE_ACCOUNT_ID=op://Life Data/Life Data Deploy Creds/account-id
