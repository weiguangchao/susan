import { useInput } from "ink";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { Harness } from "@weiguangchao/susan-harness";
import {
  reduceModelPickerState,
  resolveModelPickerIntent,
  type ModelPickerSelection,
  type ModelPickerState,
} from "../model-picker";
import { resolveInputIntent, type TuiAction, type TuiInputIntent, type TuiState } from "../state";

function isKeyboardProtocolResponse(input: string): boolean {
  return /^\x1b\[\?\d+u$/.test(input) || /^\[\?\d+u$/.test(input);
}

export function useTuiInput({
  harness,
  stateRef,
  modelPickerStateRef,
  operationRef,
  dispatch,
  setModelPickerState,
  executeIntent,
  applyPickerSelection,
  inputWidth,
}: {
  readonly harness: Harness;
  readonly stateRef: MutableRefObject<TuiState>;
  readonly modelPickerStateRef: MutableRefObject<ModelPickerState>;
  readonly operationRef: MutableRefObject<boolean>;
  readonly dispatch: Dispatch<TuiAction>;
  readonly setModelPickerState: Dispatch<SetStateAction<ModelPickerState>>;
  readonly executeIntent: (intent: TuiInputIntent) => Promise<void>;
  readonly applyPickerSelection: (selection: ModelPickerSelection) => Promise<void>;
  readonly inputWidth: number;
}): void {
  useInput((input, key) => {
    if (isKeyboardProtocolResponse(input)) {
      return;
    }
    if (operationRef.current) return;
    const currentState = {
      ...stateRef.current,
      status: harness.getSnapshot().status,
    };
    if (currentState.modelPickerActive) {
      const pickerIntent = resolveModelPickerIntent(
        modelPickerStateRef.current,
        {
          input,
          upArrow: key.upArrow,
          downArrow: key.downArrow,
          leftArrow: key.leftArrow,
          rightArrow: key.rightArrow,
          tab: key.tab,
          return: key.return,
          escape: key.escape,
        },
      );
      if (pickerIntent.type === "cancel") {
        dispatch({ type: "close-model-picker" });
        return;
      }
      if (pickerIntent.type === "apply") {
        operationRef.current = true;
        void applyPickerSelection(pickerIntent.selection).finally(() => { operationRef.current = false; });
        return;
      }
      setModelPickerState((current) =>
        reduceModelPickerState(current, pickerIntent),
      );
      return;
    }

    const intent = resolveInputIntent(currentState, {
      input,
      ctrl: key.ctrl,
      shift: key.shift,
      return: key.return,
      escape: key.escape,
      backspace: key.backspace,
      upArrow: key.upArrow,
      downArrow: key.downArrow,
      leftArrow: key.leftArrow,
      rightArrow: key.rightArrow,
      inputWidth,
    });
    dispatch({
      type: "input-intent",
      intent,
    });
    if (intent.type === "clear" || intent.type === "new-session" || intent.type === "reload") {
      operationRef.current = true;
      void executeIntent(intent).finally(() => { operationRef.current = false; });
    } else {
      void executeIntent(intent);
    }
  });
}
