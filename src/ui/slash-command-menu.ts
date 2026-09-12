import type { HarnessStatus } from "../core/harness";

export const slashCommands = [
  { name: "/compact", label: "压缩上下文", intent: "compact" },
  { name: "/exit", label: "退出", intent: "exit" },
  { name: "/new", label: "新对话", intent: "clear" },
  { name: "/model", label: "模型", intent: "model-picker" },
] as const;

export type SlashCommand = (typeof slashCommands)[number];

export type SlashCommandMenuSource = {
  readonly input: string;
  readonly status: HarnessStatus;
  readonly modelPickerActive: boolean;
  readonly slashCommandSelectedIndex?: number;
  readonly selectedIndex?: number;
};

export type SlashCommandMenu = {
  readonly visible: boolean;
  readonly query: string | null;
  readonly candidates: readonly SlashCommand[];
  readonly selectedIndex: number | null;
  readonly selected: SlashCommand | null;
};

export function isSlashQuery(input: string): boolean {
  return input.startsWith("/") && !/\s/u.test(input);
}

export function resolveSlashCommandMenu(
  source: SlashCommandMenuSource,
): SlashCommandMenu {
  const query = isSlashQuery(source.input) ? source.input : null;
  const visible =
    query !== null &&
    source.status !== "running" &&
    !source.modelPickerActive;
  if (!visible) {
    return {
      visible: false,
      query,
      candidates: [],
      selectedIndex: null,
      selected: null,
    };
  }

  const candidates = slashCommands
    .filter((command) => command.name.startsWith(query))
    .toSorted((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    );
  if (candidates.length === 0) {
    return {
      visible: true,
      query,
      candidates,
      selectedIndex: null,
      selected: null,
    };
  }

  const requestedIndex =
    source.slashCommandSelectedIndex ?? source.selectedIndex ?? 0;
  const selectedIndex = Math.max(
    0,
    Math.min(candidates.length - 1, requestedIndex),
  );
  return {
    visible: true,
    query,
    candidates,
    selectedIndex,
    selected: candidates[selectedIndex] ?? null,
  };
}
