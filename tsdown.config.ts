import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    cli: "src/cli.ts",
    "image-resize-worker": "src/core/image-resize-worker.ts",
  },
  dts: false,
  format: "esm",
  fixedExtension: false,
  exports: false,
  // Ship the history-preserving Ink patch with the CLI. npm consumers do not
  // apply this repository's pnpm patchedDependencies.
  deps: {
    alwaysBundle: ["ink"],
    // Ink loads this optional peer only when React DevTools is requested.
    neverBundle: ["react-devtools-core"],
    onlyBundle: false,
  },
});
