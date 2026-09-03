import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    cli: "src/cli.ts",
  },
  dts: false,
  format: "esm",
  fixedExtension: false,
  exports: false,
});
