#!/bin/bash
# Nightly one-way sync of Aoife's planner -> the "Aoife's School" Google Calendar.
# Runs from launchd (com.jalal.aoife-gcal-sync) at 04:10 — overnight window per
# the house rule. Nothing secret is sourced here: the sync reads the Google
# service-account key from ~/.config/mcp-google-sheets/service-account.json,
# which is a PATH, not a value, and is never echoed.
set -u
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

cd "$DIR" || { echo "GCAL-SYNC FAIL $(date +%F) cannot-cd-to-script-dir"; exit 1; }
echo "── $(date '+%F %T') gcal-sync ──"

# --frozen: run exactly the locked dependency set, never re-resolve at 4 AM.
uv run --frozen --quiet gcal-sync "$@"
rc=$?
[ "$rc" != 0 ] && echo "GCAL-SYNC FAIL $(date +%F) wrapper-exit-$rc"
exit "$rc"
