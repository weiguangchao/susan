# Workspace packages

The workspace contains three independently versioned packages:

- `core` publishes shared JSON types and guards.
- `harness` publishes the Agent Loop, Harness Assembly and built-in batteries.
- `tui` publishes the `susan` command and no library API.

Use pnpm 10.34.5 and the root lockfile. Run package commands with
`pnpm --filter <package-name> <script>`. Harness commands build core first; TUI
commands build Harness, which builds core. Every prerequisite uses `&&`.
Development rebuilds dependencies at startup only.

Common development tools belong to the root. Runtime dependencies belong to
consuming packages. TUI owns React types, terminal test dependencies and the Ink
patch; workspace patch registration stays in the root. Internal dependencies
use `workspace:~` per #122, yielding tilde ranges when packed.

## Versioning

The user chooses which packages to release and their versions. During 0.x,
compatible fixes and features increment the patch version. Incompatible public
API or user-visible behavior increments the minor version. An internal-only
refactor needs a release only when a new package artifact is required.

For every selected package, update its `package.json`, `CHANGELOG.md` and the
root lockfile, then run `pnpm install`. A package that needs a new dependency
declaration must receive a new version even when its source is unchanged. Do
not add Changesets. Tags use `core-v<version>`, `harness-v<version>` and
`tui-v<version>`.

Core acceptance:

```sh
pnpm install --frozen-lockfile
pnpm --filter @weiguangchao/susan-core typecheck
pnpm --filter @weiguangchao/susan-core test
pnpm --filter @weiguangchao/susan-core package:smoke
```

Run the full workspace checks and package smoke commands in the order documented
in `../docs/release-smoke.md`. Local success does not replace the required platform
and manual evidence.
