#!/bin/bash
# launchd wakes this every five minutes. The scheduler queues only planned checks.
set -u
export PATH="$HOME/.local/bin:$HOME/.local/lima/bin:/usr/bin:/bin:/usr/sbin:/sbin"
cd "$HOME/promptr-qa/monitor" || exit 1
LOG="$HOME/promptr-qa/logs/monitor.log"
{
  echo "=== $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
  while true; do
    RUN_STARTED_MS="$(node -p 'Date.now()')"
    node monitor.mjs
    RESULT=$?
    # Catch up already-planned jobs immediately instead of losing up to five
    # minutes after a long batch. Blocked/cooldown/stale status always exits.
    node next-batch.mjs "$PWD" "$RUN_STARTED_MS" || break
    sleep 1
  done
} >> "$LOG" 2>&1
# Retain enough launcher history for troubleshooting; per-job reports remain separate.
tail -n 10000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"

exit "${RESULT:-1}"
