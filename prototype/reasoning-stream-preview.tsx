// PROTOTYPE (throwaway): 推理（reasoning）流式输出的上下结构样式。
// Question: 「Think... 标签在上 + 自左向右波浪动画 + 思考内容在下」具体取哪种形态？
// 三个变体复用工具调用的 workingColorAt 逐字波浪，其余样式（用户消息 / agent 消息 / 工具台账）不动：
//   A 标签波浪 —— Think... 本身逐字波浪，内容 dim 平铺其下；与正文间 1 行间距，定稿后显示思考耗时
//   B 波浪延展 —— Think... 波浪标签后接 ≈ 填满行宽整行动画；定稿坍缩成 Think · N 字
//   C 竖线分组 —— Think... 波浪标签，内容缩进 2 列配 dim ▎ 竖线成块；定稿保留全文
// 运行：pnpm preview:reasoning ；←/→ 切换变体，空格 暂停，r 重播，w 宽度，q 退出。
// 落地提示：tui.tsx 的 StreamView reasoning 行（约 683 行）与 MessageView reasoning 分支（约 555 行）。
import { useEffect, useState } from "react";
import { Box, Text, render, useApp, useInput, useStdout } from "ink";
import stringWidth from "string-width";
import { createTuiState } from "../src/ui/state.js";
import {
  InputLine,
  StatusBar,
  useActivityPhase,
  workingColorAt,
} from "../src/ui/tui.js";

type VariantKey = "A" | "B" | "C";

const variants: readonly VariantKey[] = ["A", "B", "C"];
const variantNames: Record<VariantKey, string> = {
  A: "标签波浪",
  B: "波浪延展",
  C: "竖线分组",
};

const widthOptions = [80, 60, 100];

const THINK_LABEL = "Think...";
const THINKING_MS = 4800;
const ANSWERING_MS = 3800;
const DONE_MS = 1800;
const LOOP_MS = THINKING_MS + ANSWERING_MS + DONE_MS;

const userText =
  "推理输出的样式调整下：改成上下结构，Think... 在上，思考时带自左向右的波浪动画，思考内容在下面输出。";

const reasoningFull =
  "用户要调整推理输出的样式：上下结构，Think... 标签在上、内容在下，标签带自左向右的波浪动画，参考工具调用行。先看现状：StreamView 里 reasoning 是一行带 reasoning ▸ 前缀的 dim 文本，与正文共享流式区；工具行的波浪来自 workingColorAt 逐字上色，phase 每 180ms 前进一次。要定的细节：波浪只挂在标签上，还是延展成整行；内容要不要缩进分组；定稿后要不要坍缩。";

const answerFull =
  "三个变体都复用 workingColorAt 逐字波浪：A 把波浪直接挂在 Think... 标签上；B 在标签后接 ≈ 波浪填满行宽，定稿后坍缩成 Think · N 字；C 内容缩进两列配 dim ▎ 竖线成块。确认形态后，我把 StreamView 的 reasoning 行拆成两层渲染。";

