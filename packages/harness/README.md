# Susan Harness

`@weiguangchao/susan-harness` is an ESM library for running Susan's Agent Loop
without a terminal client. It requires Node 22–25 and depends on
`@weiguangchao/susan-core` for JSON contracts.

Import from the package root. Internal paths are not public API. The root exports
27 values and 98 types; it does not re-export core's JSON types.

```js
import { createHarnessAssembly } from "@weiguangchao/susan-harness";

const assembly = createHarnessAssembly({ susanHomeParent: "/absolute/home-parent" });
const result = await assembly.assemble({
  session: { kind: "new" },
  newSessionCwd: "/absolute/project",
});
if (result.kind === "ready") {
  // Requires a complete model selection in <home-parent>/.susan/config.json.
  const completed = await result.harness.dispatch({ type: "submit", content: "List this directory" });
  console.log(completed, result.harness.getSnapshot());
}
```

Assembly returns `ready`, `session-picker`, `config-error`, or `startup-error`.
It never renders, changes process cwd, or requests the Provider during assembly.
Config stays locked until `reload()`. `applyModelSelection()` saves and applies
an explicit selection. Use `createHarness` with your own Provider, Tools and
Session Store when the built-in assembly does not fit your host.

From the workspace, run:

```sh
pnpm --filter @weiguangchao/susan-harness typecheck
pnpm --filter @weiguangchao/susan-harness test
pnpm --filter @weiguangchao/susan-harness package:smoke
```

Each command builds core first. Package smoke packs core and Harness, installs
the original archives in a temporary directory outside the workspace, and checks
ordinary Node execution and TypeScript declarations. A temporary local registry
supplies the core archive through the consumer's scoped npm configuration.
No archive is rewritten, and no workspace source link is used. Third-party
packages still require registry access. This check is not the complete Release
Gate or platform/manual acceptance.
