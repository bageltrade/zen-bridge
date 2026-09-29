// Minimal stand-in for https://opencode.ai/zen/v1 used to test the bridge
// without a real Zen key. Mirrors the OpenAI-compatible surface only.
import { createServer } from "node:http"

const PORT = Number(process.env.MOCK_ZEN_PORT || 4700)
const seen = []

const server = createServer(async (req, res) => {
  const chunks = []
  for await (const c of req) chunks.push(c)
  const raw = Buffer.concat(chunks).toString()
  let body = {}
  try { body = raw ? JSON.parse(raw) : {} } catch {}

  if (req.url.endsWith("/models")) {
    res.writeHead(200, { "content-type": "application/json" })
    return res.end(JSON.stringify({
      object: "list",
      data: [{ id: "space-bunny-free", object: "model", owned_by: "mock" }],
    }))
  }

  if (req.url.includes("/chat/completions")) {
    seen.push({ headers: req.headers, body })
    process.stderr.write(`[mock-zen] model=${body.model} ua=${req.headers["user-agent"]} ` +
      `x-opencode-client=${req.headers["x-opencode-client"]} ` +
      `x-opencode-session=${req.headers["x-opencode-session"]} ` +
      `auth=${req.headers.authorization ? "yes" : "no"}\n`)

    if (!body.messages?.length) {
      res.writeHead(400, { "content-type": "application/json" })
      return res.end(JSON.stringify({ error: { message: "no messages" } }))
    }

    const last = body.messages.filter((m) => m.role === "user").at(-1)
    const text = typeof last?.content === "string"
      ? last.content
      : (last?.content || []).map((p) => p.text || "").join("")

    if (body.stream) {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
      const base = { id: "mock-1", object: "chat.completion.chunk", created: 1, model: body.model }
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant" } }] })}\n\n`)
      for (const word of `MOCK_REPLY: ${text}`.split(" ")) {
        res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: word + " " } }] })}\n\n`)
      }
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`)
      res.write("data: [DONE]\n\n")
      return res.end()
    }

    res.writeHead(200, { "content-type": "application/json" })
    return res.end(JSON.stringify({
      id: "mock-1", object: "chat.completion", created: 1, model: body.model,
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: `MOCK_REPLY: ${text}` } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }, cost: "0",
    }))
  }

  res.writeHead(404, { "content-type": "application/json" })
  res.end(JSON.stringify({ error: { message: "not found" } }))
})

server.listen(PORT, "127.0.0.1", () => process.stderr.write(`[mock-zen] listening on ${PORT}\n`))
