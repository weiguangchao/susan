import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createReadTool } from "../src/core/read";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAEElEQVR4AQEFAPr/AP8AAP8FAAH/+lyI0QAAAABJRU5ErkJggg==", "base64");
it("reads magic-detected images as attachments even with text pagination arguments", async () => {
 const cwd = await mkdtemp(join(tmpdir(), "susan-images-"));
 try {
  await writeFile(join(cwd, "image.txt"), png);
  const result = await createReadTool({ sessionCwd: cwd }).execute({ path: "image.txt", offset: 999, limit: 1 });
  expect(result.content).toEqual([{ type: "text", text: "Read image file [image/png]" }, { type: "image", data: png.toString("base64"), mimeType: "image/png" }]);
 } finally { await rm(cwd, { recursive: true, force: true }); }
});

import { PhotonImage } from "@silvia-odwyer/photon-node";
import { detectSupportedImageMimeType } from "../src/core/mime";
import { processImage } from "../src/core/image-process";
import { resizeImage } from "../src/core/image-resize";
import { createOpenAICompletionAdapter } from "../src/adapters/openai-completion";
import { createSessionStore } from "../src/core/session";
import { createCompletedToolCard } from "../src/ui/tool-ledger";
import { estimateMessageTokens } from "../src/core/context";
import type { CompletionMessage, ProviderRequest } from "../src/core/provider";

it("rejects JPEG-LS, APNG, and incomplete BMP headers like Pi", () => {
 expect(detectSupportedImageMimeType(new Uint8Array([255, 216, 255, 247]))).toBeNull();
 expect(detectSupportedImageMimeType(Buffer.from("BM"))).toBeNull();
 const actl = Buffer.alloc(20); actl.writeUInt32BE(8); actl.write("acTL", 4);
 expect(detectSupportedImageMimeType(Buffer.concat([png.subarray(0, 33), actl, png.subarray(33)]))).toBeNull();
 expect(detectSupportedImageMimeType(png)).toBe("image/png");
});

it("preserves image blocks for non-vision models and renders an attachment summary", async () => {
 const cwd = await mkdtemp(join(tmpdir(), "susan-images-"));
 try {
  await writeFile(join(cwd, "a.png"), png);
  const result = await createReadTool({ sessionCwd: cwd }).execute({ path: "a.png" }, undefined, { modelInput: ["text"] });
  expect(result.content[0]).toEqual({type: "text", text: "Read image file [image/png]\n[Current model does not support images. The image will be omitted from this request.]"});
  expect(result.content[1]?.type).toBe("image");
  const card = createCompletedToolCard({id: "a", name: "read", arguments: { path: "a.png" }}, result, false, cwd);
  expect(card.summary).toBe("image/png");
  expect(JSON.stringify(card)).not.toContain(png.toString("base64"));
  const store = createSessionStore({ sessionsDirectory: join(cwd, "sessions") });
  const created = await store.createSession({ cwd });
  if (!created.ok) throw new Error("create failed");
  const message: CompletionMessage = {role: "tool", toolCallId: "a", content: result.content};
  expect((await store.appendMessage(created.value.header.id, message)).ok).toBe(true);
  const loaded = await store.loadSession(created.value.header.id);
  if (!loaded.ok) throw new Error("load failed");
  expect(loaded.value.messages).toEqual([message]);
  expect(estimateMessageTokens(message)).toBeGreaterThanOrEqual(1200);
 } finally { await rm(cwd, { recursive: true, force: true }); }
});

it("resizes images to 2000 pixels and enforces base64 budget", async () => {
 const image = new PhotonImage(new Uint8Array(2400 * 10 * 4).fill(255), 2400, 10);
 try {
  const result = await resizeImage(image.get_bytes(), "image/png");
  expect(result).toMatchObject({ width: 2000, originalWidth: 2400, wasResized: true });
  expect(result!.data.length).toBeLessThan(4.5 * 1024 * 1024);
  expect(await resizeImage(png, "image/png", { maxBytes: 1 })).toBeNull();
 } finally { image.free(); }
});

it("converts BMP to PNG and returns Pi omission text for invalid images", async () => {
 const bmp = Buffer.alloc(58);
 bmp.write("BM"); bmp.writeUInt32LE(58, 2); bmp.writeUInt32LE(54, 10);
 bmp.writeUInt32LE(40, 14); bmp.writeInt32LE(1, 18); bmp.writeInt32LE(1, 22);
 bmp.writeUInt16LE(1, 26); bmp.writeUInt16LE(24, 28); bmp.writeUInt32LE(4, 34); bmp[56] = 255;
 expect(detectSupportedImageMimeType(bmp)).toBe("image/bmp");
 const result = await processImage(bmp, "image/bmp");
 expect(result).toMatchObject({ok: true, mimeType: "image/png", hints: ["[Image converted from image/bmp to image/png.]"]});
 expect(await processImage(Buffer.from("bad"), "image/bmp")).toEqual({ok: false, message: "[Image omitted: could not be converted to a supported inline image format.]"});
 expect(await processImage(Buffer.from("bad"), "image/png")).toEqual({ok: false, message: "[Image omitted: could not be resized below the inline image size limit.]"});
});

