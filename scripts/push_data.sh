#!/usr/bin/env bash
# Takes one prop snapshot and saves it to the `data` branch, never touching `main`.
set -euo pipefail

# Create temp worktree directory and register automatic cleanup on exit
WT="$(mktemp -d)"
trap 'git worktree remove --force "$WT" 2>/dev/null \vert{}\vert{} rm -rf "$WT"' EXIT

git config user.name "props-bot"
git config user.email "props-bot@users.noreply.github.com"

if git ls-remote --exit-code --heads origin data >/dev/null 2>&1; then
  git fetch --depth=1 origin data
  git worktree add --detach "$WT" FETCH_HEAD
else
  echo "No data branch yet - creating it."
  git worktree add --detach "$WT"
  ( cd "$WT" && git checkout -q --orphan data && git rm -rfq . )
fi

PROP_OUT="$WT/props_log.csv" node scripts/log_props.mjs

cd "$WT"
git add props_log.csv 2>/dev/null || true
if git diff --cached --quiet; then
  echo "Nothing new to save."
  exit 0
fi

git commit -q -m "props snapshot $(date -u +%Y-%m-%dT%H:%MZ)"
git push origin HEAD:data
echo "Saved to the data branch."
