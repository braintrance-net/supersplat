#!/usr/bin/env bash
# Fails the job when any token from the ChatGPT login, as stored or as Codex refreshed it, appears in
# a file, file name or symlink target the job could commit or upload, or in Codex's log. Prints that
# log once the tokens are masked, and deletes the login either way.
# usage: leak-check.sh <dir>...
# Only catches the token verbatim; an encoded copy gets past it (accepted in UPSTREAM_SYNC.md).
set -euo pipefail

home="$RUNNER_TEMP/codex-home"
log="$RUNNER_TEMP/codex.log"
list="$RUNNER_TEMP/codex-tokens"
trap 'rm -rf "$home" "$list" "$log"' EXIT

{
	if [ -n "${CODEX_AUTH_JSON:-}" ]; then
		printf '%s' "$CODEX_AUTH_JSON" | jq -r '[.. | strings | select(length >= 32)] | .[]' 2>/dev/null || true
	fi
	if [ -f "$home/auth.json" ]; then
		jq -r '[.. | strings | select(length >= 32)] | .[]' "$home/auth.json" 2>/dev/null || true
	fi
} | sort -u > "$list"
while read -r token; do
	echo "::add-mask::$token"
done < "$list"

leaked=""
if [ -s "$list" ]; then
	leaked="$(
		grep -rlF -f "$list" "$@" 2>/dev/null || true
		if [ -f "$log" ]; then
			grep -lF -f "$list" "$log" || true
		fi
		{
			find "$@" -print
			find "$@" -type l -exec readlink {} \;
		} 2>/dev/null | grep -F -f "$list" >/dev/null && echo "(a file name or symlink target)"
	)" || true
fi
if [ -n "$leaked" ]; then
	echo "::error::The ChatGPT login token was written to these places; nothing from this run is kept:"
	echo "$leaked"
	exit 1
fi

if [ -f "$log" ]; then
	echo "::group::Codex log"
	cat "$log"
	echo "::endgroup::"
fi
