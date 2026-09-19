import { toolResultText } from "../../core/tool-result";
import type { ProviderRequest } from "../../core/provider";

export function toChatCompletionsRequest(
  request: ProviderRequest,
  stream = true,
): Record<string, unknown> {
  const messages: Record<string, unknown>[] = [];
  for (let index = 0; index < request.messages.length; index++) {
    const message = request.messages[index];
    if (message.role === "system" || message.role === "user") {
      messages.push({ role: message.role, content: message.content });
      continue;
    }

    if (message.role === "tool") {
      const images: Record<string, unknown>[] = [];
      do {
        const tool = request.messages[index];
        if (tool.role !== "tool") break;
        const hasImages = tool.content.some((block) => block.type === "image");
        messages.push({
          role: "tool",
          tool_call_id: tool.toolCallId,
          content: toolResultText(tool.content) || (hasImages ? "(see attached image)" : "(no tool output)"),
        });
        if (request.modelInput?.includes("image")) {
          for (const block of tool.content) {
            if (block.type === "image") images.push({
              type: "image_url",
              image_url: { url: `data:${block.mimeType};base64,${block.data}` },
            });
          }
        }
        index++;
      } while (index < request.messages.length && request.messages[index].role === "tool");
      index--;
      if (images.length) messages.push({
        role: "user",
        content: [{ type: "text", text: "Attached image(s) from tool result:" }, ...images],
      });
      continue;
    }

    const assistant: Record<string, unknown> = {
      role: "assistant",
    };

    if (message.content !== undefined) {
      assistant.content = message.content;
    }

    if (message.toolCalls !== undefined) {
      assistant.tool_calls = message.toolCalls.map((toolCall) => ({
        id: toolCall.id,
        type: "function",
        function: {
          name: toolCall.name,
          arguments: JSON.stringify(toolCall.arguments),
        },
      }));
    }

    messages.push(assistant);
  }

  const chatCompletionsRequest: Record<string, unknown> = {
    model: request.model,
    reasoning_effort: request.reasoningEffort,
    messages,
    stream,
  };

  if (request.maxTokens !== undefined) chatCompletionsRequest.max_tokens = request.maxTokens;

  if (stream) {
    chatCompletionsRequest.stream_options = { include_usage: true };
  }

  if (request.tools !== undefined && request.tools.length > 0) {
    chatCompletionsRequest.tools = request.tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
  }

  return chatCompletionsRequest;
}
