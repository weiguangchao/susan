// A minimal Anthropic Messages API server that speaks the real SSE wire
// format, so the provider can be tested without a key or a network.
import http from "node:http";

function send(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function messageStart(res, inputTokens) {
  send(res, "message_start", {
    type: "message_start",
    message: {
      id: "msg_fake",
      type: "message",
      role: "assistant",
      model: "claude-fake",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: inputTokens,
        output_tokens: 1,
        cache_read_input_tokens: 900,
        cache_creation_input_tokens: 100,
      },
    },
  });
}

function blockStart(res, index, block) {
  send(res, "content_block_start", {
    type: "content_block_start",
    index,
    content_block: block,
  });
}

function blockDelta(res, index, delta) {
  send(res, "content_block_delta", { type: "content_block_delta", index, delta });
}

function blockStop(res, index) {
  send(res, "content_block_stop", { type: "content_block_stop", index });
}

function messageEnd(res, stopReason, outputTokens) {
  send(res, "message_delta", {
    type: "message_delta",
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: outputTokens },
  });
  send(res, "message_stop", { type: "message_stop" });
  res.end();
}

export function startFakeAnthropic() {
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

      // Record the request shape so the test can assert on it.
      log.push({
        url: req.url,
        model: payload.model,
        max_tokens: payload.max_tokens,
        thinking: payload.thinking,
        output_config: payload.output_config,
        cache_control: payload.cache_control,
        system_head: String(payload.system ?? "").slice(0, 24),
        tools: (payload.tools ?? []).map((t) => ({
          name: t.name,
          eager: t.eager_input_streaming ?? false,
        })),
        messages: (payload.messages ?? []).map((m) => ({
          role: m.role,
          blocks: (Array.isArray(m.content) ? m.content : [{ type: "text" }]).map(
            (b) =>
              b.type === "thinking"
                ? `thinking(sig=${b.signature ?? "MISSING"})`
                : b.type === "tool_result"
                  ? `tool_result(${b.tool_use_id})`
                  : b.type,
          ),
        })),
      });

      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });

      const sawToolResult = (payload.messages ?? []).some(
        (m) =>
          Array.isArray(m.content) &&
          m.content.some((b) => b.type === "tool_result"),
      );
      const userText = (payload.messages ?? [])
        .filter((m) => m.role === "user")
        .flatMap((m) =>
          Array.isArray(m.content)
            ? m.content.filter((b) => b.type === "text").map((b) => b.text)
            : [m.content],
        )
        .join(" ");

      messageStart(res, 1200);

      if (sawToolResult) {
        // Second turn: plain answer, no more tools.
        blockStart(res, 0, { type: "text", text: "" });
        for (const piece of ["Read ", "the ", "results ", "above."]) {
          blockDelta(res, 0, { type: "text_delta", text: piece });
        }
        blockStop(res, 0);
        messageEnd(res, "end_turn", 48);
        return;
      }

      if (/refusal/.test(userText)) {
        // A refusal can cut a tool_use off mid-input: the loop must never run it.
        blockStart(res, 0, { type: "text", text: "" });
        blockDelta(res, 0, { type: "text_delta", text: "I can't " });
        blockStop(res, 0);
        blockStart(res, 1, { type: "tool_use", id: "toolu_r", name: "bash", input: {} });
        blockDelta(res, 1, { type: "input_json_delta", partial_json: '{"command": "echo ' });
        blockStop(res, 1);
        messageEnd(res, "refusal", 12);
        return;
      }

      if (/truncate/.test(userText)) {
        // Tool input cut off at max_tokens - it may still parse, so stop anyway.
        blockStart(res, 0, { type: "tool_use", id: "toolu_t", name: "write", input: {} });
        blockDelta(res, 0, { type: "input_json_delta", partial_json: '{"path": "x.txt", "content": "par' });
        blockStop(res, 0);
        messageEnd(res, "max_tokens", 12);
        return;
      }

      if (/paused/.test(userText)) {
        // pause_turn: the loop re-sends with the assistant turn appended.
        const turns = (payload.messages ?? []).filter((m) => m.role === "assistant").length;
        if (turns === 0) {
          blockStart(res, 0, { type: "text", text: "" });
          blockDelta(res, 0, { type: "text_delta", text: "Working... " });
          blockStop(res, 0);
          messageEnd(res, "pause_turn", 10);
        } else {
          blockStart(res, 0, { type: "text", text: "" });
          blockDelta(res, 0, { type: "text_delta", text: "Resumed and done." });
          blockStop(res, 0);
          messageEnd(res, "end_turn", 10);
        }
        return;
      }

      if (/parallel/.test(userText)) {
        blockStart(res, 0, { type: "text", text: "" });
        blockDelta(res, 0, { type: "text_delta", text: "Checking both. " });
        blockStop(res, 0);
        blockStart(res, 1, { type: "tool_use", id: "toolu_1", name: "ls", input: {} });
        blockDelta(res, 1, { type: "input_json_delta", partial_json: '{"path": "."}' });
        blockStop(res, 1);
        blockStart(res, 2, {
          type: "tool_use",
          id: "toolu_2",
          name: "read",
          input: {},
        });
        blockDelta(res, 2, {
          type: "input_json_delta",
          partial_json: '{"path": "notes.txt"}',
        });
        blockStop(res, 2);
        messageEnd(res, "tool_use", 60);
        return;
      }

      // First turn: a thinking block (with a signature that must survive replay),
      // then text, then a tool call whose input streams in fragments.
      blockStart(res, 0, { type: "thinking", thinking: "", signature: "" });
      for (const piece of ["I should ", "list the ", "directory first."]) {
        blockDelta(res, 0, { type: "thinking_delta", thinking: piece });
      }
      blockDelta(res, 0, {
        type: "signature_delta",
        signature: "SiGnAtUrE-abc123",
      });
      blockStop(res, 0);

      blockStart(res, 1, { type: "text", text: "" });
      for (const piece of ["Let ", "me ", "look. "]) {
        blockDelta(res, 1, { type: "text_delta", text: piece });
      }
      blockStop(res, 1);

      blockStart(res, 2, { type: "tool_use", id: "toolu_abc", name: "ls", input: {} });
      for (const piece of ['{"pa', 'th": ".", ', '"depth": 1}']) {
        blockDelta(res, 2, { type: "input_json_delta", partial_json: piece });
      }
      blockStop(res, 2);

      messageEnd(res, "tool_use", 72);
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        log,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}
