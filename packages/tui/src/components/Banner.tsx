import { Box, Text } from "ink";
import { theme } from "../theme.js";

export interface BannerProps {
  root: string;
  model: string;
  mocked: boolean;
}

const mockNotice =
  "  No API key found - running the mock provider. The loop, tools are real; the model is scripted. Set ANTHROPIC_API_KEY or OPENAI_API_KEY, or pass --base-url, to use a real model.";
const help = "  /help for commands · esc to interrupt · ctrl+c to exit";

/** Rows printed by the startup banner before Ink freezes it in Static output. */
export function bannerRows(root: string, model: string, mocked: boolean, columns: number): number {
  const width = Math.max(1, columns);
  const lines = (text: string) => Math.ceil(text.length / width);
  return lines(`▌ susan code agent · ${model} · auto mode`)
    + lines(`▌ ${root}`)
    + (mocked ? 1 + lines(mockNotice) : 0)
    + 1 + lines(help) + 1;
}

export function Banner({ root, model, mocked }: BannerProps) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color={theme.accent} bold>
          {"▌"} susan{" "}
        </Text>
        <Text color={theme.muted}>
          code agent · {model} · auto mode
        </Text>
      </Box>
      <Box>
        <Text color={theme.accentDim}>{"▌"} </Text>
        <Text color={theme.muted}>{root}</Text>
      </Box>
      {mocked ? (
        <Box marginTop={1}>
          <Text color={theme.warn}>
            {mockNotice}
          </Text>
        </Box>
      ) : null}
      <Box marginTop={1}>
        <Text color={theme.muted}>
            {help}
        </Text>
      </Box>
    </Box>
  );
}
