# Susan core

Shared JSON types and guards. Requires Node.js >=22 <26. ESM only.

```ts
import { isRecord, isJsonValue } from "@weiguangchao/susan-core";
import type { JsonPrimitive, JsonValue, JsonObject } from "@weiguangchao/susan-core";
```

`isRecord` accepts non-null objects other than arrays. `isJsonValue` checks
finite numbers, strings, booleans, null, arrays and object values recursively.
These guards inspect parsed JSON-like data; they do not detect cycles or require
plain-object prototypes. Subpath imports are not supported.

Run `pnpm --filter @weiguangchao/susan-core typecheck`, `test`, `build` or
`package:smoke` from the workspace root. The smoke command builds and packs the
package, installs the original archive outside the repository and checks Node
and TypeScript consumers.