export function PrototypeApp({
  initialVariant = "A",
}: {
  readonly initialVariant?: VariantKey;
}) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [variant, setVariant] = useState<VariantKey>(initialVariant);
  const [widthIndex, setWidthIndex] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [paused, setPaused] = useState(false);
  const rows = Math.max(24, stdout?.rows ?? 24);
  const columns = Math.min(
    widthOptions[widthIndex] ?? 80,
    stdout?.columns > 0 ? stdout.columns : 80,
  );

  useEffect(() => {
    if (paused) {
      return;
    }
    const timer = setInterval(() => {
      setElapsed((value) => (value + 100) % LOOP_MS);
    }, 100);
    return () => clearInterval(timer);
  }, [paused]);

  useInput((value, key) => {
    if (value === "q" || (key.ctrl && value === "c")) {
      exit();
      return;
    }
    if (key.leftArrow || key.rightArrow) {
      setVariant((current) => {
        const index = variants.indexOf(current);
        return variants[
          (index + (key.rightArrow ? 1 : -1) + variants.length) %
            variants.length
        ]!;
      });
      return;
    }
    if (value === " ") {
      setPaused((current) => !current);
    } else if (value === "r") {
      setElapsed(0);
    } else if (value === "w") {
      setWidthIndex((current) => (current + 1) % widthOptions.length);
    }
  });

  const thinking = elapsed < THINKING_MS;
  const answering =
    elapsed >= THINKING_MS && elapsed < THINKING_MS + ANSWERING_MS;
  const phaseName = thinking ? "思考" : answering ? "回答" : "完成";
  const reasoningVisible = thinking
    ? Math.floor((reasoningFull.length * elapsed) / THINKING_MS)
    : reasoningFull.length;
  const answerVisible = thinking
    ? 0
    : answering
      ? Math.floor(
          (answerFull.length * (elapsed - THINKING_MS)) / ANSWERING_MS,
        )
      : answerFull.length;

  const state = createTuiState({
    status: "running",
    sessionId: "reasoning-stream-preview",
    cwd: "/workspace",
    messages: [],
    pending: null,
    model: "gpt-5-codex",
    reasoningEffort: "high",
    contextWindow: 128_000,
    sessionTotalTokens: 18_400,
    sessionInputTokens: 26_000,
    sessionCachedInputTokens: 18_200,
  });

  const transcriptWidth = Math.max(1, columns - 1);
  const reasoningChars = Array.from(reasoningFull).length;

  return (
    <Box flexDirection="column" height={rows} width={columns}>
      <Box flexDirection="column" paddingLeft={1} flexShrink={0}>
        <Text bold color="cyan">
          Reasoning 流式样式原型 · Think 在上 / 内容在下
        </Text>
        <Text wrap="truncate-end">
          {variants
            .map((key) =>
              key === variant
                ? `[${key} ${variantNames[key]}]`
                : `${key} ${variantNames[key]}`,
            )
            .join("  ")}
        </Text>
        <Text dimColor wrap="truncate-end">
          ←/→ 变体 · 空格 暂停 · r 重播 · w 宽度 · q 退出
        </Text>
      </Box>
      <Box
        flexDirection="column"
        flexGrow={1}
        overflow="hidden"
        paddingLeft={1}
        justifyContent="flex-end"
      >
        <UserMessageView text={userText} width={transcriptWidth} />
        <Box flexDirection="column" flexShrink={0}>
          {thinking ? (
            <ThinkingLabel
              variant={variant}
              width={transcriptWidth}
              paused={paused}
            />
          ) : (
            <Text dimColor wrap="truncate-end">
              {variant === "A"
                ? `Think · ${(THINKING_MS / 1000).toFixed(1)} 秒`
                : `Think · ${reasoningChars} 字`}
            </Text>
          )}
          {variant === "B" && !thinking ? null : (
            <ReasoningContent
              variant={variant}
              text={thinking ? reasoningFull.slice(0, reasoningVisible) : reasoningFull}
              streaming={thinking}
              width={transcriptWidth}
            />
          )}
          {answerVisible > 0 ? (
            <AnswerContent
              text={answerFull.slice(0, answerVisible)}
              streaming={answering}
              width={transcriptWidth}
              gapAbove={variant === "A" ? 1 : 0}
            />
          ) : null}
          <WorkingToolLine label="bash · pnpm lint" />
        </Box>
      </Box>
      <Box marginBottom={1} />
      <InputLine input="" cursor={{ row: 0, column: 0 }} columns={columns} />
      <StatusBar state={state} />
      <PrototypeSwitcher current={variant} />
      <Box paddingLeft={1} flexShrink={0}>
        <Text dimColor wrap="truncate-end">
          prototype state ▸ variant={variant} · {variantNames[variant]} ·
          width={columns} · 阶段={phaseName} · {paused ? "已暂停" : "循环播放"}
        </Text>
      </Box>
    </Box>
  );
}

