#!/usr/bin/env bash
# zen-bridge launcher.
#
#   ./start.sh            full mode  — opencode serve + bridge
#   ./start.sh --direct   direct mode — bridge only, no OpenCode needed
#
# Direct mode is what you want for tool calling: models listed in
# DIRECT_MODELS are forwarded straight to Zen, so nothing depends on an
# OpenCode build. That matters on Termux, where the only maintained build
# is upstream v2 while this bridge speaks the v1 server API.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

DIRECT_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --direct) DIRECT_ONLY=1 ;;
    -h|--help)
      sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 1 ;;
  esac
done

ENV_FILE="$HERE/zen-bridge.env"
if [[ -f "$ENV_FILE" ]]; then set -a; . "$ENV_FILE"; set +a; fi

export ZEN_MODEL="${ZEN_MODEL:-space-bunny-free}"
export OPENCODE_PROVIDER="${OPENCODE_PROVIDER:-opencode}"
export OPENCODE_AGENT="${OPENCODE_AGENT:-build}"
export BRIDGE_PORT="${BRIDGE_PORT:-4701}"
export OPENCODE_PORT="${OPENCODE_PORT:-4611}"
export OPENCODE_HOST="${OPENCODE_HOST:-127.0.0.1}"
export OPENCODE_DIR="${OPENCODE_DIR:-$PWD}"
export OPENCODE_URL="http://${OPENCODE_HOST}:${OPENCODE_PORT}"
# Termux/community builds install under a different name (opencode-termux).
export OPENCODE_BIN="${OPENCODE_BIN:-opencode}"
export DIRECT_MODELS="${DIRECT_MODELS-space-bunny-free}"
export ZEN_BASE="${ZEN_BASE:-https://opencode.ai/zen/v1}"

command -v node >/dev/null || { echo "node not found on PATH — run: pkg install nodejs" >&2; exit 1; }

# Refuse to run against a server we did not start: a stale opencode on the same
# port would silently answer the health check with someone else's config.
port_busy() {
  if command -v ss >/dev/null 2>&1; then
    ss -ltn 2>/dev/null | grep -qE "[:.]$1[[:space:]]"
  else
    (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null && exec 3<&- && return 0 || return 1
  fi
}

check_ports() {
  local ports=("$BRIDGE_PORT")
  [[ "$DIRECT_ONLY" -eq 0 ]] && ports+=("$OPENCODE_PORT")
  local p
  for p in "${ports[@]}"; do
    if port_busy "$p"; then
      echo "port $p is already in use." >&2
      echo "stop the old process, or change BRIDGE_PORT / OPENCODE_PORT in zen-bridge.env" >&2
      exit 1
    fi
  done
}

print_config() {
  cat <<BANNER

==========================================================
 zen-bridge is up  (127.0.0.1:${BRIDGE_PORT})

 OpenAI-compatible (pi, cline, aider, continue, ...)
   base_url = http://127.0.0.1:${BRIDGE_PORT}/v1
   api_key  = anything (e.g. sk-local)
   model    = ${ZEN_MODEL}

 Anthropic-compatible (cline native)
   base_url = http://127.0.0.1:${BRIDGE_PORT}
   api_key  = anything
   model    = ${ZEN_MODEL}

 direct models (full tool calling): ${DIRECT_MODELS}
 health: curl http://127.0.0.1:${BRIDGE_PORT}/health
==========================================================

BANNER
}

start_bridge() {
  BRIDGE_PORT="$BRIDGE_PORT" \
  OPENCODE_URL="$OPENCODE_URL" \
  OPENCODE_DIR="$OPENCODE_DIR" \
  ZEN_MODEL="$ZEN_MODEL" \
  OPENCODE_PROVIDER="$OPENCODE_PROVIDER" \
  OPENCODE_AGENT="$OPENCODE_AGENT" \
  DIRECT_MODELS="$DIRECT_MODELS" \
  ZEN_BASE="$ZEN_BASE" \
    node "$HERE/bridge.mjs" &
}

check_ports

if [[ "$DIRECT_ONLY" -eq 1 ]]; then
  echo "==> direct mode — OpenCode not started"
  echo "    models in DIRECT_MODELS go straight to Zen; tool calling works"
  start_bridge
  sleep 2
  print_config
  wait
  exit 0
fi

command -v "$OPENCODE_BIN" >/dev/null || {
  echo "$OPENCODE_BIN not found on PATH" >&2
  echo "For direct models (tool calling) you do not need it:  ./start.sh --direct" >&2
  echo "For gated models on Termux:  npm install -g @nemoobc/opencode-termux" >&2
  echo "and set OPENCODE_BIN=opencode-termux in zen-bridge.env" >&2
  exit 1
}

if [[ -n "${OPENCODE_API_KEY:-}" ]]; then
  echo "==> using OPENCODE_API_KEY from environment"
else
  echo "==> no OPENCODE_API_KEY — only direct models will work"
fi

# Critical: opencode must not act on its own tools here, or a single turn can
# become an agent loop that edits files. This is the only mechanism verified to
# zero the tool list — the per-message `tools` map and the session-level
# `permission` field are both ignored by opencode 1.18.x.
export OPENCODE_CONFIG_CONTENT="${OPENCODE_CONFIG_CONTENT:-{\"permission\":{\"*\":\"deny\"}}}"

echo "==> starting $OPENCODE_BIN serve on ${OPENCODE_URL} (dir=${OPENCODE_DIR})"
echo "    tools disabled via OPENCODE_CONFIG_CONTENT permission deny"
"$OPENCODE_BIN" serve --port "$OPENCODE_PORT" --hostname "$OPENCODE_HOST" --pure \
  >"${HERE}/opencode-serve.log" 2>&1 &
OC_PID=$!
cleanup() { kill "$OC_PID" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

for _ in $(seq 1 60); do
  curl -sf -m 2 "http://${OPENCODE_HOST}:${OPENCODE_PORT}/global/health" >/dev/null 2>&1 && break
  sleep 1
done
curl -sf -m 5 "http://${OPENCODE_HOST}:${OPENCODE_PORT}/global/health" >/dev/null \
  || { echo "opencode serve failed to start; see ${HERE}/opencode-serve.log" >&2; exit 1; }
echo "==> opencode is healthy"

echo "==> starting zen-bridge on http://127.0.0.1:${BRIDGE_PORT}"
start_bridge
sleep 2
print_config
wait
