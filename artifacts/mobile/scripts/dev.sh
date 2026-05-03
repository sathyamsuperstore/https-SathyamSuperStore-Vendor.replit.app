#!/usr/bin/env bash
# Dev wrapper for `expo start` on Replit.
#
# Why this exists: Expo Web binds its HTTP listener to $PORT lazily —
# the listener only opens after the first incoming request triggers
# bundling. Replit's workflow health check probes the port at startup
# and times out long before any client request arrives, marking the
# workflow FAILED and tearing the process down. The fix is to fire a
# self-request in the background as soon as expo is up, so the
# listener binds and the health check sees a green port.
set -uo pipefail

: "${PORT:=18115}"

EXPO_NO_TELEMETRY=1 \
EXPO_PACKAGER_PROXY_URL="https://${REPLIT_EXPO_DEV_DOMAIN:-}" \
EXPO_PUBLIC_DOMAIN="${REPLIT_DEV_DOMAIN:-}" \
EXPO_PUBLIC_REPL_ID="${REPL_ID:-}" \
REACT_NATIVE_PACKAGER_HOSTNAME="${REPLIT_DEV_DOMAIN:-}" \
pnpm exec expo start --localhost --port "$PORT" </dev/null &
EXPO_PID=$!

# Forward termination signals so the workflow can stop cleanly.
trap 'kill -TERM "$EXPO_PID" 2>/dev/null || true' INT TERM

# Background warmup: poll TCP until something is listening, then make
# a real HTTP request to "/" which forces Expo to start its web
# bundler and bind the listener for good. Bounded so we don't spin
# forever if expo crashed.
(
  for i in $(seq 1 90); do
    # Probe TCP first — bash's /dev/tcp is enough to know if expo
    # at least opened the socket. Some expo versions only open it
    # after the first HTTP request, in which case curl below will
    # do the trick anyway.
    if (echo > "/dev/tcp/127.0.0.1/${PORT}") 2>/dev/null; then
      :
    fi
    # Hit the root URL to trigger bundling + a stable bind.
    if curl -sf -o /dev/null -m 5 "http://127.0.0.1:${PORT}/"; then
      echo "[dev.sh] expo web reachable on :${PORT} after ${i}s"
      break
    fi
    sleep 1
  done
) &

wait "$EXPO_PID"
