#!/usr/bin/env bash
# End-to-end test of zen-bridge against a mock Zen. No API key, no network.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
WORK="$(mktemp -d)"
MOCK_PORT=4790; OC_PORT=4791; BR_PORT=4792; BR2_PORT=4793

PIDS=()
cleanup() { for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null; done; rm -rf "$WORK"; }
trap cleanup EXIT

pass=0; fail=0
check() { # name, actual, expected-substring
  if [[ "$2" == *"$3"* ]]; then echo "  PASS  $1"; pass=$((pass+1))
  else echo "  FAIL  $1"; echo "        got: ${2:0:300}"; fail=$((fail+1)); fi
}

check_num() { # name, actual, min, max
  if [[ "$2" -ge "$3" && "$2" -le "$4" ]]; then echo "  PASS  $1 ($2)"; pass=$((pass+1))
  else echo "  FAIL  $1 (got $2, want $3..$4)"; fail=$((fail+1)); fi
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
(cd "$WORK" && OPENCODE_API_KEY=sk-mock-test-key \
  OPENCODE_CONFIG_CONTENT='{"permission":{"*":"deny"}}' \
  opencode serve --port $OC_PORT --hostname 127.0.0.1 --pure) >"$WORK/oc.log" 2>&1 & PIDS+=($!)
wait_for "http://127.0.0.1:$OC_PORT/global/health" || { echo "opencode failed"; tail -20 "$WORK/oc.log"; exit 1; }

echo "==> starting bridge on $BR_PORT"
BRIDGE_PORT=$BR_PORT OPENCODE_URL="http://127.0.0.1:$OC_PORT" OPENCODE_DIR="$WORK" \
  ZEN_BASE="http://127.0.0.1:$MOCK_PORT/zen/v1" DIRECT_MODELS="space-bunny-free" \
  node "$ROOT/bridge.mjs" >"$WORK/bridge.log" 2>&1 & PIDS+=($!)
wait_for "http://127.0.0.1:$BR_PORT/health" || { echo "bridge failed"; cat "$WORK/bridge.log"; exit 1; }

# Second bridge with no direct models, so every request exercises the OpenCode hop.
echo "==> starting opencode-path bridge on $BR2_PORT"
BRIDGE_PORT=$BR2_PORT OPENCODE_URL="http://127.0.0.1:$OC_PORT" OPENCODE_DIR="$WORK" \
  ZEN_BASE="http://127.0.0.1:$MOCK_PORT/zen/v1" DIRECT_MODELS="" \
  node "$ROOT/bridge.mjs" >"$WORK/bridge2.log" 2>&1 & PIDS+=($!)
wait_for "http://127.0.0.1:$BR2_PORT/health" || { echo "bridge2 failed"; cat "$WORK/bridge2.log"; exit 1; }

B="http://127.0.0.1:$BR_PORT"
O="http://127.0.0.1:$BR2_PORT"
J='Content-Type: application/json'

echo; echo "==> tests"

# --- direct path (model Zen serves anonymously; bypasses OpenCode entirely)
check "health reports opencode reachable" "$(curl -s -m 10 $B/health)" '"opencodeReachable":true'
check "model list"  "$(curl -s -m 10 $B/v1/models)" 'space-bunny-free'
check "direct: openai non-stream" \
  "$(curl -s -m 90 $B/v1/chat/completions -H "$J" -d '{"model":"space-bunny-free","messages":[{"role":"user","content":"alpha"}]}')" \
  'MOCK_REPLY: alpha'
check "direct: openai stream" \
  "$(curl -sN -m 90 $B/v1/chat/completions -H "$J" -d '{"model":"space-bunny-free","stream":true,"messages":[{"role":"user","content":"beta"}]}' | tr -d '\n')" \
  'MOCK_REPLY:'
check "direct: stream terminates" \
  "$(curl -sN -m 90 $B/v1/chat/completions -H "$J" -d '{"model":"space-bunny-free","stream":true,"messages":[{"role":"user","content":"gamma"}]}' | tr -d '\n')" \
  'data: [DONE]'
check "direct: anthropic non-stream" \
  "$(curl -s -m 90 $B/v1/messages -H "$J" -d '{"model":"space-bunny-free","max_tokens":50,"messages":[{"role":"user","content":"zeta"}]}')" \
  'MOCK_REPLY: zeta'
check "direct: openai tool calling" \
  "$(curl -s -m 90 $B/v1/chat/completions -H "$J" -d '{"model":"space-bunny-free","messages":[{"role":"user","content":"w"}],"tools":[{"type":"function","function":{"name":"get_weather","parameters":{"type":"object","properties":{"city":{"type":"string"}}}}}]}')" \
  '"finish_reason":"tool_calls"'
check "direct: anthropic tool calling" \
  "$(curl -s -m 90 $B/v1/messages -H "$J" -d '{"model":"space-bunny-free","max_tokens":50,"messages":[{"role":"user","content":"w"}],"tools":[{"name":"get_weather","input_schema":{"type":"object","properties":{"city":{"type":"string"}}}}]}')" \
  '"type":"tool_use"'
check "direct: streaming tool calling" \
  "$(curl -sN -m 90 $B/v1/chat/completions -H "$J" -d '{"model":"space-bunny-free","stream":true,"messages":[{"role":"user","content":"w"}],"tools":[{"type":"function","function":{"name":"get_weather","parameters":{"type":"object","properties":{"city":{"type":"string"}}}}}]}' | tr -d '\n')" \
  '"tool_calls"'

# --- opencode path (gated model routed through the real opencode binary)
check "opencode: non-stream" \
  "$(curl -s -m 90 $O/v1/chat/completions -H "$J" -d '{"model":"space-bunny-free","messages":[{"role":"user","content":"one"}]}')" \
  'MOCK_REPLY: one'
check "opencode: stream" \
  "$(curl -sN -m 90 $O/v1/chat/completions -H "$J" -d '{"model":"space-bunny-free","stream":true,"messages":[{"role":"user","content":"two"}]}' | tr -d '\n')" \
  'MOCK_REPLY:'
check "opencode: stream terminates" \
  "$(curl -sN -m 90 $O/v1/chat/completions -H "$J" -d '{"model":"space-bunny-free","stream":true,"messages":[{"role":"user","content":"two"}]}' | tr -d '\n')" \
  'data: [DONE]'
check "opencode: multi-turn keeps session" \
  "$(curl -s -m 90 $O/v1/chat/completions -H "$J" -d '{"model":"space-bunny-free","messages":[{"role":"user","content":"delta"},{"role":"assistant","content":"MOCK_REPLY: delta "},{"role":"user","content":"epsilon"}]}')" \
  'MOCK_REPLY: epsilon'
check "opencode: anthropic non-stream" \
  "$(curl -s -m 90 $O/v1/messages -H "$J" -d '{"model":"space-bunny-free","max_tokens":50,"messages":[{"role":"user","content":"eta"}]}')" \
  'MOCK_REPLY: eta'
check "opencode: anthropic stream" \
  "$(curl -sN -m 90 $O/v1/messages -H "$J" -d '{"model":"space-bunny-free","stream":true,"max_tokens":50,"messages":[{"role":"user","content":"theta"}]}' | tr -d '\n')" \
  'content_block_delta'

# --- guards
check "tools rejected on gated model (no silent hallucination)" \
  "$(curl -s -m 90 $O/v1/chat/completions -H "$J" -d '{"model":"space-bunny-free","messages":[{"role":"user","content":"w"}],"tools":[{"type":"function","function":{"name":"get_weather","parameters":{"type":"object","properties":{"city":{"type":"string"}}}}}]}' -w ' HTTP%{http_code}')" \
  'HTTP400'
check "unknown route 404" "$(curl -s -m 10 $B/nope -w ' HTTP%{http_code}')" 'HTTP404'
check "empty messages 400" \
  "$(curl -s -m 10 $B/v1/chat/completions -H "$J" -d '{"messages":[]}' -w ' HTTP%{http_code}')" 'HTTP400'
check "upstream failure surfaces" \
  "$(curl -s -m 90 $O/v1/chat/completions -H "$J" -d '{"model":"gated-nope","messages":[{"role":"user","content":"x"}]}' -w ' HTTP%{http_code}')" \
  'HTTP502'

# --- regression guards on the opencode path
# If opencode reaches Zen with any tool enabled, one turn becomes an agent loop
# that can act on the filesystem. These must stay at zero.
OC_CALLS=$(grep -c 'oc=1 ' "$WORK/mock.log" || true)
OC_WITH_TOOLS=$(grep -c 'oc=1 .*tools=[1-9]' "$WORK/mock.log" || true)
# One upstream call per OpenCode-path test that gets as far as Zen. A runaway
# agent loop would push this far past the ceiling.
check_num "opencode upstream calls stay bounded" "$OC_CALLS" 6 8
check "opencode sent ZERO tools upstream" "$OC_WITH_TOOLS" "0"

echo; echo "==> $pass passed, $fail failed"
[[ $fail -eq 0 ]]
