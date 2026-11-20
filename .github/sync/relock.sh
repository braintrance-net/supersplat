#!/usr/bin/env bash
# Regenerate merged manifests with a fixed npm that preserves libc metadata.
# usage: relock.sh <fork commit> <upstream commit> (run in the work tree)
set -euo pipefail

tools="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if ! git diff --quiet "$1" -- package.json package-lock.json; then
    snapshots="$(mktemp -d)"
    trap 'rm -rf "$snapshots"' EXIT
    git show "$1:package-lock.json" > "$snapshots/fork.json"
    git show "$2:package-lock.json" > "$snapshots/upstream.json"
    # A conflicted lockfile cannot be parsed; the two parents still supply metadata.
    if node -e 'JSON.parse(require("node:fs").readFileSync("package-lock.json", "utf8"))' 2>/dev/null; then
        cp package-lock.json "$snapshots/merged.json"
    fi
    # Node 22 ships npm 10, which drops libc fields during lockfile regeneration.
    # Do not depend on the runner's bundled npm or run the candidate's scripts.
    npm exec --yes --package=npm@11.17.0 -- npm install --package-lock-only --ignore-scripts --no-audit --no-fund
    for before in "$snapshots"/*.json; do
        node "$tools/check-lock-platforms.mjs" "$before" package-lock.json
    done
fi
