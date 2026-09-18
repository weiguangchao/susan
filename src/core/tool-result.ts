import { isRecord } from "@weiguangchao/susan-core";

/**
 * Tool Result 基础设施的 Pi 形态（400d690）：
 * 结果 = `{ content, details }`；content 是面向模型的文本/图片块，
 * details 是面向日志与 UI 的结构化信息；工具失败时直接 throw，
 * 由 harness 捕获并转为 isError 的错误结果（见 harness 执行层）。
 */

/** 模型可见的文本内容块。 */
export type TextContent = {
  readonly type: "text";
  readonly text: string;
};

/** 模型可见的图片内容块（base64）。 */
export type ImageContent = {
  readonly type: "image";
  readonly data: string;
  readonly mimeType: string;
};

export type ToolResultContent = readonly (TextContent | ImageContent)[];

export type ToolResult<TDetails = unknown> = {
  readonly content: ToolResultContent;
  readonly details?: TDetails;
};

/** 工具 throw 后由 harness 构造的错误结果：message 转为 text content。 */
export function createErrorToolResult(message: string): ToolResult<undefined> {
  return {
    content: [{ type: "text", text: message }],
    details: undefined,
  };
}

/** 单文本块结果。 */
export function textToolResult(text: string): ToolResult<undefined> {
  return {
    content: [{ type: "text", text }],
    details: undefined,
  };
}

/** 提取结果中全部文本块（忽略图片块），供 provider 序列化与 UI 展示。 */
export function toolResultText(content: ToolResultContent): string {
  return content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

export function isToolResultContent(
  value: unknown,
): value is ToolResultContent {
  return (
    Array.isArray(value) &&
    value.every(
      (block) =>
        (isRecord(block) &&
          block.type === "text" &&
          typeof block.text === "string") ||
        (isRecord(block) &&
          block.type === "image" &&
          typeof block.data === "string" &&
          typeof block.mimeType === "string"),
    )
  );
}

export function isToolResult(value: unknown): value is ToolResult {
  return isRecord(value) && isToolResultContent(value.content);
}
