// Ported from Pi 400d690 (MIT). Adaptation: Susan string content + toolCalls.
import type { CompletionMessage } from "../provider.js";
import { isRecord } from "../json.js";

/** File paths touched by a session branch or compaction range. */
export interface FileOperations {
	/** Files read but not necessarily modified. */
	read: Set<string>;
	/** Files written by full-file write operations. */
	written: Set<string>;
	/** Files modified by edit operations. */
	edited: Set<string>;
}

/** Create an empty file-operation accumulator. */
export function createFileOps(): FileOperations {
	return {
		read: new Set(),
		written: new Set(),
		edited: new Set(),
	};
}

/** Add file operations from assistant tool calls to an accumulator. */
export function extractFileOpsFromMessage(message: CompletionMessage, fileOps: FileOperations): void {
  if (message.role !== "assistant") return;
  for (const call of message.toolCalls ?? []) {
    const args = call.arguments;
    if (!isRecord(args) || typeof args.path !== "string" || !args.path) continue;
    switch (call.name) {
      case "read": fileOps.read.add(args.path); break;
      case "write": fileOps.written.add(args.path); break;
      case "edit": fileOps.edited.add(args.path); break;
    }
  }
}

/** Compute sorted read-only and modified file lists from accumulated operations. */
export function computeFileLists(fileOps: FileOperations): { readFiles: string[]; modifiedFiles: string[] } {
	const modified = new Set([...fileOps.edited, ...fileOps.written]);
	const readOnly = [...fileOps.read].filter((f) => !modified.has(f)).sort();
	const modifiedFiles = [...modified].sort();
	return { readFiles: readOnly, modifiedFiles };
}

/** Format file lists as summary metadata tags. */
export function formatFileOperations(readFiles: string[], modifiedFiles: string[]): string {
	const sections: string[] = [];
	if (readFiles.length > 0) {
		sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
	}
	if (modifiedFiles.length > 0) {
		sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
	}
	if (sections.length === 0) return "";
	return `\n\n${sections.join("\n\n")}`;
}

const TOOL_RESULT_MAX_CHARS = 2000;

function safeJsonStringify(value: unknown): string {
	try {
		return JSON.stringify(value) ?? "undefined";
	} catch {
		return "[unserializable]";
	}
}

function truncateForSummary(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	const truncatedChars = text.length - maxChars;
	return `${text.slice(0, maxChars)}\n\n[... ${truncatedChars} more characters truncated]`;
}

/** Serialize LLM messages to plain text for summarization prompts. */
export function serializeConversation(messages: readonly CompletionMessage[]): string {
  const parts: string[] = [];
  for (const msg of messages) {
    if (msg.role === "user") {
      if (msg.content) parts.push(`[User]: ${msg.content}`);
    } else if (msg.role === "assistant") {
      if (msg.reasoning !== undefined) parts.push(`[Assistant thinking]: ${msg.reasoning}`);
      if (msg.content !== undefined) parts.push(`[Assistant]: ${msg.content}`);
      const toolCalls = (msg.toolCalls ?? []).map((call) => {
        const args = isRecord(call.arguments) ? call.arguments : {};
        const argsStr = Object.entries(args).map(([k, v]) => `${k}=${safeJsonStringify(v)}`).join(", ");
        return `${call.name}(${argsStr})`;
      });
      if (toolCalls.length > 0) parts.push(`[Assistant tool calls]: ${toolCalls.join("; ")}`);
    } else if (msg.role === "tool") {
      const content = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("");
      if (content) parts.push(`[Tool result]: ${truncateForSummary(content, TOOL_RESULT_MAX_CHARS)}`);
    }
  }
  return parts.join("\n\n");
}
