// Loopback-only stand-in for the intranet model gateway. Answers every chat completion with
// "OK" and logs one line per request. Used only by the intranet dry run.
const http = require("http");
const fs = require("fs");
const LOG = process.argv[2];
const KEY = "test-key-123";

const server = http.createServer((request, response) => {
  let body = "";
  request.on("data", (chunk) => (body += chunk));
  request.on("end", () => {
    let parsed = null;
    try {
      parsed = JSON.parse(body);
    } catch {}
    const messages = parsed?.messages;
    const last = messages && messages.length ? messages[messages.length - 1] : null;
    let snippet = "";
    try {
      snippet = typeof last.content === "string" ? last.content : JSON.stringify(last.content);
    } catch {}
    fs.appendFileSync(
      LOG,
      JSON.stringify({
        method: request.method,
        url: request.url,
        model: parsed?.model,
        tools: parsed?.tools ? parsed.tools.length : 0,
        lastRole: last?.role,
        snippet: snippet.replace(/\s+/g, " ").slice(0, 90),
      }) + "\n",
    );
    if (request.headers.authorization !== `Bearer ${KEY}`) {
      response.writeHead(401, { "content-type": "application/json" });
      return response.end(
        JSON.stringify({ error: { message: "Invalid API key", type: "authentication_error" } }),
      );
    }
    if (!parsed) {
      response.writeHead(400);
      return response.end("{}");
    }
    const base = {
      id: "chatcmpl-mock",
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: parsed.model,
    };
    if (!parsed.stream) {
      response.writeHead(200, { "content-type": "application/json" });
      return response.end(
        JSON.stringify({
          ...base,
          object: "chat.completion",
          choices: [
            { index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
        }),
      );
    }
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const chunk = (delta, finish_reason) =>
      `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    response.write(chunk({ role: "assistant", content: "" }, null));
    response.write(chunk({ content: "OK" }, null));
    const lastChunk = { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
    if (parsed.stream_options?.include_usage) {
      lastChunk.usage = { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 };
    }
    response.write(`data: ${JSON.stringify(lastChunk)}\n\n`);
    response.write("data: [DONE]\n\n");
    response.end();
  });
});

server.listen(18475, "127.0.0.1", () => console.log("mock-gateway listening"));
