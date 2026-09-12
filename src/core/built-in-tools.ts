import { createBashTool } from "./bash";
import { createEditTool } from "./edit";
import { createFindTool } from "./find";
import { createGrepTool } from "./grep";
import type { HarnessTool } from "./harness";
import { createLsTool } from "./ls";
import { createReadTool } from "./read";
import { createWriteTool } from "./write";

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
