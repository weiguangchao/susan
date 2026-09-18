import { expect, it } from "vitest";
import { createCompletedToolCard } from "../src/ui/tool-ledger";
it("renders an image attachment summary without its bytes", () => {
 const png = Buffer.from("image");
 const cwd = process.cwd();
 const result = { content: [{ type: "image" as const, data: png.toString("base64"), mimeType: "image/png" }] };
  const card = createCompletedToolCard({id: "a", name: "read", arguments: { path: "a.png" }}, result, false, cwd);
  expect(card.summary).toBe("image/png");
  expect(JSON.stringify(card)).not.toContain(png.toString("base64"));
});
