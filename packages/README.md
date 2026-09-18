# Workspace migration

This integration branch follows #122. #125 delivers core and the three-package
engineering skeleton. Harness source moves in #126, TUI in #127, and #128 removes
the remaining single-package files and updates release tooling. Do not publish
this intermediate checkout as a completed split.

- `core` is buildable and independently consumable now.
- `harness` and `tui` are private migration skeletons. Their configured entry
  files and tests arrive in #126 and #127. Their build/test commands intentionally
  cannot pass until that source moves; no placeholder library or CLI is shipped.
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
