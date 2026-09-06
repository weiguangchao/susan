import { createBashTool } from "./bash.js";
import { createEditTool } from "./edit.js";
import { createFindTool } from "./find.js";
import { createGrepTool } from "./grep.js";
import type { HarnessTool } from "./harness.js";
import { createLsTool } from "./ls.js";
import { createReadTool } from "./read.js";
import { createWriteTool } from "./write.js";

export type BuiltInToolSetOptions = {
  readonly sessionCwd: string;
};

export function createBuiltInToolSet(
  options: BuiltInToolSetOptions,
): readonly HarnessTool[] {
  const { sessionCwd } = options;
  return [
    createReadTool({ sessionCwd }),
    createWriteTool({ sessionCwd }),
    createEditTool({ sessionCwd }),
    createBashTool({ sessionCwd }),
    createGrepTool({ sessionCwd }),
    createFindTool({ sessionCwd }),
    createLsTool({ sessionCwd }),
  ];
}
