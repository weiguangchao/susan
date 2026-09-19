import type { ModelPickerState } from "./model";

export const MODEL_PICKER_VIEWPORT = 5;
const MODEL_PICKER_BORDER_ROWS = 2;
const MODEL_PICKER_HINT_ROWS = 1;

export function modelPickerWindow(
  modelIndex: number | null,
  total: number,
  height = MODEL_PICKER_VIEWPORT,
): number {
  if (total <= height) {
    return 0;
  }
  const index = modelIndex ?? 0;
  return Math.min(
    Math.max(0, index - height + 1),
    Math.min(total - height, index),
  );
}

export function modelPickerRowCount(state: ModelPickerState): number {
  const provider = state.catalog.providers[state.providerIndex];
  if (provider === undefined) {
    return MODEL_PICKER_BORDER_ROWS + 1 + MODEL_PICKER_HINT_ROWS;
  }
  const total = provider.models.length;
  const start = modelPickerWindow(state.modelIndex, total);
  const visible = Math.min(MODEL_PICKER_VIEWPORT, total);
  const above = start > 0 ? 1 : 0;
  const below = total - start - visible > 0 ? 1 : 0;
  return (
    MODEL_PICKER_BORDER_ROWS +
    1 +
    1 +
    above +
    visible +
    below +
    1 +
    MODEL_PICKER_HINT_ROWS
  );
}
