import { defineConfig } from "tsdown";

export default defineConfig({
  entry: { index: "src/index.ts" },
  format: "esm",
  dts: true,
  fixedExtension: false,
  exports: false,
  deps: { neverBundle: ["@weiguangchao/susan-core", "openai", "zod"] },
});
