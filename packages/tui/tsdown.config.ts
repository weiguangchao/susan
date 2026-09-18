import { defineConfig } from "tsdown";

export default defineConfig({
  entry: { cli: "src/cli.ts" },
  format: "esm",
  dts: false,
  fixedExtension: false,
  exports: false,
  deps: { alwaysBundle: ["ink"], neverBundle: ["@weiguangchao/susan-core", "@weiguangchao/susan-harness", "react-devtools-core"], onlyBundle: false },
});
