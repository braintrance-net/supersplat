#!/usr/bin/env bash
# Runs Codex signed in with the ChatGPT login in the CODEX_AUTH_JSON secret (a Codex auth.json).
# usage: codex.sh <work dir> <prompt file> <output file> <sandbox> [output schema]
# Always follow it with leak-check.sh: codex-action's key proxy only takes API keys, so the login
# sits in a file the agent's own commands can read.
set -euo pipefail

dir=$1 prompt=$2 output=$3 sandbox=$4 schema=${5:-}
if [ -z "${CODEX_AUTH_JSON:-}" ]; then
	echo "::error::The CODEX_AUTH_JSON secret is not set; see .github/UPSTREAM_SYNC.md."
	exit 1
fi

export CODEX_HOME="$RUNNER_TEMP/codex-home"
mkdir -p "$CODEX_HOME"
(umask 077 && printf '%s' "$CODEX_AUTH_JSON" > "$CODEX_HOME/auth.json")
jq -r '[.. | strings | select(length >= 32)] | .[]' "$CODEX_HOME/auth.json" | while read -r token; do
	echo "::add-mask::$token"
done
unset CODEX_AUTH_JSON

npm install --prefix "$RUNNER_TEMP/codex" --no-audit --no-fund @openai/codex@0.163.0 >/dev/null

# Ubuntu 24.04 blocks the unprivileged user namespaces Codex's bubblewrap sandbox needs.
sudo -n sysctl -qw kernel.apparmor_restrict_unprivileged_userns=0 2>/dev/null || true
sudo -n sysctl -qw kernel.unprivileged_userns_clone=1 2>/dev/null || true

args=(exec --skip-git-repo-check --ephemeral --cd "$dir" --sandbox "$sandbox"
	--output-last-message "$output" --config 'model_reasoning_effort="high"')
if [ -n "$schema" ]; then
	args+=(--output-schema "$schema")
fi
# Held back from the job log until leak-check.sh has masked the tokens Codex may refresh mid-run.
"$RUNNER_TEMP/codex/node_modules/.bin/codex" "${args[@]}" < "$prompt" > "$RUNNER_TEMP/codex.log" 2>&1
