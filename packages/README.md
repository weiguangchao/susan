# Workspace migration

This integration branch follows #122. #125 delivers core and the three-package
engineering skeleton. Harness source moves in #126, TUI in #127, and #128 removes
the remaining single-package files and updates release tooling. Do not publish
this intermediate checkout as a completed split.

- `core` and `harness` are buildable and independently consumable now.
- `tui` remains a private migration skeleton until #127. Its entry files and
  tests have not moved yet; no placeholder CLI is shipped.
- #126 moves Harness source, tests and fixtures into its package. Remaining
  root TUI files now import the Harness public root; their move belongs to #127.
- The remaining root `src`, `test`, `prototype`, release scripts and workflows
  await those tickets. Root product scripts and compiler/build configs have been
  removed. JSON has one implementation in core; remaining source imports its
  public package entry.

Use pnpm 10.34.5 and the root lockfile. Run package commands with
`pnpm --filter <package-name> <script>`. Harness commands build core first; TUI
commands build Harness, which builds core. Every prerequisite uses `&&`.
Development rebuilds dependencies at startup only.

Common development tools belong to the root. Runtime dependencies belong to
consuming packages. TUI owns React types, terminal test dependencies and the Ink
patch; workspace patch registration stays in the root. Internal dependencies
use `workspace:~` per #122, yielding tilde ranges when packed.

Core acceptance:

```sh
pnpm install --frozen-lockfile
pnpm --filter @weiguangchao/susan-core typecheck
pnpm --filter @weiguangchao/susan-core test
pnpm --filter @weiguangchao/susan-core package:smoke
```

This is not the complete workspace Release Gate or platform/manual acceptance.
