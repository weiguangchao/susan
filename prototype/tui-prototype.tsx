// Three bottom-command-area variants, switchable with Ctrl+N/P / --variant=A, in prototype/tui-prototype.tsx.
import { useState } from "react";
import { Box, Text, render, useApp, useInput, useStdout } from "ink";

type Variant = "A" | "B" | "C";

const variants: readonly Variant[] = ["A", "B", "C"];

const state = {
  model: "gpt-5-codex",
  reasoning: "high",
  tokenUse: "18.4k / 128k",
  contextUse: 14.4,
};

export function PrototypeApp({
  initialVariant = "A",
}: {
  readonly initialVariant?: Variant;
}) {
  const [variant, setVariant] = useState<Variant>(initialVariant);
  const [input, setInput] = useState("");
  const { exit } = useApp();
  const { stdout } = useStdout();
  const rows = stdout?.rows ?? 24;
  const columns = Math.max(60, stdout?.columns ?? 80);

  useInput((value, key) => {
    if (key.ctrl && value === "c") {
      exit();
      return;
    }
    if (key.ctrl && value === "n") {
      setVariant((current) => {
        const index = variants.indexOf(current);
        return variants[(index + 1) % variants.length];
      });
      return;
    }
    if (key.ctrl && value === "p") {
      setVariant((current) => {
        const index = variants.indexOf(current);
        const next = (index - 1 + variants.length) % variants.length;
        return variants[next];
      });
      return;
    }
    if (key.backspace) {
      setInput((current) => current.slice(0, -1));
      return;
    }
    if (key.return) {
      setInput("");
      return;
    }
    if (value !== "") {
      setInput((current) => `${current}${value}`);
    }
  });

  return (
    <Box flexDirection="column" height={rows} width={columns}>
      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        <Text dimColor>
          PROTOTYPE · variant {variant} · Ctrl+N/P switch · Ctrl+C exit
        </Text>
        <Box marginTop={1} paddingLeft={1}>
          <Text dimColor>
            state ▸ model={state.model} · thinking={state.reasoning} · tokens=
            {state.tokenUse} · context={state.contextUse.toFixed(1)}%
          </Text>
        </Box>
      </Box>

      {variant === "A" ? <VariantA input={input} /> : null}
      {variant === "B" ? <VariantB input={input} /> : null}
      {variant === "C" ? <VariantC input={input} /> : null}
    </Box>
  );
}

function VariantA({ input }: { readonly input: string }) {
  return (
    <>
      <InputLine input={input} />
      <StatusLine />
    </>
  );
}

function VariantB({ input }: { readonly input: string }) {
  return (
    <>
      <InputLine input={input} bordered />
      <Box borderStyle="round" flexDirection="column" paddingLeft={1} flexShrink={0}>
        <Text>
          {state.model} · {state.reasoning}
        </Text>
        <Text dimColor>
          {state.tokenUse} · {state.contextUse.toFixed(1)}% context
        </Text>
      </Box>
    </>
  );
}

function VariantC({ input }: { readonly input: string }) {
  return (
    <>
      <InputLine input={input} bordered />
      <Box
        borderStyle="round"
        flexDirection="column"
        paddingLeft={1}
        flexShrink={0}
      >
        <Box flexDirection="row">
          <Box paddingRight={2}>
            <Text dimColor>model</Text>
          </Box>
          <Text>{state.model}</Text>
        </Box>
        <Box flexDirection="row">
          <Box paddingRight={2}>
            <Text dimColor>thinking</Text>
          </Box>
          <Text>{state.reasoning}</Text>
        </Box>
        <Box flexDirection="row">
          <Box paddingRight={2}>
            <Text dimColor>tokens</Text>
          </Box>
          <Text>{state.tokenUse}</Text>
        </Box>
        <Box flexDirection="row">
          <Box paddingRight={2}>
            <Text dimColor>context</Text>
          </Box>
          <Text>{state.contextUse.toFixed(1)}%</Text>
        </Box>
      </Box>
    </>
  );
}

function InputLine({
  input,
  bordered = false,
}: {
  readonly input: string;
  readonly bordered?: boolean;
}) {
  return (
    <Box
      borderStyle={bordered ? "round" : undefined}
      flexDirection="column"
      paddingLeft={1}
      flexShrink={0}
    >
      <Text>{input === "" ? "❯ 输入消息…" : `❯ ${input}`}</Text>
    </Box>
  );
}

function StatusLine() {
  return (
    <Box flexDirection="column" paddingLeft={1} flexShrink={0}>
      <Text>
        {state.model} · {state.reasoning} · {state.tokenUse} ·{" "}
        {state.contextUse.toFixed(1)}% context
      </Text>
    </Box>
  );
}

function parseVariant(value: string): Variant {
  return value === "B" || value === "C" ? value : "A";
}

const arg = process.argv.find((item) => item.startsWith("--variant="));
const initialVariant = parseVariant(arg?.split("=")[1] ?? "A");

render(<PrototypeApp initialVariant={initialVariant} />);