it.each([true, false])("batches tool results before image attachments, vision=%s", async (vision) => {
 let wire: any;
 const client = createOpenAICompletionAdapter(() => ({chat: {completions: {async create(body) {
  wire = body;
  return { choices: [{ message: { content: "ok" }, finish_reason: "stop" }] };
 }}}})).createClient({type: "openai-completion", apiKey: "test", baseURL: new URL("https://example.com")});
 const request: ProviderRequest = {model: "test", modelInput: vision ? ["text", "image"] : ["text"], messages: [
  { role: "assistant", toolCalls: [{id: "a", name: "read", arguments: {}}, {id: "b", name: "read", arguments: {}}] },
  { role: "tool", toolCallId: "a", content: [{type: "image", data: "YQ==", mimeType: "image/png"}] },
  { role: "tool", toolCallId: "b", content: [{type: "text", text: "second"}, {type: "image", data: "Yg==", mimeType: "image/jpeg"}] },
 ]};
 await client.complete(request, new AbortController().signal);
 expect(wire.messages.map((m: any) => m.role)).toEqual(vision ? ["assistant", "tool", "tool", "user"] : ["assistant", "tool", "tool"]);
 expect(wire.messages[1].content).toBe("(see attached image)");
 if (vision) expect(wire.messages[3].content).toEqual([
  {type: "text", text: "Attached image(s) from tool result:"},
  {type: "image_url", image_url: {url: "data:image/png;base64,YQ=="}},
  {type: "image_url", image_url: {url: "data:image/jpeg;base64,Yg=="}},
 ]);
 expect(request.messages).toHaveLength(3);
});

import { createHarness } from "../src/core/harness";
import type { ProviderClient, ProviderStreamEvent } from "../src/core/provider";

it("passes live model capability through Harness requests and read execution across model switches", async () => {
 const cwd = await mkdtemp(join(tmpdir(), "susan-images-loop-"));
 try {
  await writeFile(join(cwd, "a.png"), png);
  const store = createSessionStore({ sessionsDirectory: join(cwd, "sessions") });
  const created = await store.createSession({ cwd });
  if (!created.ok) throw new Error("create failed");
  const requests: ProviderRequest[] = [];
  const provider: ProviderClient = {
   type: "openai-completion",
   async *stream(request): AsyncGenerator<ProviderStreamEvent> {
    requests.push(request);
    const call = requests.length;
    yield { type: "response-complete", response: call % 2
     ? { assistant: {role: "assistant", toolCalls: [{id: `call-${call}`, name: "read", arguments: {path: "a.png"}}]}, finishReason: "tool_calls" }
     : { assistant: {role: "assistant", content: "done"}, finishReason: "stop" } };
   },
   async complete() { throw new Error("unexpected compaction"); },
  };
  const harness = createHarness({ provider, sessionStore: store, session: created.value, model: "text-model", reasoningEffort: "low", contextWindow: 128000, maxOutputTokens: 1000, tools: [createReadTool({sessionCwd: cwd})] });
  expect(await harness.dispatch({type: "submit", content: "Read the image"})).toEqual({ok: true});
  expect(requests[1]?.modelInput).toEqual(["text"]);
  const textModelResult = requests[1]?.messages.find((m) => m.role === "tool");
  expect(JSON.stringify(textModelResult)).toContain("Current model does not support images");
  expect(await harness.dispatch({type: "configure-model", provider, model: "vision-model", modelInput: ["text", "image"], reasoningEffort: "low", contextWindow: 128000, maxOutputTokens: 1000})).toEqual({ok: true});
  expect(await harness.dispatch({type: "submit", content: "Read again"})).toEqual({ok: true});
  expect(requests[3]?.modelInput).toEqual(["text", "image"]);
  const toolMessages = requests[3]!.messages.filter((m) => m.role === "tool");
  expect(toolMessages).toHaveLength(2);
  expect(JSON.stringify(toolMessages[1])).not.toContain("Current model does not support images");
  expect(toolMessages.every((m) => m.content.some((b) => b.type === "image"))).toBe(true);
 } finally { await rm(cwd, {recursive: true, force: true}); }
});

import { resolveConfig } from "../src/core/config";
it("resolves explicit model input capabilities without changing existing model defaults", () => {
 const adapter = createOpenAICompletionAdapter();
 const adapters = new Map([[adapter.type, adapter]]);
 const result = resolveConfig(adapters, {
  defaultProvider: "test", defaultModel: "vision", defaultReasoningEffort: "low",
  providers: { test: {type: "openai-completion", apiKey: "test", models: [{id: "vision", input: ["text", "image"]}]} },
 });
 expect(result).toMatchObject({ok: true, config: {activeModel: {modelInput: ["text", "image"]}}});
});
