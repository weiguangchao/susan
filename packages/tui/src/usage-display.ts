import type { Usage } from "@susan/harness";

export interface UsageDisplay {
  usage: Usage | null;
  measuredTotal: Usage;
}
