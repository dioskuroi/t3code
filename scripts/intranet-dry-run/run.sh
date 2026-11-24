#!/bin/sh
# Headless dry run of a packaged intranet app, without its GUI: starts the embedded server under a
# fake HOME, runs one thread through an ACP omp instance and a mock gateway, and records every
# external HTTP(S) target. See docs/operations/intranet-build.md.
# Usage, from the fork root (options first, then environment for the server):
#   sh scripts/intranet-dry-run/run.sh --omp-kit <dir> [--app <path>.app] [--keep] [VAR=VALUE ...]
#   --keep leaves the work directory in place for inspection and prints its path.
set -u

usage() {
  echo "usage: $0 --omp-kit <dir> [--app <path>.app] [--keep] [VAR=VALUE ...]" >&2
  exit 2
}

needs_value() {
  [ "$#" -ge 2 ] && [ -n "$2" ] || usage
}

HERE=$(cd "$(dirname "$0")" && pwd)
OMP_KIT=""
APP=""
KEEP=no
while [ "$#" -gt 0 ]; do
  case "$1" in
    --omp-kit) needs_value "$@"; OMP_KIT="$2"; shift 2 ;;
    --app) needs_value "$@"; APP="$2"; shift 2 ;;
    --keep) KEEP=yes; shift ;;
    *=*) break ;;
    *) usage ;;
  esac
