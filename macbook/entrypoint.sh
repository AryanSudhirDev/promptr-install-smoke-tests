#!/bin/bash
set -u
# Product artifact input is a unique per-job fresh retrieval, never a shared fixture.
case "${TARGET_EXTENSION:-}" in
  aryansudhir.promptr)
    cp /opt/check/promptr-arm64-suite.cjs /opt/check/extended-suite.cjs
    ;;
  aryansudhir.cognispec)
    cp /opt/check/cognispec-arm64-suite.cjs /opt/check/extended-suite.cjs
    ;;
  *)
    echo "Unsupported QA target: ${TARGET_EXTENSION:-}" >&2
    exit 64
    ;;
esac
mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix
Xvfb :99 -screen 0 1280x900x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &
XPID=$!
for i in $(seq 1 50); do [ -S /tmp/.X11-unix/X99 ] && break; sleep 0.1; done
export DISPLAY=:99
node /opt/check/container-check.cjs
rc=$?
kill "$XPID" 2>/dev/null
exit "$rc"
