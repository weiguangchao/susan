import assert from "node:assert/strict";
import { it } from "node:test";
import { cacheHitRate } from "../dist/index.js";

it("reports no rate before usage arrives and zero for an uncached request", () => {
  assert.equal(cacheHitRate({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }), null);
  assert.equal(cacheHitRate({ inputTokens: 100, outputTokens: 10, cacheReadTokens: 0 }), 0);
});