function ThinkingLabel({
  variant,
  width,
  paused,
}: {
  readonly variant: VariantKey;
  readonly width: number;
  readonly paused: boolean;
}) {
  const phase = useActivityPhase(!paused);
  if (variant === "B") {
    const stripLength = Math.max(0, width - THINK_LABEL.length - 1);
    const characters: readonly string[] = [
      ...Array.from(THINK_LABEL),
      " ",
      ...Array.from({ length: stripLength }, () => "≈"),
    ];
    return (
      <Text wrap="truncate-end">
        {characters.map((character, index) => (
          <Text
            key={index}
            bold={index < THINK_LABEL.length}
            color={workingColorAt(index, phase)}
          >
            {character}
          </Text>
        ))}
      </Text>
    );
  }
  return (
    <Text bold wrap="truncate-end">
      {Array.from(THINK_LABEL).map((character, index) => (
        <Text key={index} color={workingColorAt(index, phase)}>
          {character}
        </Text>
      ))}
    </Text>
  );
}

function ReasoningContent({
  variant,
  text,
  streaming,
  width,
}: {
  readonly variant: VariantKey;
  readonly text: string;
  readonly streaming: boolean;
  readonly width: number;
}) {
  if (text === "") {
    return null;
  }
  const body = streaming ? `${text}▍` : text;
  const gutterWidth = variant === "C" ? 4 : 0;
  const lines = wrapLines(body, Math.max(1, width - gutterWidth));
  return (
    <Box flexDirection="column">
      {lines.map((line, index) => (
        <Text key={index} dimColor wrap="truncate-end">
          {variant === "C" ? <Text>  ▎ </Text> : null}
          {line === "" ? " " : line}
        </Text>
      ))}
    </Box>
  );
}

function AnswerContent({
  text,
  streaming,
  width,
  gapAbove = 0,
}: {
  readonly text: string;
  readonly streaming: boolean;
  readonly width: number;
  readonly gapAbove?: number;
}) {
  const body = streaming ? `${text}▍` : text;
  const lines = wrapLines(body, width);
  return (
    <Box flexDirection="column" marginTop={gapAbove}>
      {lines.map((line, index) => (
        <Text key={index} wrap="truncate-end">
          {line === "" ? " " : line}
        </Text>
      ))}
    </Box>
  );
}

function UserMessageView({
  text,
  width,
}: {
  readonly text: string;
  readonly width: number;
}) {
  const lines = wrapLines(text, width - 2);
  return (
    <Box flexDirection="column" marginTop={1} marginBottom={1}>
      {lines.map((line, index) => (
        <Text key={index} wrap="truncate-end">
          <Text color="cyan">▌ </Text>
          <Text bold>{line}</Text>
        </Text>
      ))}
    </Box>
  );
}

function WorkingToolLine({ label }: { readonly label: string }) {
  const phase = useActivityPhase(true);
  return (
    <Text bold wrap="truncate-end">
      {[...label].map((character, index) => (
        <Text key={index} color={workingColorAt(index, phase)}>
          {character}
        </Text>
      ))}
    </Text>
  );
}

function wrapLines(text: string, width: number): readonly string[] {
  const usable = Math.max(1, width);
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (paragraph === "") {
      lines.push("");
      continue;
    }
    let current = "";
    let currentWidth = 0;
    for (const character of Array.from(paragraph)) {
      const characterWidth = stringWidth(character);
      if (currentWidth + characterWidth > usable && current !== "") {
        lines.push(current);
        current = character;
        currentWidth = characterWidth;
      } else {
        current += character;
        currentWidth += characterWidth;
      }
    }
    lines.push(current);
  }
  return lines;
}

function PrototypeSwitcher({ current }: { readonly current: VariantKey }) {
  return (
    <Box justifyContent="center" marginTop={1}>
      <Box backgroundColor="blue" paddingLeft={1} paddingRight={1}>
        <Text color="white" bold>
          ←  {current} · {variantNames[current]}  →
        </Text>
      </Box>
    </Box>
  );
}

function parseVariant(value: string): VariantKey {
  return value === "B" || value === "C" ? value : "A";
}

const arg = process.argv.find((item) => item.startsWith("--variant="));
const initialVariant = parseVariant(arg?.split("=")[1] ?? "A");

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error("请在交互式终端运行 pnpm preview:reasoning");
  process.exitCode = 1;
} else {
  render(<PrototypeApp initialVariant={initialVariant} />);
}
