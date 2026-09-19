import { Box, Text } from "ink";
import type { SlashCommandMenu } from "./model";

export function SlashCommandMenuView({
  menu,
}: {
  readonly menu: SlashCommandMenu;
}) {
  if (menu.candidates.length === 0) {
    return (
      <Box paddingLeft={1} flexShrink={0}>
        <Text dimColor wrap="truncate-end">无匹配</Text>
      </Box>
    );
  }

  const query = menu.query ?? "/";
  const matchLength = query === "/" ? 0 : query.length;
  return (
    <Box flexDirection="column" flexShrink={0}>
      {menu.candidates.map((command, index) => (
        <Box key={command.name} paddingLeft={1} paddingRight={1}>
          <Text wrap="truncate-end">
            <Text color={index === menu.selectedIndex ? "cyanBright" : undefined}>
              {index === menu.selectedIndex ? "›" : " "}
            </Text>{" "}
            {matchLength === 0 ? (
              command.name
            ) : (
              <>
                <Text color="cyanBright" bold>
                  {command.name.slice(0, matchLength)}
                </Text>
                {command.name.slice(matchLength)}
              </>
            )}{" "}
            <Text dimColor>{command.label}</Text>
          </Text>
        </Box>
      ))}
    </Box>
  );
}
