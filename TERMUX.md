# Termux (Android) setup — with tool calling

The short version for tool calling: **you do not need OpenCode on Termux.**
`space-bunny-free` runs on the bridge's direct path, which forwards to Zen
verbatim, so `tools` survives and your coding agent gets real function calls.
Everything below is Node and nothing else.

```
cline / pi  ──HTTP──▶  zen-bridge :4701  ──HTTPS──▶  opencode.ai/zen
                         (direct path)          no opencode, no proot
```

---

## 1. Prerequisites

```bash
pkg update && pkg upgrade
pkg install nodejs git curl
node -v          # need v18+
```

That is the whole dependency list for tool calling.

## 2. Get the bridge

```bash
git clone https://github.com/bageltrade/zen-bridge.git
cd zen-bridge
```

Or copy `bridge.mjs` + `start.sh` across by hand — there is nothing to install.

## 3. Configure

```bash
cat > zen-bridge.env <<'ENV'
BRIDGE_PORT=4701
ZEN_MODEL=space-bunny-free
DIRECT_MODELS=space-bunny-free
ENV
```

No API key. `space-bunny-free` is served to anyone, and you do not want a key
sitting in a file on a phone.

## 4. Run it

```bash
./start.sh --direct
```

`--direct` skips OpenCode entirely. You should see:

```
==> direct mode — OpenCode not started
==> zen-bridge is up  (127.0.0.1:4701)
 direct models (full tool calling): space-bunny-free
```

## 5. Point your agent at it

**OpenAI-compatible** — pi, aider, continue, most of them:

| field | value |
|---|---|
| base URL | `http://127.0.0.1:4701/v1` |
| API key | anything, e.g. `sk-local` |
| model | `space-bunny-free` |

**Anthropic-compatible** — cline's native provider:

| field | value |
|---|---|
| base URL | `http://127.0.0.1:4701` |
| API key | anything |
| model | `space-bunny-free` |

## 6. Verify tool calling before you trust it

```bash
curl -s http://127.0.0.1:4701/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "space-bunny-free",
    "messages": [{"role":"user","content":"Weather in Paris? Use get_weather."}],
    "tools": [{"type":"function","function":{
      "name":"get_weather","description":"Get weather",
      "parameters":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}}}]
  }'
```

You want `"finish_reason": "tool_calls"` and a `tool_calls` array — **not** a
prose answer that invents the weather. If you get prose, your agent is pointed
at the OpenCode path; check `DIRECT_MODELS` contains your model.

Also worth checking:

```bash
curl -s http://127.0.0.1:4701/health
# "mode":"direct"  ← correct
```

---

## Keep it alive

Android kills background processes. Two things:

**Disable battery optimisation.** Settings → Apps → Termux → Battery →
*Unrestricted*. Without this the bridge dies mid-session.

**Use tmux** so closing the terminal doesn't kill it:

```bash
pkg install tmux
tmux new -s zen
./start.sh --direct
# detach: Ctrl-b d     reattach: tmux attach -t zen
```

---

## If you also want the *gated* models (`big-pickle`, `mimo-*`, …)

Read this before trying — **this path is unverified on Termux.**

Those models need the OpenCode hop, and OpenCode will not install normally:

- `curl -fsSL https://opencode.ai/install | bash` drops a **glibc** binary.
  Termux is **bionic**. It will not launch.
- `npm i -g opencode-ai` is rejected by npm — the package declares
  `"os": ["darwin","linux","win32"]` and Termux reports `android`.

The community build that does work:

```bash
npm install -g @nemoobc/opencode-termux   # installs as `opencode-termux`
```

Then in `zen-bridge.env`:

```
OPENCODE_BIN=opencode-termux
OPENCODE_API_KEY=sk-...      # from https://opencode.ai/workspace
ZEN_MODEL=big-pickle
```

…and run `./start.sh` **without** `--direct`.

### Why I can't promise this works

`@nemoobc/opencode-termux` bundles **upstream OpenCode 2.2.0** — that's v2.
This bridge is written against the **v1** server API (`POST /session`,
`POST /session/:id/message`, `GET /event`), which is what I tested against
1.18.31. v2 exposes a different surface (`/api/session/...`).

The package is also young (4 stars, first published days ago). It may well work;
I have no way to test a v2 binary on Android from here, and I would rather say
so than hand you a guide that fails at step one.

If it does fail, the error will be `opencode POST /session/... -> 404`. The fix
is porting the bridge's four calls to v2's paths — a contained change, and
open an issue with the error and I'll do it.

**Meanwhile, `space-bunny-free` gives you working tool calling today, with none
of this.**

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `node: command not found` | no Node | `pkg install nodejs` |
| `port 4701 is already in use` | an old run is alive | `./start.sh` refuses to adopt a server it did not start — stop it, or change `BRIDGE_PORT` |
| Reply is prose, no `tool_calls` | model not on the direct path | add it to `DIRECT_MODELS`, confirm `"mode":"direct"` in `/health` |
| `bridge: tool calling is not available for '<model>'` | gated model, needs OpenCode | expected; use `space-bunny-free` or see above |
| `404` from your agent | wrong base URL | OpenAI clients need the `/v1` suffix, Anthropic clients must not have it |
| Works, dies when screen off | Android doze | battery optimisation → Unrestricted |
| `ECONNREFUSED` from the agent | bridge not running | `tmux`, or re-run `./start.sh --direct` |

### Check the pieces separately

```bash
curl -s http://127.0.0.1:4701/health      # bridge alive? "mode":"direct"
node -v                                  # node ok?
```

If health responds but your agent still fails, the problem is the agent's base
URL or API-key field, not the bridge.
