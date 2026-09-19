import { useCallback, type Dispatch, type SetStateAction } from "react";
import { useApp } from "ink";
import type { Harness, HarnessAssembly, HarnessError } from "@weiguangchao/susan-harness";
import {
  createModelPickerState,
  type ModelPickerSelection,
  type ModelPickerState,
} from "../model-picker";
import type { TuiAction, TuiInputIntent } from "../state";
import { assemblyErrorMessage, modelPickerCatalog } from "./assembly";

export function useIntents({
  harness,
  assembly,
  dispatch,
  setHarness,
  setModelPickerState,
  onExit,
}: {
  readonly harness: Harness;
  readonly assembly: HarnessAssembly;
  readonly dispatch: Dispatch<TuiAction>;
  readonly setHarness: Dispatch<SetStateAction<Harness>>;
  readonly setModelPickerState: Dispatch<SetStateAction<ModelPickerState>>;
  readonly onExit?: () => void;
}): {
  readonly executeIntent: (intent: TuiInputIntent) => Promise<void>;
  readonly applyPickerSelection: (selection: ModelPickerSelection) => Promise<void>;
} {
  const { exit } = useApp();

  const quit = useCallback(() => {
    if (onExit === undefined) {
      exit();
      return;
    }
    onExit();
  }, [exit, onExit]);

  const replaceSession = useCallback(async () => {
    const result = await assembly.assemble({ session: { kind: "new" }, newSessionCwd: harness.getSnapshot().cwd });
    if (result.kind !== "ready") {
      if (result.kind !== "session-picker") dispatch({ type: "notice", message: assemblyErrorMessage(result) });
      return;
    }
    setHarness(result.harness);
    setModelPickerState(createModelPickerState(modelPickerCatalog(result.config)));
    dispatch({ type: "new-session", snapshot: result.harness.getSnapshot(), inputHistory: result.inputHistory });
  }, [harness, assembly]);

  const refreshConfig = useCallback(async () => {
    const result = await assembly.reload();
    if (result.kind !== "updated") {
      dispatch({ type: "notice", message: assemblyErrorMessage(result) });
      return;
    }
    setModelPickerState(createModelPickerState(modelPickerCatalog(result.config)));
    dispatch({ type: "snapshot", snapshot: harness.getSnapshot() });
    dispatch({ type: "notice", message: "配置已重新加载" });
  }, [assembly, harness]);

  const handleModelError = useCallback(
    (error: HarnessError) => {
      if (error.code === "HARNESS_MODEL_CONFIG_INCOMPLETE") {
        setModelPickerState((current) =>
          createModelPickerState(current.catalog),
        );
        dispatch({ type: "snapshot", snapshot: harness.getSnapshot() });
        dispatch({
          type: "input-intent",
          intent: { type: "model-picker" },
        });
        return;
      }
      dispatch({ type: "notice", message: error.message });
    },
    [dispatch, harness],
  );

  const executeIntent = useCallback(
    async (intent: TuiInputIntent) => {
      if (
        intent.type === "insert" ||
        intent.type === "newline" ||
        intent.type === "backspace" ||
        intent.type === "move-cursor-up" ||
        intent.type === "move-cursor-down" ||
        intent.type === "move-cursor-left" ||
        intent.type === "move-cursor-right" ||
        intent.type === "move-cursor-to-line-start" ||
        intent.type === "move-cursor-to-line-end" ||
        intent.type === "history-previous" ||
        intent.type === "history-next" ||
        intent.type === "move-slash-command-selection" ||
        intent.type === "notice" ||
        intent.type === "clear-input" ||
        intent.type === "dismiss-failure"
      ) {
        return;
      }
      if (intent.type === "exit") {
        quit();
        return;
      }
      if (intent.type === "clear" || intent.type === "new-session") {
        await replaceSession();
        return;
      }
      if (intent.type === "reload") {
        await refreshConfig();
        return;
      }
      if (intent.type === "model-picker") {
        setModelPickerState((current) =>
          createModelPickerState(current.catalog),
        );
        return;
      }
      if (intent.type === "compact") {
        const result = await harness.compact(intent.customInstructions);
        dispatch({ type: "snapshot", snapshot: harness.getSnapshot() });
        if (!result.ok) handleModelError(result.error);
        return;
      }
      if (intent.type === "submit") {
        const result = await harness.dispatch({
          type: "submit",
          content: intent.content,
        });
        if (!result.ok) {
          handleModelError(result.error);
        }
        return;
      }
      if (intent.type === "interrupt") {
        await harness.dispatch({ type: "interrupt" });
        return;
      }
      if (intent.type === "retry") {
        const result = await harness.dispatch({ type: "retry" });
        if (!result.ok) {
          handleModelError(result.error);
        }
      }
    },
    [dispatch, handleModelError, harness, quit, replaceSession, refreshConfig],
  );

  const applyPickerSelection = useCallback(
    async (selection: ModelPickerSelection) => {
      const result = await assembly.applyModelSelection(selection);
      if (result.kind !== "updated") {
        dispatch({ type: "notice", message: assemblyErrorMessage(result) });
        return;
      }
      dispatch({ type: "snapshot", snapshot: harness.getSnapshot() });
      setModelPickerState(createModelPickerState(modelPickerCatalog(result.config)));
      dispatch({ type: "close-model-picker" });
      dispatch({ type: "notice", message: "模型配置已更新" });
    },
    [assembly, dispatch, harness],
  );

  return { executeIntent, applyPickerSelection };
}
