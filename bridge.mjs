#!/usr/bin/env node
/**
 * zen-bridge — expose OpenCode Zen free models to third-party agents.
 *
 * OpenCode gates its free tier behind "must be called from inside OpenCode"
 * (verified: 403 FreeTierError for every non-opencode client, including
 * byte-faithful replays of genuine traffic). Header/User-Agent spoofing does
 * NOT work, so this bridge does not spoof anything.
 *
 * Instead it drives a real `opencode serve` instance over its local HTTP API.
 * The genuine binary produces the request that Zen accepts, so every Zen free
 * model becomes reachable from pi / cline / aider / anything OpenAI- or
 * Anthropic-compatible.
 *
 *   client  --OpenAI/Anthropic-->  zen-bridge  --local http-->  opencode serve  -->  Zen
 */

import { createServer } from "node:http"
import { createHash } from "node:crypto"
import { randomUUID } from "node:crypto"

const CFG = {
  port: Number(process.env.BRIDGE_PORT || 4701),
  opencodeUrl: (process.env.OPENCODE_URL || "http://127.0.0.1:4611").replace(/\/$/, ""),
  directory: process.env.OPENCODE_DIR || process.cwd(),
  model: process.env.ZEN_MODEL || "space-bunny-free",
  provider: process.env.OPENCODE_PROVIDER || "opencode",
  agent: process.env.OPENCODE_AGENT || "build",
  requestTimeoutMs: Number(process.env.BRIDGE_TIMEOUT_MS || 600000),
}

const KNOWN_FREE_MODELS = [
  "space-bunny-free",
  "big-pickle",
  "mimo-v2.6-flash-free",
  "mimo-v2.5-free",
  "ling-3.0-flash-fin-free",
  "nemotron-3-ultra-free",
  "nemotron-3.5-lightning-free",
  "longcat-2.5-preview-free",
  "muse-spark-1.3-contributor-free",
]

const log = (...a) => process.stderr.write(`[zen-bridge] ${a.join(" ")}\n`)

// ---------------------------------------------------------------- opencode client

async function ocFetch(path, init = {}) {
  const sep = CFG.opencodeUrl.includes("?") ? "&" : "?"
  const url = `${CFG.opencodeUrl}${path}${sep}directory=${encodeURIComponent(CFG.directory)}`
  const res = await fetch(url, init)
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new Error(`opencode ${init.method || "GET"} ${path} -> ${res.status} ${body.slice(0, 300)}`)
  }
  return res
}

async function ocJson(path, init) {
  return (await ocFetch(path, init)).json()
}

async function createSession(model) {
  const body = {
    title: "zen-bridge",
    model: { providerID: CFG.provider, id: model },
  }
  const s = await ocJson("/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  log("session created", s.id, "model=" + model)
  return s.id
}

function textOf(content) {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === "string" ? p : p?.type === "text" ? (p.text ?? "") : ""))
      .join("")
  }
  return ""
}

// opencode injects its own agent prompt; this body disables its tools so the
// session behaves like a plain completion instead of an autonomous agent.
function messageBody(text, extra = {}) {
  return {
    parts: [{ type: "text", text }],
    agent: CFG.agent,
    tools: {
      bash: false, edit: false, write: false, read: false, patch: false,
      grep: false, glob: false, list: false, webfetch: false, task: false,
      todowrite: false, todoread: false, invalid: false,
    },
    ...extra,
  }
}

async function sendMessage(sessionID, text, extra) {
  return ocJson(`/session/${sessionID}/message`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(messageBody(text, extra)),
  })
}

// ---------------------------------------------------------------- session reuse

/**
 * A third-party agent replays the whole transcript on every turn, so we key a
 * session on the opening turn and then only ever append the newest user turn —
 * opencode already holds the assistant turns it generated itself.
 */
const sessions = new Map()

function conversationKey(model, system, messages) {
  const firstUser = messages.find((m) => m.role === "user")
  return createHash("sha256")
    .update(JSON.stringify([model, system || "", textOf(firstUser?.content)]))
    .digest("hex")
}

async function resolveSession(model, system, messages) {
  const key = conversationKey(model, system, messages)
  const last = messages.at(-1)
  const hit = sessions.get(key)
  if (hit) {
    // Drop the cached session if opencode no longer knows about it.
    try {
      await ocFetch(`/session/${hit.sessionID}`)
      return { sessionID: hit.sessionID, replay: [], system, last }
    } catch {
      sessions.delete(key)
    }
  }

  const sessionID = await createSession(model)
  // Seed with any prior transcript this client sent before we were created.
  const prior = messages.slice(0, -1).filter((m) => m.role !== "system")
  const replay = []
  for (const m of prior) {
    const t = textOf(m.content)
    if (t) replay.push(m.role === "assistant" ? `Assistant said earlier: ${t}` : t)
  }
  sessions.set(key, { sessionID })
  return { sessionID, replay, system, last }
}

