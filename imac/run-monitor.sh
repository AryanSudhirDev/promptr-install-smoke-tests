#!/bin/bash
# launchd wakes this every five minutes. The scheduler queues only planned checks.
set -u
export PATH="$HOME/.local/bin:$HOME/.local/lima/bin:/usr/bin:/bin:/usr/sbin:/sbin"
cd "$HOME/promptr-qa/monitor" || exit 1
LOG="$HOME/promptr-qa/logs/monitor.log"
{
  echo "=== $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
  if ! docker info >/dev/null 2>&1; then
    colima start --vm-type vz --cpu 4 --memory 6 --disk 10 || exit 1
  fi
  node monitor.mjs
} >> "$LOG" 2>&1
# Retain enough launcher history for troubleshooting; per-job reports remain separate.
tail -n 10000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