done
[ -n "$OMP_KIT" ] && [ -d "$OMP_KIT" ] || usage
[ -n "$APP" ] || APP=$(ls -d release/mac-arm64/*.app 2>/dev/null | head -1)
[ -n "$APP" ] || {
  echo "no packaged .app; build first or pass --app" >&2
  exit 1
}
EXE="$APP/Contents/MacOS/$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$APP/Contents/Info.plist")"
BIN="$APP/Contents/Resources/app.asar/apps/server/dist/bin.mjs"
OMP=$(command -v omp || true)
[ -n "$OMP" ] || {
  echo "omp is not on PATH" >&2
  exit 1
}
for port in 13799 18475 18476; do
  if nc -z 127.0.0.1 "$port" 2>/dev/null; then
    echo "port $port is already in use" >&2
    exit 1
  fi
done

WORK=$(mktemp -d "${TMPDIR:-/tmp}/t3-intranet-dry-run.XXXXXX")
SERVER_PID=""
GATEWAY_PID=""
PROXY_PID=""
# Called explicitly on every exit path: an EXIT trap alone is not reliable under `sh script`.
cleanup() {
  kill "$SERVER_PID" "$GATEWAY_PID" "$PROXY_PID" 2>/dev/null || true
  sleep 1
  kill -9 "$SERVER_PID" "$GATEWAY_PID" "$PROXY_PID" 2>/dev/null || true
  if [ "$KEEP" = yes ]; then echo "work dir kept: $WORK"; else rm -rf "$WORK"; fi
}
trap 'cleanup' EXIT

listening() {
  nc -z 127.0.0.1 "$1" 2>/dev/null
}

main() {
  H="$WORK/home"
  mkdir -p "$H/.t3/userdata" "$WORK/ws" "$WORK/omp-agent"
  sed 's#http://GATEWAY_HOST:PORT/v1#http://127.0.0.1:18475/v1#' "$OMP_KIT/models.yml" \
    > "$WORK/omp-agent/models.yml"
  printf 'INTRANET_API_KEY=test-key-123\n' > "$WORK/omp-agent/.env"
  (cd "$WORK/ws" && PI_CODING_AGENT_DIR="$WORK/omp-agent" HOME="$H" sh "$OMP_KIT/apply-omp-settings.sh") \
    > "$WORK/omp-apply.log" 2>&1 || {
    echo "omp settings could not be applied:" >&2
    tail -5 "$WORK/omp-apply.log" >&2
    return 1
  }
  cat > "$H/.t3/userdata/settings.json" <<JSON
{"providerInstances":{"acpRegistry_omp":{"driver":"acpRegistry","displayName":"omp (ACP)","enabled":true,
 "environment":[{"name":"PI_CODING_AGENT_DIR","value":"$WORK/omp-agent"}],
 "config":{"source":"local","commandPath":"$OMP","commandArgs":["acp"]}}},
 "defaultModelSelection":{"instanceId":"acpRegistry_omp","model":"intranet/glm-5.3-flash","options":[]}}
JSON

  export HOME="$H" T3CODE_HOME="$H/.t3" ELECTRON_RUN_AS_NODE=1 LANG=en_US.UTF-8 TERM=dumb
  export NODE_USE_ENV_PROXY=1 HTTP_PROXY=http://127.0.0.1:18476 HTTPS_PROXY=http://127.0.0.1:18476
  export NO_PROXY=127.0.0.1,localhost,::1
  for assignment in "$@"; do
    export "$assignment"
  done

  node "$HERE/mock-gateway.cjs" "$WORK/gateway.log" > "$WORK/gateway.out" 2>&1 &
  GATEWAY_PID=$!
  node "$HERE/egress-proxy.cjs" "$WORK/egress.log" > "$WORK/proxy.out" 2>&1 &
  PROXY_PID=$!
  for port in 18475 18476; do
    up=no
    for _ in $(seq 40); do
      if listening "$port"; then up=yes; break; fi
      sleep 0.25
    done
    [ "$up" = yes ] || {
      echo "the helper on port $port did not start:" >&2
      tail -5 "$WORK/gateway.out" "$WORK/proxy.out" >&2 2>&1
      return 1
    }
  done

  "$EXE" "$BIN" serve --port 13799 --host 127.0.0.1 --no-browser > "$WORK/server.log" 2>&1 &
  SERVER_PID=$!
  ready=no
  for _ in $(seq 60); do
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then break; fi
    if listening 13799; then ready=yes; break; fi
    sleep 1
  done
  [ "$ready" = yes ] || {
    echo "server did not start; last log lines:" >&2
    tail -20 "$WORK/server.log" >&2
    return 1
  }
  echo "server: listening"

  # Right after listening, the server has not yet published the record the CLI finds it by; on a
  # loaded machine that takes longer. Only that failure is retried.
  attempt=0
  until "$EXE" "$BIN" project add "$WORK/ws" > "$WORK/step-project.log" 2>&1; do
    attempt=$((attempt + 1))
    if [ "$attempt" -ge 20 ] || ! grep -q "ServerAlreadyRunningError" "$WORK/step-project.log"; then
      echo "project add failed:" >&2
      tail -20 "$WORK/step-project.log" >&2
      return 1
    fi
    sleep 2
  done
  echo "project add: ok"

  # The server asks omp for its models in the background once the project exists; on a loaded
  # machine that takes longer than getting here. Only that failure is retried.
  attempt=0
  until "$EXE" "$BIN" thread start --provider acpRegistry_omp --model intranet/glm-5.3-flash --wait "$WORK/ws" \
    "Reply with exactly: OK" > "$WORK/step-thread.log" 2>&1; do
    attempt=$((attempt + 1))
    if [ "$attempt" -ge 20 ] || ! grep -q "is not advertised" "$WORK/step-thread.log"; then
      echo "thread start failed:" >&2
      tail -20 "$WORK/step-thread.log" >&2
      return 1
    fi
    sleep 2
  done
  THREAD=$(sed -n 's/^Thread \(mcp:[0-9a-f-]*\)$/\1/p' "$WORK/step-thread.log" | head -1)
  echo "thread reply: $(tail -1 "$WORK/step-thread.log")"
  if [ -n "$THREAD" ]; then
    "$EXE" "$BIN" thread show "$THREAD" --messages 6 > "$WORK/step-show.log" 2>&1 \
      && echo "thread show: ok" || echo "thread show: failed"
  fi

  # Give background refreshes and telemetry flushes their turn before reading the egress log.
  sleep 15

  echo "gateway requests: $(wc -l < "$WORK/gateway.log" | tr -d ' ')"
  echo "external targets:"
  if [ -s "$WORK/egress.log" ]; then
    sed -n 's/.*"host": *"\([^"]*\)".*/  \1/p' "$WORK/egress.log" | sort | uniq -c
  else
    echo "  (none)"
  fi
}

status=0
main "$@" || status=$?
cleanup
trap - EXIT
exit "$status"