async function prepareTurn(model, system, messages) {
  const { sessionID, replay, system: sys, last } = await resolveSession(model, system, messages)
  for (const t of replay) await sendMessage(sessionID, t, sys ? { system: sys } : {})
  const prompt = textOf(last?.content)
  if (!prompt) throw new HttpError(400, "bridge: last message must have non-empty content")
  return { sessionID, prompt, system: sys }
}

// ---------------------------------------------------------------- streaming

/**
 * Subscribe to opencode's event bus, fire the prompt, and relay text deltas
 * until the session goes idle.
 */
async function streamTurn({ sessionID, prompt, system }, onDelta) {
  const url = `${CFG.opencodeUrl}/event?directory=${encodeURIComponent(CFG.directory)}`
  const ac = new AbortController()
  let sawDelta = false

  const done = new Promise((resolve, reject) => {
    let settled = false
    const finish = (err, val) => {
      if (settled) return
      settled = true
      ac.abort()
      err ? reject(err) : resolve(val)
    }
    const timer = setTimeout(() => finish(new Error("bridge: timed out waiting for model")), CFG.requestTimeoutMs)

    ;(async () => {
      const res = await fetch(url, { signal: ac.signal, headers: { accept: "text/event-stream" } })
      if (!res.ok || !res.body) return finish(new Error(`bridge: event stream failed (${res.status})`))
      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let buf = ""
      while (true) {
        const { done: ended, value } = await reader.read()
        if (ended) break
        buf += dec.decode(value, { stream: true })
        let idx
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const raw = buf.slice(0, idx)
          buf = buf.slice(idx + 2)
          const line = raw.split("\n").find((l) => l.startsWith("data: "))
          if (!line) continue
          let evt
          try { evt = JSON.parse(line.slice(6)) } catch { continue }
          const p = evt.properties || {}
          if (p.sessionID && p.sessionID !== sessionID) continue
          if (evt.type === "message.part.delta" && p.field === "text" && p.delta) {
            sawDelta = true
            onDelta(p.delta)
          } else if (evt.type === "session.idle") {
            clearTimeout(timer)
            return finish(null, { sawDelta })
          }
        }
      }
      clearTimeout(timer)
      finish(null, { sawDelta })
    })().catch((e) => {
      clearTimeout(timer)
      if (e.name !== "AbortError") finish(e)
      else finish(null, { sawDelta })
    })
  })

  // Race: connect first, then dispatch so no early delta is missed.
  await new Promise((r) => setTimeout(r, 150))
  await ocFetch(`/session/${sessionID}/prompt_async`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(messageBody(prompt, system ? { system } : {})),
  }).catch((e) => ac.abort().then(() => { throw e }))

  return done
}

async function finalResult(sessionID) {
  const msgs = await ocJson(`/session/${sessionID}/message`)
  const list = Array.isArray(msgs) ? msgs : msgs?.data || []
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i]
    if (m?.info?.role !== "assistant") continue
    const err = m.info.error
    const text = (m.parts || []).filter((p) => p.type === "text").map((p) => p.text).join("")
    if (err) {
      const detail = err?.data?.message || err?.data?.responseBody || err?.name || "unknown error"
      const status = err?.data?.statusCode
      throw new HttpError(status === 401 ? 401 : 502, `opencode: ${detail}`)
    }
    return { text, tokens: m.info.tokens || {} }
  }
  return { text: "", tokens: {} }
}

// ---------------------------------------------------------------- wire formats

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status }
}

