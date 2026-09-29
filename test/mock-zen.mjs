// Minimal stand-in for https://opencode.ai/zen/v1 used to test the bridge
// without a real Zen key. Mirrors the OpenAI + Anthropic surfaces, including
// tool calling, so tool behaviour can be regression-tested offline.
import { createServer } from "node:http"

const PORT = Number(process.env.MOCK_ZEN_PORT || 4700)
const REPLY = "MOCK_REPLY: "

function userText(messages) {
  const last = (messages || []).filter((m) => m.role === "user").at(-1)
  if (!last) return ""
  if (typeof last.content === "string") return last.content
  return (last.content || []).map((p) => p.text || "").join("")
}

// Emit a call to the caller's first tool so tool pass-through can be asserted
// end to end -- but only on a short transcript. A real agent (opencode) loops:
// it executes the tool, appends the result, and calls again, growing the message
// list every turn. Capping on length keeps the mock from spinning forever while
// still covering a single-shot tool call.
function firstToolName(tools, messageCount) {
  const t = (tools || [])[0]
  if (!t) return null
  if ((messageCount || 0) > 2) return null
  return t.function ? t.function.name : t.name
}

const server = createServer(async (req, res) => {
  const chunks = []
  for await (const c of req) chunks.push(c)
  const raw = Buffer.concat(chunks).toString()
  let body = {}
  try { body = raw ? JSON.parse(raw) : {} } catch {}

  const url = req.url || ""

  if (url.endsWith("/models")) {
    res.writeHead(200, { "content-type": "application/json" })
    return res.end(JSON.stringify({
      object: "list",
      // opencode builds its catalog from this endpoint, so the models the
      // tests route through opencode must be advertised here.
      data: ["space-bunny-free", "grok-4.5"].map((id) => ({ id, object: "model", owned_by: "mock" })),
    }))
  }

  // oc=1 marks traffic that came through the real opencode binary, so tests can
  // assert on the OpenCode path specifically and ignore direct passthrough.
  const viaOpencode = req.headers["x-opencode-session"] ? 1 : 0
  process.stderr.write(`[mock-zen] oc=${viaOpencode} ${req.method} ${url} ` +
    `stream=${!!body.stream} tools=${(body.tools || []).length} msgs=${(body.messages || []).length}\n`)

  const isMessages = url.includes("/messages")
  if (!isMessages && !url.includes("/chat/completions")) {
    res.writeHead(404, { "content-type": "application/json" })
    return res.end(JSON.stringify({ error: { message: "not found" } }))
  }

  const messages = isMessages ? body.messages : body.messages
  const tool = firstToolName(body.tools, (body.messages || []).length)
  const text = `${REPLY}${userText(messages)}`

  if (!messages?.length) {
    res.writeHead(400, { "content-type": "application/json" })
    return res.end(JSON.stringify({ error: { message: "no messages" } }))
  }

  const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }

  // ---- Anthropic wire format
  if (isMessages) {
    if (body.stream) {
      res.writeHead(200, { "content-type": "text/event-stream" })
      const ev = (t, d) => res.write(`event: ${t}\ndata: ${JSON.stringify(d)}\n\n`)
      ev("message_start", { type: "message_start", message: { id: "mock-1", type: "message",
        role: "assistant", model: body.model, content: [], stop_reason: null,
        stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } })
      if (tool) {
        ev("content_block_start", { type: "content_block_start", index: 0,
          content_block: { type: "tool_use", id: "mock_tool_1", name: tool, input: {} } })
        ev("content_block_delta", { type: "content_block_delta", index: 0,
          delta: { type: "input_json_delta", partial_json: '{"city":"Paris"}' } })
        ev("content_block_stop", { type: "content_block_stop", index: 0 })
        ev("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null },
          usage: { output_tokens: 1 } })
      } else {
        ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })
        for (const w of text.split(" ")) {
          ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: w + " " } })
        }
        ev("content_block_stop", { type: "content_block_stop", index: 0 })
        ev("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 1 } })
      }
      ev("message_stop", { type: "message_stop" })
      return res.end()
    }
    res.writeHead(200, { "content-type": "application/json" })
    return res.end(JSON.stringify({
      id: "mock-1", type: "message", role: "assistant", model: body.model,
      content: tool
        ? [{ type: "text", text: "calling" }, { type: "tool_use", id: "mock_tool_1", name: tool, input: { city: "Paris" } }]
        : [{ type: "text", text }],
      stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null, usage, cost: "0",
    }))
  }

  // ---- OpenAI wire format
  const base = { id: "mock-1", object: "chat.completion.chunk", created: 1, model: body.model }
  if (body.stream) {
    res.writeHead(200, { "content-type": "text/event-stream" })
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant" } }] })}\n\n`)
    if (tool) {
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { tool_calls: [
        { index: 0, id: "mock_tool_1", type: "function", function: { name: tool, arguments: '{"city":"Paris"}' } }] } }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage })}\n\n`)
    } else {
      for (const w of text.split(" ")) {
        res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: w + " " } }] })}\n\n`)
      }
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage })}\n\n`)
    }
    res.write("data: [DONE]\n\n")
    return res.end()
  }

  res.writeHead(200, { "content-type": "application/json" })
  return res.end(JSON.stringify({
    id: "mock-1", object: "chat.completion", created: 1, model: body.model,
    choices: [{ index: 0, finish_reason: tool ? "tool_calls" : "stop", message: {
      role: "assistant", content: tool ? "calling" : text,
      ...(tool ? { tool_calls: [{ index: 0, id: "mock_tool_1", type: "function",
        function: { name: tool, arguments: '{"city":"Paris"}' } }] } : {}),
    } }],
    usage, cost: "0",
  }))
})

server.listen(PORT, "127.0.0.1", () => process.stderr.write(`[mock-zen] listening on ${PORT}\n`))
