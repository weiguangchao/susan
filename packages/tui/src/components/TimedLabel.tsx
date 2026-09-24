import type { ReactNode } from "react";
import { Box, Text } from "ink";
import { theme } from "../theme.js";

/**
 * A label followed by a dim `· <duration>`, kept on one line: the label never
 * shrinks and the duration truncates instead of wrapping. Without the split
 * boxes, Ink shrinks a sibling spinner out of existence on narrow terminals.
 */
export function TimedLabel({ children, duration }: { children: ReactNode; duration: ReactNode }) {
  return (
    <Box>
      <Box flexShrink={0}>{children}</Box>
      <Box flexGrow={1} minWidth={0}>
        <Text color={theme.thinking} dimColor wrap="truncate-end">
          {" · "}
          {duration}
        </Text>
      </Box>
    </Box>
  );
}
