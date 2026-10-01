#!/usr/bin/env bash
# Takes one prop snapshot and saves it to the `data` branch, never touching `main`
# (so the logger can't trigger a redeploy of the server).  Run from the repo root.
set -euo pipefail

git config user.name  "props-bot"
git config user.email "props-bot@users.noreply.github.com"

WT="$(mktemp -d)"
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
if git diff --cached --quiet; then echo "Nothing new to save."; exit 0; fi
git commit -q -m "props snapshot $(date -u +%Y-%m-%dT%H:%MZ)"
git push origin HEAD:data
echo "Saved to the data branch."
