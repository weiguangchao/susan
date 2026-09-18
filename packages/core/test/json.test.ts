import { expect, it } from "vitest";
import { isJsonValue, isRecord } from "../src/index.js";

it("narrows records without accepting null or arrays", () => {
  expect(isRecord({ value: undefined })).toBe(true);
  for (const value of [null, [], 1, "text", true, undefined]) {
    expect(isRecord(value)).toBe(false);
  }
});

it("accepts nested JSON and rejects non-JSON values at any depth", () => {
  expect(isJsonValue({ values: [null, true, "text", 42, { empty: [] }] })).toBe(true);
  for (const value of [undefined, NaN, Infinity, -Infinity, 1n, Symbol(), () => {}]) {
    expect(isJsonValue(value)).toBe(false);
    expect(isJsonValue({ nested: [value] })).toBe(false);
  }
});
