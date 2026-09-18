import type { HarnessAssembly } from "@weiguangchao/susan-harness";

// Rendering-only fixtures never switch Session or configure a model.
export const unusedAssembly: HarnessAssembly = {
  async assemble() {
    throw new Error("Unexpected Session switch in rendering test");
  },
  async reload() {
    throw new Error("Unexpected reload in rendering test");
  },
  async applyModelSelection() {
    return {
      kind: "startup-error",
      error: { stage: "operation", code: "TEST_UNUSED", message: "not used" },
    };
  },
};
