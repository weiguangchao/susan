import { useEffect, useState } from "react";
import { Box, Text } from "ink";
import type { TuiState } from "../state";
import { outputLines, thinkDurationLabel } from "./layout";

const THINK_LABEL = "Thinking";
const WORKING_LABEL = "Working";
export const WORKING_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧"] as const;

function workingSpinnerFrame(phase: number): string {
  return WORKING_SPINNER_FRAMES[phase % WORKING_SPINNER_FRAMES.length]!;
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) {
      return;
    }
    const timer = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

function useActivityPhase(active: boolean): number {
  const [phase, setPhase] = useState(0);
  useEffect(() => {
    if (!active) {
      return;
    }
    const timer = setInterval(() => setPhase((current) => current + 1), 180);
    return () => clearInterval(timer);
  }, [active]);
  return phase;
}

function WorkingActivityLabel({
  label,
  phase,
  durationText,
}: {
  readonly label: string;
  readonly phase: number;
  readonly durationText?: string;
}) {
  return (
    <Text bold wrap="truncate-end">
      <Text color="cyan">{workingSpinnerFrame(phase)} </Text>
      {label}
      {durationText ? <Text dimColor bold={false}> · {durationText}</Text> : null}
    </Text>
  );
}

export function StreamView({
  state,
  width,
}: {
  readonly state: TuiState;
  readonly width: number;
}) {
  const stream = state.stream;
  const reasoning = stream?.reasoning ?? "";
  const text = stream?.text ?? "";
  const thinking = stream !== null && text === "" && state.status === "running" &&
    state.retry === null && state.failure === null && !state.awaitingModelAfterTools;
  const active = thinking || state.awaitingModelAfterTools;
  const phase = useActivityPhase(active);
  const activityLabel = state.awaitingModelAfterTools ? WORKING_LABEL : THINK_LABEL;
  const thinkingStartedAt = thinking && stream !== null ? stream.reasoningStartedAt : null;
  const now = useNow(thinkingStartedAt !== null);
  const durationText =
    thinkingStartedAt === null
      ? undefined
      : `${(Math.max(0, now - thinkingStartedAt) / 1000).toFixed(1)}s`;
  return (
    <Box flexDirection="column" flexShrink={0}>
      {active ? (
        <WorkingActivityLabel
          label={activityLabel}
          phase={phase}
          durationText={durationText}
        />
      ) : reasoning === "" ? null : (
        <Text dimColor wrap="truncate-end">
          {thinkDurationLabel(
            Math.max(
              0,
              (stream?.reasoningEndedAt ?? 0) -
                (stream?.reasoningStartedAt ?? 0),
            ),
          )}
        </Text>
      )}
      {reasoning === ""
        ? null
        : outputLines(thinking && text === "" ? `${reasoning}▍` : reasoning, width).map(
            (line, index) => (
              <Text key={index} dimColor wrap="truncate-end">
                {line === "" ? " " : line}
              </Text>
            ),
          )}
      {text === "" ? null : (
        <Box flexDirection="column" marginTop={reasoning === "" ? 0 : 1}>
          {outputLines(`${text}▍`, width).map((line, index) => (
            <Text key={index} wrap="truncate-end">
              {line === "" ? " " : line}
            </Text>
          ))}
        </Box>
      )}
    </Box>
  );
}
