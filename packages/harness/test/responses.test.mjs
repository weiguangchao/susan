import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, it } from "node:test";
import { promisify } from "node:util";
import { Agent, ResponsesProvider, cacheHitRate } from "../dist/index.js";

let server;
let url;
const requests = [];
const execFileAsync = promisify(execFile);

before(async () => {
  server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body);
    requests.push({ url: req.url, payload });
    const hasResult = payload.input.some((item) => item.type === "function_call_output");
    const output = hasResult
      ? [{ id: "msg_2", type: "message", role: "assistant", status: "completed",
        content: [{ type: "output_text", text: "Done.", annotations: [] }] }]
      : [{ id: "call_1", type: "function_call", call_id: "call_1",
        name: "ls", arguments: '{"path":"."}', status: "completed" }];
    const response = { id: "resp_test", object: "response", status: "completed",
      output, usage: { input_tokens: 10, output_tokens: 5,
        input_tokens_details: { cached_tokens: 2 }, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 15 } };
    res.writeHead(200, { "content-type": "text/event-stream" });
    const emit = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
    if (hasResult) emit({ type: "response.output_text.delta", delta: "Done.", sequence_number: 1,
      content_index: 0, output_index: 0, item_id: "msg_2", logprobs: [] });
    else emit({ type: "response.output_item.added", item: output[0], sequence_number: 1, output_index: 0 });
    emit({ type: "response.completed", response, sequence_number: 2 });
    res.end("data: [DONE]\n\n");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${server.address().port}/v1`;
});
after(async () => { await new Promise((resolve) => server.close(resolve)); });

it("sends Responses function calls and results with configured reasoning", async () => {
  const provider = new ResponsesProvider({ model: "test-model", baseURL: url,
    apiKey: "test", maxTokens: 500, reasoningEffort: "high" });
  const agent = new Agent({ root: process.cwd(), provider });
  const events = [];
  for await (const event of agent.run("list files")) events.push(event);
  assert.equal(events.find((event) => event.type === "done")?.reason, "end_turn");
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, "/v1/responses");
  assert.deepEqual(requests[0].payload.reasoning, { effort: "high" });
  assert.equal(requests[0].payload.stream, true);
  assert.equal(requests[0].payload.max_output_tokens, 500);
  assert.ok(requests[1].payload.input.some((item) => item.type === "function_call_output" && item.call_id === "call_1"));
  assert.equal(cacheHitRate(agent.session.usage), 20);
});

it("loads confg.json through the CLI and sends its model settings", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "susan-cli-config-"));
  try {
    await writeFile(path.join(home, "confg.json"), JSON.stringify({ providers: {
      local: { baseUrl: url, type: "responses", apiKey: "test",
        model: { name: "Local", id: "configured-model", contextWindow: 10000,
          outputToken: 321, reasoningEffort: { low: null } } },
    } }));
    const beforeCount = requests.length;
    const { stdout } = await execFileAsync(process.execPath,
      [path.resolve("packages/tui/dist/cli.js"), "--prompt", "list files"],
      { env: { ...process.env, SUSAN_HOME: home }, cwd: process.cwd() });
    assert.match(stdout, /Done\./);
    assert.equal(requests[beforeCount].payload.model, "configured-model");
    assert.equal(requests[beforeCount].payload.max_output_tokens, 321);
    assert.equal(requests[beforeCount].payload.reasoning, undefined);
  } finally { await rm(home, { recursive: true, force: true }); }
});
