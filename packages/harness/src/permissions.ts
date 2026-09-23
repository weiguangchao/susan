import type {
  PermissionDecision,
  PermissionHandler,
  PermissionMode,
  PermissionRequest,
  Tool,
} from "./types.js";

export interface PermissionVerdict {
  allowed: boolean;
  /** Why it was refused - fed back to the model as the tool result. */
  reason?: string;
}

/**
 * Decides whether a tool call runs. Safe (read-only) tools always pass; write
 * and exec tools go through the mode, then the session allowlist, then the user.
 */
export class PermissionGate {
  #mode: PermissionMode;
  #handler: PermissionHandler;
  #alwaysAllowed = new Set<string>();

  constructor(mode: PermissionMode, handler: PermissionHandler) {
    this.#mode = mode;
    this.#handler = handler;
  }

  get mode(): PermissionMode {
    return this.#mode;
  }

  setMode(mode: PermissionMode): void {
    this.#mode = mode;
  }

  /** Tool names the user approved for the rest of the session. */
  get allowlist(): readonly string[] {
    return [...this.#alwaysAllowed];
  }

  resetAllowlist(): void {
    this.#alwaysAllowed.clear();
  }

  async check(
    tool: Tool,
    request: PermissionRequest,
  ): Promise<PermissionVerdict> {
    if (tool.risk === "safe") return { allowed: true };

    if (this.#mode === "readonly") {
      return {
        allowed: false,
        reason:
          "susan is in read-only mode, so this tool is unavailable. Tell the user what you would have done and let them switch modes.",
      };
    }

    if (this.#mode === "auto") return { allowed: true };

    if (this.#alwaysAllowed.has(tool.name)) return { allowed: true };

    const decision: PermissionDecision = await this.#handler(request);

    if (decision === "allow_always") {
      this.#alwaysAllowed.add(tool.name);
      return { allowed: true };
    }
    if (decision === "allow") return { allowed: true };

    return {
      allowed: false,
      reason:
        "The user declined this tool call. Do not retry it as-is - ask them how they would like to proceed instead.",
    };
  }
}
