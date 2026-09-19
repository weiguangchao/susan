import { useEffect, type Dispatch } from "react";
import type { Harness } from "@weiguangchao/susan-harness";
import type { TuiAction } from "../state";

export function useHarness(
  harness: Harness,
  dispatch: Dispatch<TuiAction>,
): void {
  useEffect(() => {
    const unsubscribe = harness.subscribe((event) => {
      dispatch({ type: "harness-event", event });
      dispatch({ type: "snapshot", snapshot: harness.getSnapshot() });
    });
    dispatch({ type: "snapshot", snapshot: harness.getSnapshot() });
    return unsubscribe;
  }, [harness]);
}
