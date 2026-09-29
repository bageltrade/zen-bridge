#!/usr/bin/env bash
# End-to-end test of zen-bridge against a mock Zen. No API key, no network.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
WORK="$(mktemp -d)"
MOCK_PORT=4790; OC_PORT=4791; BR_PORT=4792

PIDS=()
cleanup() { for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null; done; rm -rf "$WORK"; }
trap cleanup EXIT

pass=0; fail=0
check() { # name, actual, expected-substring
  if [[ "$2" == *"$3"* ]]; then echo "  PASS  $1"; pass=$((pass+1))
  else echo "  FAIL  $1"; echo "        got: ${2:0:300}"; fail=$((fail+1)); fi
}

wait_for() { for _ in $(seq 1 60); do curl -sf -m 2 "$1" >/dev/null 2>&1 && return 0; sleep 1; done; return 1; }

echo "==> workdir $WORK"
cat > "$WORK/opencode.json" <<JSON
{
  "\$schema": "https://opencode.ai/config.json",
  "provider": { "opencode": { "options": { "baseURL": "http://127.0.0.1:$MOCK_PORT/zen/v1" } } },
  "model": "opencode/space-bunny-free"
}
JSON

echo "==> starting mock zen on $MOCK_PORT"
MOCK_ZEN_PORT=$MOCK_PORT node "$HERE/mock-zen.mjs" >"$WORK/mock.log" 2>&1 & PIDS+=($!)
wait_for "http://127.0.0.1:$MOCK_PORT/zen/v1/models" || { echo "mock failed"; cat "$WORK/mock.log"; exit 1; }

echo "==> starting opencode serve on $OC_PORT"
(cd "$WORK" && OPENCODE_API_KEY=sk-mock-test-key opencode serve --port $OC_PORT --hostname 127.0.0.1 --pure) >"$WORK/oc.log" 2>&1 & PIDS+=($!)
wait_for "http://127.0.0.1:$OC_PORT/global/health" || { echo "opencode failed"; tail -20 "$WORK/oc.log"; exit 1; }

echo "==> starting bridge on $BR_PORT"
BRIDGE_PORT=$BR_PORT OPENCODE_URL="http://127.0.0.1:$OC_PORT" OPENCODE_DIR="$WORK" \
  node "$ROOT/bridge.mjs" >"$WORK/bridge.log" 2>&1 & PIDS+=($!)
wait_for "http://127.0.0.1:$BR_PORT/health" || { echo "bridge failed"; cat "$WORK/bridge.log"; exit 1; }

B="http://127.0.0.1:$BR_PORT"
J='Content-Type: application/json'

echo; echo "==> tests"
check "health reports opencode reachable" "$(curl -s -m 10 $B/health)" '"opencodeReachable":true'
check "model list"  "$(curl -s -m 10 $B/v1/models)" 'space-bunny-free'
check "openai non-stream" \
  "$(curl -s -m 90 $B/v1/chat/completions -H "$J" -d '{"model":"space-bunny-free","messages":[{"role":"user","content":"alpha"}]}')" \
  'MOCK_REPLY: alpha'
check "openai stream" \
  "$(curl -sN -m 90 $B/v1/chat/completions -H "$J" -d '{"model":"space-bunny-free","stream":true,"messages":[{"role":"user","content":"beta"}]}' | tr -d '\n')" \
  'MOCK_REPLY:'
check "openai stream terminates" \
  "$(curl -sN -m 90 $B/v1/chat/completions -H "$J" -d '{"model":"space-bunny-free","stream":true,"messages":[{"role":"user","content":"gamma"}]}' | tr -d '\n')" \
  'data: [DONE]'
check "multi-turn reuses one session" \
  "$(curl -s -m 90 $B/v1/chat/completions -H "$J" -d '{"model":"space-bunny-free","messages":[{"role":"user","content":"delta"},{"role":"assistant","content":"MOCK_REPLY: delta "},{"role":"user","content":"epsilon"}]}')" \
  'MOCK_REPLY: epsilon'
check "anthropic non-stream" \
  "$(curl -s -m 90 $B/v1/messages -H "$J" -d '{"model":"space-bunny-free","max_tokens":50,"messages":[{"role":"user","content":"zeta"}]}')" \
  'MOCK_REPLY: zeta'
check "anthropic stream" \
  "$(curl -sN -m 90 $B/v1/messages -H "$J" -d '{"model":"space-bunny-free","stream":true,"max_tokens":50,"messages":[{"role":"user","content":"eta"}]}' | tr -d '\n')" \
  'content_block_delta'
check "unknown route 404" "$(curl -s -m 10 $B/nope -w ' HTTP%{http_code}')" 'HTTP404'
check "empty messages 400" \
  "$(curl -s -m 10 $B/v1/chat/completions -H "$J" -d '{"messages":[]}' -w ' HTTP%{http_code}')" 'HTTP400'
check "upstream failure surfaces" \
  "$(curl -s -m 90 $B/v1/chat/completions -H "$J" -d '{"model":"does-not-exist","messages":[{"role":"user","content":"x"}]}' -w ' HTTP%{http_code}')" \
  'HTTP502'

echo; echo "==> $pass passed, $fail failed"
[[ $fail -eq 0 ]]
