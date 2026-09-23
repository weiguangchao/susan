// A minimal OpenAI-compatible Chat Completions server that speaks the real
// wire format, so the provider can be tested without a key or a network.
import http from "node:http";

function sse(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

function chunk(delta, finish = null) {
  return {
    id: "chatcmpl-fake",
    object: "chat.completion.chunk",
    created: 1,
    model: "fake-model",
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
}

export function startFakeOpenAI() {
  const log = [];
    const server = http.createServer((req, res) => {
    if (req.url === "/__log") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(log, null, 2));
      return;
    }

    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const payload = JSON.parse(body);
      log.push({
        system: payload.messages.find((m) => m.role === "system")?.content,
        roles: payload.messages.map((m) =>
          m.role === "assistant" && m.tool_calls
            ? `assistant+tool_calls(${m.tool_calls.length})`
            : m.role,
        ),
        toolNames: (payload.tools ?? []).map((t) => t.function.name),
        stream_options: payload.stream_options ?? null,
        max_tokens: payload.max_tokens,
        reasoning_effort: payload.reasoning_effort,
      });

      const sawToolResult = payload.messages.some((m) => m.role === "tool");
      const userText = payload.messages.filter((m) => m.role === "user").map((m) => m.content).join(" ");

      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });

      if (!sawToolResult && /parallel/.test(userText)) {
        // Two tool calls in one turn: each needs its own `tool` message back.
        sse(res, chunk({ role: "assistant", content: "Checking both. " }));
        sse(res, chunk({ tool_calls: [
          { index: 0, id: "call_1", type: "function", function: { name: "ls", arguments: '{"path": "."}' } },
          { index: 1, id: "call_2", type: "function", function: { name: "read", arguments: '{"path": "notes.txt"}' } },
        ] }));
        sse(res, chunk({}, "tool_calls"));
      } else if (!sawToolResult && /broken/.test(userText)) {
        // Arguments that are not valid JSON at all.
        sse(res, chunk({ tool_calls: [
          { index: 0, id: "call_bad", type: "function", function: { name: "read", arguments: '{"path": "notes.txt' } },
        ] }));
        sse(res, chunk({}, "tool_calls"));
      } else if (!sawToolResult) {
        // Turn 1: some text, then a tool call split across chunks. The id and
        // name arrive only in the first fragment, arguments trickle in after.
        sse(res, chunk({ role: "assistant", content: "" }));
        for (const piece of ["Let ", "me ", "check ", "the ", "files. "]) {
          sse(res, chunk({ content: piece }));
        }
        sse(
          res,
          chunk({
            tool_calls: [
              {
                index: 0,
                id: "call_abc123",
                type: "function",
                function: { name: "ls", arguments: "" },
              },
            ],
          }),
        );
        for (const piece of ['{"pa', 'th": ".", ', '"depth": 1}']) {
          sse(
            res,
            chunk({
              tool_calls: [{ index: 0, function: { arguments: piece } }],
            }),
          );
        }
        sse(res, chunk({}, "tool_calls"));
      } else {
        // Turn 2: the model answers using the tool result.
        for (const piece of ["Found ", "the ", "listing ", "above."]) {
          sse(res, chunk({ content: piece }));
        }
        sse(res, chunk({}, "stop"));
      }

      // Final usage chunk, as sent when stream_options.include_usage is set.
      res.write(
        `data: ${JSON.stringify({
          id: "chatcmpl-fake",
          object: "chat.completion.chunk",
          created: 1,
          model: "fake-model",
          choices: [],
          usage: {
            prompt_tokens: 1200,
            completion_tokens: 48,
            total_tokens: 1248,
            prompt_tokens_details: { cached_tokens: 900 },
          },
        })}\n\n`,
      );
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}/v1`,
        log,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}
