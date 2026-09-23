import { Box, Text, useInput } from "ink";
import type { PermissionDecision, PermissionRequest } from "@susan/harness";
import { theme } from "../theme.js";

export interface PermissionPromptProps {
  request: PermissionRequest;
  onAnswer(decision: PermissionDecision): void;
}

/**
 * Blocks the loop until the user decides. The agent is literally awaiting the
 * promise this resolves, so there is no way for the call to slip through.
 */
export function PermissionPrompt({ request, onAnswer }: PermissionPromptProps) {
  useInput((input, key) => {
    const choice = input.toLowerCase();
    if (choice === "y" || key.return) onAnswer("allow");
    else if (choice === "a") onAnswer("allow_always");
    else if (choice === "n" || key.escape) onAnswer("deny");
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.warn}
      paddingX={1}
      marginBottom={1}
    >
      <Text color={theme.warn} bold>
        {request.toolName} wants to run
      </Text>
      <Box marginTop={1} paddingLeft={1}>
        <Text color={theme.text}>{request.summary}</Text>
      </Box>
      <Box marginTop={1}>
        <Text color={theme.success}>y</Text>
        <Text color={theme.muted}> allow once </Text>
        <Text color={theme.success}>a</Text>
        <Text color={theme.muted}> always allow {request.toolName} </Text>
        <Text color={theme.error}>n</Text>
        <Text color={theme.muted}> deny</Text>
      </Box>
    </Box>
  );
}
