# zen-bridge

Use OpenCode Zen's free models from **pi, cline, aider, continue, or anything else** —
without running the request through a header-spoofing hack that OpenCode already blocks.

---

## What actually happened (the research)

OpenCode's Zen docs still advertise:

> Have no lock-in by allowing you to use it with any other coding agent.

That is no longer true for the free tier. Every free model except one now returns:

```
HTTP 403
{"type":"error","error":{"type":"FreeTierError",
 "message":"Error from provider (Console): OpenCode's free tier can only be used from within OpenCode"}}
```

### What I tested directly against `https://opencode.ai/zen/v1`

| Model | Plain `curl`, no key | Result |
|---|---|---|
| `space-bunny-free` | ✅ 200 | works anonymously, streaming + tool calls |
| `jev-1.13-free` | ✅ 200 | works, but it's a classifier, not a chat model |
| `big-pickle` | ❌ 403 | FreeTierError |
| `mimo-v2.6-flash-free` | ❌ 403 | FreeTierError |
| `mimo-v2.5-free` | ❌ 403 | FreeTierError |
| `ling-3.0-flash-fin-free` | ❌ 403 | FreeTierError |
| `nemotron-3-ultra-free` | ❌ 403 | FreeTierError |
| `nemotron-3.5-lightning-free` | ❌ 403 | FreeTierError |
| `longcat-2.5-preview-free` | ❌ 403 | FreeTierError |
| `muse-spark-1.3-contributor-free` | ❌ 403 | FreeTierError |
| any paid model (`glm-5.3-flash`, `kimi-k2.7-code`, …) | 401 | "Missing API key" — a real key *does* work |

### Header spoofing does not work

I tried every header the OpenCode client sends (read from the source at
`packages/opencode/src/session/llm/request.ts`): `x-opencode-session`,
`x-opencode-request`, `x-opencode-client`, `x-opencode-project`, and
`User-Agent: opencode/<version>`, alone and combined. All still 403.

This matches [anomalyco/opencode#49621][49621], where someone replayed a captured
genuine request **byte for byte** — same header order, same
`opencode/1.18.31 ai-sdk/provider-utils/4.0.40 runtime/bun/1.3.14` UA, same
`ses_…` session id, same body — over both HTTP/1.1 and HTTP/2, and still got 403.
The genuine binary on the same machine and key got 200. The discriminator is
below the HTTP layer, so **no amount of header faking will get you in.**

> ⚠️ This is a deliberate access decision by OpenCode, and the docs contradict it.
> See [#49858][49858] ("Looks like the doc is now a lie") — still open.

[49621]: https://github.com/anomalyco/opencode/issues/49621
[49858]: https://github.com/anomalyco/opencode/issues/49858

---

## So how this bridge works

The same issue's test matrix contains the one line that matters:

> Local `opencode serve` API (`POST /session/:id/message`) → **200**

The check is satisfied by the **genuine `opencode` binary**, not by any particular
HTTP request. So the bridge doesn't fake anything — it drives a real
`opencode serve` over its local API and relays the traffic:

```
pi / cline / aider
      │  OpenAI or Anthropic HTTP
      ▼
   zen-bridge        (this repo, port 4701)
      │  local HTTP to the opencode server API
      ▼
 opencode serve     (genuine binary — produces the request Zen accepts)
      │
      ▼
  OpenCode Zen      →  big-pickle, mimo, nemotron, …
```

The cost is one extra local hop and that OpenCode's own agent scaffolding sits in
the middle. See [Limitations](#limitations).

---

## Setup

> **On Android/Termux?** Read [TERMUX.md](TERMUX.md) first — OpenCode's official
> binary is a glibc build that will not run on bionic, and `npm i -g opencode-ai`
> is blocked by npm. There is a working community build; the guide has it.

```bash
cd zen-bridge
cp zen-bridge.env.example zen-bridge.env   # optional
$EDITOR zen-bridge.env
./start.sh
```

`start.sh` launches `opencode serve` + the bridge and prints client config.

### Point your agent at it

**OpenAI-compatible** (pi, aider, continue, cursor, …)

| field | value |
|---|---|
| base URL | `http://127.0.0.1:4701/v1` |
| API key | anything, e.g. `sk-local` |
| model | `space-bunny-free` (or set `ZEN_MODEL`) |

**Anthropic-compatible** (cline's native provider)

| field | value |
|---|---|
| base URL | `http://127.0.0.1:4701` |
| API key | anything |
| model | `space-bunny-free` |

Curl check:

```bash
curl http://127.0.0.1:4701/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"space-bunny-free","messages":[{"role":"user","content":"hello"}]}'
```

---

## Enabling the *other* free models

`space-bunny-free` is the only free model Zen serves without a key, and the
bridge returns it with no configuration at all. The rest need a Zen key:

```bash
export OPENCODE_API_KEY=sk-...     # from https://opencode.ai/workspace
export ZEN_MODEL=big-pickle
./start.sh
```

**Honest caveat:** I could not verify this leg myself — I had no Zen key, so every
gated model returned `FreeTierError` from my test machine. The evidence that it
works is [#49621][49621]'s matrix, where the genuine client on a valid key and
session returned 200 for `muse-spark-1.3-contributor-free` while every replay
returned 403. The bridge issues requests from that same genuine client, so the
mechanism is identical — but **treat it as unverified until your first successful
call.** If a gated model still 403s through the bridge, that is OpenCode closing
the loophole further, not a bridge bug; the error message will say so verbatim.

---

## Limitations

- **OpenCode is an agent server, not a raw completion API.** The bridge disables
  OpenCode's tools (`bash`, `edit`, `write`, …) so it won't touch your files, but
  OpenCode still prepends its own system prompt. Your agent's system prompt is
  passed through *in addition to* it, not instead of it.
- **No tool-calling passthrough.** Because OpenCode's tools are off, the model
  answers in prose. If your agent needs to call functions, drive it through
  OpenCode itself, or use `space-bunny-free` directly (see below).
- **One session per conversation.** The bridge keys an OpenCode session on the
  opening user message and appends only new turns, because OpenCode already holds
  the assistant turns it generated. Editing earlier history mid-conversation
  starts a fresh session.
- **Latency.** Every streaming turn waits ~150 ms to attach to the event bus
  before dispatching, so no early tokens are lost.

## When you don't need this at all

If `space-bunny-free` is the model you want, skip the bridge — it is anonymous
and needs no key:

```json
{ "baseURL": "https://opencode.ai/zen/v1", "apiKey": "" }
```

The bridge is only worth it for the models Zen gates.

---

## Config

| env var | default | meaning |
|---|---|---|
| `OPENCODE_API_KEY` | — | Zen key; required for every gated model |
| `ZEN_MODEL` | `space-bunny-free` | model to expose |
| `BRIDGE_PORT` | `4701` | bridge listen port |
| `OPENCODE_PORT` | `4611` | `opencode serve` port |
| `OPENCODE_DIR` | `$PWD` | project root OpenCode treats as cwd |
| `OPENCODE_AGENT` | `build` | OpenCode agent used for the turn |
| `OPENCODE_BIN` | `opencode` | binary name — set to `opencode-termux` on Termux |
| `BRIDGE_TIMEOUT_MS` | `600000` | per-turn timeout |

## Tests

`test/run-tests.sh` runs the whole stack against a mock Zen
(`test/mock-zen.mjs`), so it needs no key and no network:

```bash
./test/run-tests.sh
```