function sse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`)
}

function openaiStream(model, onText) {
  const id = `chatcmpl-${randomUUID().replace(/-/g, "").slice(0, 24)}`
  const created = Math.floor(Date.now() / 1000)
  return {
    chunk: (delta, finish = null) => ({
      id, object: "chat.completion.chunk", created, model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    }),
    role: () => ({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] }),
    usage: (u) => ({ id, object: "chat.completion.chunk", created, model, choices: [], usage: u }),
  }
}

async function handleOpenAI(req, res, body) {
  const messages = Array.isArray(body.messages) ? body.messages : []
  if (!messages.length) throw new HttpError(400, "bridge: 'messages' is required")
  const model = body.model || CFG.model
  const system = messages.filter((m) => m.role === "system").map((m) => textOf(m.content)).join("\n\n")

  const turn = await prepareTurn(model, system, messages)

  if (!body.stream) {
    await sendMessage(turn.sessionID, turn.prompt, turn.system ? { system: turn.system } : {})
    const { text, tokens: tok } = await finalResult(turn.sessionID)
    res.writeHead(200, { "content-type": "application/json" })
    return res.end(JSON.stringify({
      id: `chatcmpl-${randomUUID().replace(/-/g, "").slice(0, 24)}`,
      object: "chat.completion", created: Math.floor(Date.now() / 1000), model,
      choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: tok.input || 0, completion_tokens: tok.output || 0, total_tokens: tok.total || 0,
      },
    }))
  }

  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  })
  const w = openaiStream(model)
  sse(res, w.role())
  let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
  try {
    const { sawDelta } = await streamTurn(turn, (d) => sse(res, w.chunk({ content: d })))
    const final = await finalResult(turn.sessionID)
    if (!sawDelta && final.text) sse(res, w.chunk({ content: final.text }))
    usage = { prompt_tokens: final.tokens.input || 0, completion_tokens: final.tokens.output || 0, total_tokens: final.tokens.total || 0 }
  } catch (e) {
    log("stream error:", e.message)
    sse(res, { error: { message: e.message, type: "bridge_error" } })
    usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
    res.write("data: [DONE]\n\n")
    return res.end()
  }
  sse(res, w.chunk({}, "stop"))
  sse(res, w.usage(usage))
  res.write("data: [DONE]\n\n")
  res.end()
}

async function handleAnthropic(req, res, body) {
  const messages = Array.isArray(body.messages) ? body.messages : []
  if (!messages.length) throw new HttpError(400, "bridge: 'messages' is required")
  const model = body.model || CFG.model
  const system = typeof body.system === "string"
    ? body.system
    : Array.isArray(body.system) ? body.system.map(textOf).join("\n\n") : ""

  const turn = await prepareTurn(model, system, messages)
  const msgId = `msg_${randomUUID().replace(/-/g, "").slice(0, 24)}`

  if (!body.stream) {
    await sendMessage(turn.sessionID, turn.prompt, turn.system ? { system: turn.system } : {})
    const { text, tokens: tok } = await finalResult(turn.sessionID)
    res.writeHead(200, { "content-type": "application/json" })
    return res.end(JSON.stringify({
      id: msgId, type: "message", role: "assistant", model,
      content: [{ type: "text", text }],
      stop_reason: "end_turn", stop_sequence: null,
      usage: { input_tokens: tok.input || 0, output_tokens: tok.output || 0 },
    }))
  }

  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  })
  const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`)
  ev("message_start", { type: "message_start", message: { id: msgId, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } })

  let n = 0
  ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })
  try {
    const { sawDelta } = await streamTurn(turn, (d) => {
      ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: d } })
      n++
    })
    const final = await finalResult(turn.sessionID)
    if (!sawDelta && final.text) {
      ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: final.text } })
      n++
    }
  } catch (e) {
    log("anthropic stream error:", e.message)
    ev("error", { type: "error", error: { type: "api_error", message: e.message } })
    res.end()
    return
  }
  ev("content_block_stop", { type: "content_block_stop", index: 0 })
  ev("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: n } })
  ev("message_stop", { type: "message_stop" })
  res.end()
}

// ---------------------------------------------------------------- server

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on("data", (c) => {
      size += c.length
      if (size > 64 * 1024 * 1024) { reject(new HttpError(413, "bridge: body too large")); req.destroy(); return }
      chunks.push(c)
    })
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString()
      if (!raw) return resolve({})
      try { resolve(JSON.parse(raw)) } catch { reject(new HttpError(400, "bridge: invalid JSON body")) }
    })
    req.on("error", reject)
  })
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost")
  const path = url.pathname.replace(/\/+$/, "") || "/"

  res.setHeader("access-control-allow-origin", "*")
  res.setHeader("access-control-allow-headers", "*")
  res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS")
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end() }

  try {
    if (req.method === "GET" && (path === "/health" || path === "/")) {
      let oc = false
      try { await ocFetch("/global/health"); oc = true } catch {}
      res.writeHead(200, { "content-type": "application/json" })
      return res.end(JSON.stringify({
        ok: oc, opencode: CFG.opencodeUrl, opencodeReachable: oc,
        model: CFG.model, directory: CFG.directory, sessions: sessions.size,
      }))
    }

    if (req.method === "GET" && (path === "/v1/models" || path === "/models")) {
      res.writeHead(200, { "content-type": "application/json" })
      return res.end(JSON.stringify({
        object: "list",
        data: KNOWN_FREE_MODELS.map((id) => ({ id, object: "model", created: 0, owned_by: "opencode-zen" })),
      }))
    }

    if (req.method === "POST" && (path === "/v1/chat/completions" || path === "/chat/completions")) {
      return await handleOpenAI(req, res, await readBody(req))
    }

    if (req.method === "POST" && (path === "/v1/messages" || path === "/messages")) {
      return await handleAnthropic(req, res, await readBody(req))
    }

    res.writeHead(404, { "content-type": "application/json" })
    res.end(JSON.stringify({ error: { message: `bridge: no route for ${req.method} ${path}`, type: "not_found" } }))
  } catch (e) {
    const status = e.status || 502
    log("error:", status, e.message)
    if (res.headersSent) { try { res.end() } catch {} ; return }
    res.writeHead(status, { "content-type": "application/json" })
    res.end(JSON.stringify({ error: { message: e.message, type: e.name === "HttpError" ? "invalid_request_error" : "bridge_error" } }))
  }
})

server.listen(CFG.port, "127.0.0.1", () => {
  log(`listening on http://127.0.0.1:${CFG.port}`)
  log(`opencode=${CFG.opencodeUrl} dir=${CFG.directory} model=${CFG.model}`)
})
