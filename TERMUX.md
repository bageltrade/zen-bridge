# Running zen-bridge on Termux (Android)

This is the awkward part. OpenCode is a **Bun-compiled binary**, and Termux uses
**bionic libc**, not glibc. The official install script drops a glibc binary that
simply will not run. Read this section before anything else — it is the single
most common reason the bridge fails on a phone.

---

## 1. Prerequisites

```bash
pkg update && pkg upgrade
pkg install nodejs git curl
```

Node 18+ is required (the bridge is plain ESM with zero dependencies).

## 2. Install an OpenCode build that actually runs on bionic

Do **not** use `curl -fsSL https://opencode.ai/install | bash`. It fetches a
glibc build and it dies on launch. Do **not** use `npm install -g opencode-ai`
either — that package declares `"os": ["darwin","linux","win32"]`, so npm
rejects it on Termux with `EBADPLATFORM`.

Use the community build, which repackages the official v1 binary for Android:

```bash
npm install -g @nemoobc/opencode-termux
opencode-termux --version     # currently 1.20.x
```

It installs as `opencode-termux`, has no OS restriction, and patches the ELF so
it runs natively — **no root, no proot, no chroot**.

<details>
<summary>Why not OpenCode v2 (<code>opencode2</code>)?</summary>

v2 is Node-based and *does* run on Termux, but it exposes a **different server
API** (`/api/session/...` instead of `/session/...`). The bridge is written and
tested against the **v1** server API. Use a v1 build.
</details>

## 3. Get the bridge

```bash
git clone https://github.com/<you>/zen-bridge.git
cd zen-bridge
```

Or just copy `bridge.mjs` and `start.sh` across — there are no dependencies to
install.

## 4. Configure

```bash
cat > zen-bridge.env <<'ENV'
OPENCODE_BIN=opencode-termux
ZEN_MODEL=space-bunny-free
ENV
```

Add `OPENCODE_API_KEY=sk-...` only if you want a model other than
`space-bunny-free`, which needs no key at all.

## 5. Run

```bash
./start.sh
```

Then point your agent at `http://127.0.0.1:4701/v1`.

---

## Making it survive

Android aggressively kills background processes, and Termux is no exception.
Two things worth doing:

**Disable battery optimisation for Termux.** Settings → Apps → Termux → Battery
→ *Unrestricted*. Without this, `opencode serve` dies mid-session and the bridge
starts returning `502` with a connection error.

**Use `tmux` or `screen`** so the server survives closing the terminal:

```bash
pkg install tmux
tmux new -s zen
./start.sh
# detach with Ctrl-b d, reattach with tmux attach -t zen
```

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `EBADPLATFORM` on `npm i -g opencode-ai` | package blocks `android` | use `@nemoobc/opencode-termux` |
| `Error loading shared library libc.so.6` | you installed a glibc build | uninstall, install the Termux build |
| `opencode-termux: command not found` | npm global bin not on PATH | `export PATH="$PREFIX/bin:$PATH"`, check `npm bin -g` |
| `502` + `fetch failed` from the bridge | `opencode serve` was killed | disable battery optimisation, use tmux |
| `port 4611 is already in use` | a previous run is still alive | `./start.sh` refuses to reuse a port it does not own — stop the old process, or change `OPENCODE_PORT` |
| `opencode: ... free tier can only be used from within OpenCode` | gated model, no valid key | set `OPENCODE_API_KEY`, or use `space-bunny-free` |
| Bridge works, then stops after screen off | Android doze | battery optimisation → Unrestricted |

### Verify the pieces separately

```bash
opencode-termux serve --port 4611 --hostname 127.0.0.1 &
curl -s http://127.0.0.1:4611/global/health     # {"healthy":true,...}

node bridge.mjs &
curl -s http://127.0.0.1:4701/health
```

If the first fails, the problem is the OpenCode build. If the first works and
the second doesn't, the problem is the bridge config.
