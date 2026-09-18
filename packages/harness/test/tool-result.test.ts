import { describe, expect, it } from "vitest";
import { createErrorToolResult } from "../src/core/tool-result";
import { isToolResult, isToolResultContent, textToolResult, toolResultText, type TextContent, type ToolResult } from "../src/index";

describe("Tool Result (Pi form)", () => {
  it("builds an error result from a free-text message", () => {
    expect(createErrorToolResult("File not found.")).toEqual({
      content: [{ type: "text", text: "File not found." }],
      details: undefined,
    });
  });

  it("builds a single text block result", () => {
    expect(textToolResult("ok")).toEqual({
      content: [{ type: "text", text: "ok" }],
      details: undefined,
    });
  });

  it("joins text blocks and ignores image blocks when flattening", () => {
    const content = [
      { type: "text" as const, text: "first" },
      { type: "image" as const, data: "aGk=", mimeType: "image/png" },
      { type: "text" as const, text: "second" },
    ];
    expect(toolResultText(content)).toBe("first\nsecond");
    expect(toolResultText([])).toBe("");
  });

  it("validates content arrays structurally", () => {
    expect(isToolResultContent([{ type: "text", text: "hi" }])).toBe(true);
    expect(
      isToolResultContent([
        { type: "image", data: "aGk=", mimeType: "image/jpeg" },
      ]),
    ).toBe(true);
    expect(isToolResultContent([{ type: "text", text: 1 }])).toBe(false);
    expect(isToolResultContent([{ type: "image", data: "aGk=" }])).toBe(false);
    expect(isToolResultContent("text")).toBe(false);
    expect(isToolResultContent([{}])).toBe(false);
  });

  it("recognizes result objects with valid content", () => {
    const result: ToolResult = {
      content: [{ type: "text", text: "done" }],
      details: { totalLines: 3 },
    };
    expect(isToolResult(result)).toBe(true);
    expect(isToolResult({ content: "done" })).toBe(false);
    expect(isToolResult({})).toBe(false);
  });

  it("keeps text content JSON-safe for session persistence", () => {
    const block: TextContent = { type: "text", text: "line\nwith\ttabs" };
    expect(JSON.parse(JSON.stringify(block))).toEqual(block);
  });
});
