#!/usr/bin/env bash
# zen-bridge launcher: brings up `opencode serve` + the bridge, then prints
# ready-to-paste client config.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$HERE/zen-bridge.env"
[[ -f "$ENV_FILE" ]] && set -a && . "$ENV_FILE" && set +a

export ZEN_MODEL="${ZEN_MODEL:-space-bunny-free}"
export OPENCODE_PROVIDER="${OPENCODE_PROVIDER:-opencode}"
export OPENCODE_AGENT="${OPENCODE_AGENT:-build}"
export BRIDGE_PORT="${BRIDGE_PORT:-4701}"
export OPENCODE_PORT="${OPENCODE_PORT:-4611}"
export OPENCODE_HOST="${OPENCODE_HOST:-127.0.0.1}"
export OPENCODE_DIR="${OPENCODE_DIR:-$PWD}"
export OPENCODE_URL="http://${OPENCODE_HOST}:${OPENCODE_PORT}"

# Termux/community builds install under a different name (opencode-termux,
# opencode2); the bridge only needs *a* v1 opencode on PATH.
export OPENCODE_BIN="${OPENCODE_BIN:-opencode}"
command -v "$OPENCODE_BIN" >/dev/null || {
  echo "$OPENCODE_BIN not found on PATH" >&2
  echo "On Termux try: npm install -g @nemoobc/opencode-termux" >&2
  echo "  and set OPENCODE_BIN=opencode-termux in zen-bridge.env" >&2
  exit 1
}
command -v node    >/dev/null || { echo "node not found on PATH" >&2; exit 1; }

# Refuse to run against a server we did not start: a stale opencode on the same
# port would silently answer the health check with someone else's config.
port_busy() {
  if command -v ss >/dev/null; then ss -ltn 2>/dev/null | grep -qE "[:.]$1[[:space:]]"
  else (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null && exec 3<&- && return 0 || return 1
  fi
}
for p in "$OPENCODE_PORT" "$BRIDGE_PORT"; do
  if port_busy "$p"; then
    echo "port $p is already in use." >&2
    echo "stop the old process, or set OPENCODE_PORT / BRIDGE_PORT in zen-bridge.env" >&2
    exit 1
  fi
done

if [[ -n "${OPENCODE_API_KEY:-}" ]]; then
  echo "==> using OPENCODE_API_KEY from environment"
else
  echo "==> OPENCODE_API_KEY not set — only anonymous Zen models will work"
  echo "    (space-bunny-free works keyless; the other free models need a key)"
fi

echo "==> starting $OPENCODE_BIN serve on ${OPENCODE_URL} (dir=${OPENCODE_DIR})"
"$OPENCODE_BIN" serve --port "$OPENCODE_PORT" --hostname "$OPENCODE_HOST" --pure \
  >"${HERE}/opencode-serve.log" 2>&1 &
OC_PID=$!

cleanup() { kill "$OC_PID" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

for _ in $(seq 1 60); do
  if curl -sf -m 2 "http://${OPENCODE_HOST}:${OPENCODE_PORT}/global/health" >/dev/null 2>&1; then break; fi
  sleep 1
done
curl -sf -m 5 "http://${OPENCODE_HOST}:${OPENCODE_PORT}/global/health" >/dev/null \
  || { echo "opencode serve failed to start; see ${HERE}/opencode-serve.log" >&2; exit 1; }
echo "==> opencode is healthy"

echo "==> starting zen-bridge on http://127.0.0.1:${BRIDGE_PORT}"
BRIDGE_PORT="$BRIDGE_PORT" OPENCODE_URL="$OPENCODE_URL" OPENCODE_DIR="$OPENCODE_DIR" \
  ZEN_MODEL="$ZEN_MODEL" OPENCODE_PROVIDER="$OPENCODE_PROVIDER" OPENCODE_AGENT="$OPENCODE_AGENT" \
  node "$HERE/bridge.mjs" &

sleep 2
echo
echo "=========================================================="
echo " zen-bridge is up"
echo
echo " OpenAI-compatible (pi, cline, aider, continue, ...)"
echo "   base_url = http://127.0.0.1:${BRIDGE_PORT}/v1"
echo "   api_key  = anything (e.g. sk-local)"
echo "   model    = ${ZEN_MODEL}"
echo
echo " Anthropic-compatible (cline native)"
echo "   base_url = http://127.0.0.1:${BRIDGE_PORT}"
echo "   api_key  = anything"
echo "   model    = ${ZEN_MODEL}"
echo
echo " health: curl http://127.0.0.1:${BRIDGE_PORT}/health"
echo "=========================================================="
echo

wait
