import type { SlashCommandMenu } from "./model";

export function slashCommandMenuRowCount(menu: SlashCommandMenu): number {
  if (!menu.visible) {
    return 0;
  }
  return Math.max(1, menu.candidates.length);
}
