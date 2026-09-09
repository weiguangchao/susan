// PROTOTYPE (throwaway): 流式输出（StreamView）与 interrupted 消息的前缀处理。
// 用户消息已定稿：cyan ▌ 竖条 + 粗体 + 上下间距；agent 完成消息已定稿：纯文本无前缀。
// Question: 流式区与中断消息的「susan ▸ / reasoning ▸」前缀是否一并去掉？
//   A 前缀保留    —— 流式 susan ▸ …▍ + reasoning ▸ …▍ + 中断 susan ▸ [已中断] …（现状对照）
//   B 全部去前缀  —— 流式与定稿纯文本一致 …▍，reasoning 仅剩 dim，中断仅剩 [已中断] 红字
//   C 仅去 speaker —— susan ▸ 全部去掉；reasoning ▸ 作为状态标签保留；中断去 susan
// 工具台账（✓ / └ / 动画）样式不变。
// 运行：pnpm preview:user-msg ；←/→ 切换变体，w 循环终端宽度，q 退出。
// 落地提示：tui.tsx 的 StreamView（约 608 行）与 MessageView interrupted 分支。
import { useEffect, useState } from "react";
import { Box, Text, render, useApp, useInput, useStdout } from "ink";
import stringWidth from "string-width";
import { createTuiState } from "../src/ui/state.js";
import { InputLine, StatusBar, useActivityPhase, workingColorAt } from "../src/ui/tui.js";

type VariantKey = "A" | "B" | "C";

const variants: readonly VariantKey[] = ["A", "B", "C"];
const variantNames: Record<VariantKey, string> = {
  A: "前缀保留",
  B: "全部去前缀",
  C: "仅去speaker",
};

const widthOptions = [80, 60, 100];

// 用户消息定稿参数：方案 B，cyan ▌，上下各 1 行间距。
const settledUserBar = "▌";

const userOne = "帮我跑一遍 tui 相关的测试，失败的顺便修掉。";
const replyOne = "好的，我先跑渲染相关的测试。";
const interruptedText = "失败的用例集中在 resize 场景，我准备";
const userTwo = "继续吧，重跑失败的用例。";
const reasoningText = "用户想继续修复，先定位失败原因，再改断言。";
const streamFullText =
  "定位到 resize 测试对「你 ▸ 」前缀的断言，正在同步更新为竖条样式，稍后跑全量回归。";

export function PrototypeApp({
  initialVariant = "A",
}: {
  readonly initialVariant?: VariantKey;
}) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [variant, setVariant] = useState<VariantKey>(initialVariant);
  const [widthIndex, setWidthIndex] = useState(0);
  const [streamLength, setStreamLength] = useState(12);
  const rows = Math.max(24, stdout?.rows ?? 24);
  const columns = Math.min(
    widthOptions[widthIndex] ?? 80,
    stdout?.columns > 0 ? stdout.columns : 80,
  );

  useEffect(() => {
    const timer = setInterval(() => {
      setStreamLength((current) =>
        current >= streamFullText.length ? 6 : current + 2,
      );
    }, 220);
    return () => clearInterval(timer);
  }, []);

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
    if (value === "w") {
      setWidthIndex((current) => (current + 1) % widthOptions.length);
    }
  });

  const state = createTuiState({
    status: "idle",
    sessionId: "user-message-preview",
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
  const streamText = streamFullText.slice(0, streamLength);

  return (
    <Box flexDirection="column" height={rows} width={columns}>
      <Box
        flexDirection="column"
        flexGrow={1}
        overflow="hidden"
        paddingLeft={1}
        justifyContent="flex-end"
      >
        <UserMessageView text={userOne} width={transcriptWidth} />
        <AgentMessageView text={replyOne} width={transcriptWidth} />
        <Text color="green">✓ bash · pnpm vitest run test/tui-render</Text>
        <Text dimColor wrap="truncate-end">    └ 2 passed (2)</Text>
        <InterruptedMessageView
          variant={variant}
          text={interruptedText}
          width={transcriptWidth}
        />
        <UserMessageView text={userTwo} width={transcriptWidth} />
        <Box flexDirection="column">
          <ReasoningLine variant={variant} text={reasoningText} width={transcriptWidth} />
          <StreamTextLine variant={variant} text={streamText} width={transcriptWidth} />
          <WorkingToolLine label="bash · pnpm vitest run test/tui-resize" />
        </Box>
      </Box>
      <Box marginBottom={1} />
      <InputLine
        input=""
        cursor={{ row: 0, column: 0 }}
        columns={columns}
      />
      <StatusBar state={state} />
      <PrototypeSwitcher current={variant} />
      <Box paddingLeft={1}>
        <Text dimColor>
          prototype state ▸ variant={variant} · {variantNames[variant]} ·
          width={columns} · ←/→ 变体 · w 宽度 · q 退出
        </Text>
      </Box>
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
          <Text color="cyan">{settledUserBar} </Text>
          <Text bold>{line}</Text>
        </Text>
      ))}
    </Box>
  );
}

function AgentMessageView({
  text,
  width,
}: {
  readonly text: string;
  readonly width: number;
}) {
  const lines = wrapLines(text, width);
  return (
    <Box flexDirection="column">
      {lines.map((line, index) => (
        <Text key={index} wrap="truncate-end">
          {line === "" ? " " : line}
        </Text>
      ))}
    </Box>
  );
}

function InterruptedMessageView({
  variant,
  text,
  width,
}: {
  readonly variant: VariantKey;
  readonly text: string;
  readonly width: number;
}) {
  const lines = wrapLines(text, width);
  return (
    <Box flexDirection="column">
      {lines.map((line, index) => (
        <Text key={index} color="red" wrap="truncate-end">
          {index === 0 ? (
            <Text>{variant === "A" ? "susan ▸ [已中断] " : "[已中断] "}</Text>
          ) : null}
          {line === "" ? " " : line}
        </Text>
      ))}
      <Text dimColor>└ 未写入 Session Transcript · Enter 显式重试</Text>
    </Box>
  );
}

function ReasoningLine({
  variant,
  text,
  width,
}: {
  readonly variant: VariantKey;
  readonly text: string;
  readonly width: number;
}) {
  const lines = wrapLines(`${text}▍`, width);
  return (
    <Box flexDirection="column">
      {lines.map((line, index) => (
        <Text key={index} dimColor wrap="truncate-end">
          {index === 0 && variant !== "B" ? (
            <Text>reasoning ▸ </Text>
          ) : null}
          {line}
        </Text>
      ))}
    </Box>
  );
}

function StreamTextLine({
  variant,
  text,
  width,
}: {
  readonly variant: VariantKey;
  readonly text: string;
  readonly width: number;
}) {
  const lines = wrapLines(`${text}▍`, width);
  return (
    <Box flexDirection="column">
      {lines.map((line, index) => (
        <Text key={index} wrap="truncate-end">
          {index === 0 && variant === "A" ? <Text>susan ▸ </Text> : null}
          {line}
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

render(<PrototypeApp initialVariant={initialVariant} />);
