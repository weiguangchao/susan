import { renderToString } from "ink";
import stringWidth from "string-width";
import { Children, type ReactElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { createTuiState, resolveSlashCommandMenu } from "../src/index.js";
import {
  ActivityLine,
  InputLine,
  SlashCommandMenuView,
} from "../src/ui/tui.js";

function stripAnsi(value: string): string {
  return value.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "");
}

describe("TUI input", () => {
  const reportedPaste = `{
  "editor.fontFamily": "Monaco,Menlo, 'Courier New', monospace",
  "editor.fontSize": 14,
  "debug.console.fontSize": 14,
  "terminal.integrated.fontSize": 14,
  "terminal.integrated.fontFamily": "'MesloLGS NF', Monaco,Menlo, 'Courier New',monospace",
  "workbench.editor.enablePreview": false,
  "[typescript]": {
    "editor.defaultFormatter": "esbenp.prettier-vscode",
  },
  "[javascript]": {
    "editor.defaultFormatter": "esbenp.prettier-vscode",
  },
  "[json]": {
    "editor.defaultFormatter": "esbenp.prettier-vscode",
  },
  "[jsonc]": {
    "editor.defaultFormatter": "esbenp.prettier-vscode",
  },
  "[shellscript]": {
    "editor.defaultFormatter": "foxundermoon.shell-format",
  },
  "terminal.integrated.suggest.enabled": true,
  "shellformat.path": "/opt/homebrew/bin/shfmt",
  "explorer.confirmDelete": false,
  "git.confirmSync": false,
  "git.autofetch": true,
  "explorer.confirmDragAndDrop": false,
}`;

  function menuState(input: string, selectedIndex = 0) {
    const state = {
      ...createTuiState({
        status: "idle",
        sessionId: "session-1",
        cwd: "/workspace",
        messages: [],
        pending: null,
        model: "gpt-5-codex",
        reasoningEffort: "high",
        contextWindow: 418_000,
        contextTokens: 0,
        sessionTotalTokens: 0,
        sessionInputTokens: 0,
        sessionCachedInputTokens: 0,
      }),
      input,
      slashCommandSelectedIndex: selectedIndex,
    };
    return resolveSlashCommandMenu(state);
  }

  it("renders the full Slash Command directory for / with one selected marker", () => {
    const output = renderToString(<SlashCommandMenuView menu={menuState("/")} />, {
      columns: 80,
    });

    expect(stripAnsi(output)).toBe(" › /compact 压缩上下文\n   /exit 退出\n   /model 模型\n   /new 新对话");
    const view = SlashCommandMenuView({ menu: menuState("/") }) as ReactElement<{
      children: ReactNode;
    }>;
    const firstRow = Children.toArray(view.props.children)[0] as ReactElement<{
      children: ReactElement<{ children: ReactNode }>;
    }>;
    const lineParts = Children.toArray(firstRow.props.children.props.children);
    expect((lineParts[0] as ReactElement<{ color?: string }>).props.color).toBe("cyanBright");
    expect(lineParts).toContain("/compact");
  });

  it("highlights only the canonical-name prefix for /m and keeps labels dim", () => {
    const output = renderToString(<SlashCommandMenuView menu={menuState("/m")} />, {
      columns: 80,
    });

    expect(stripAnsi(output)).toBe(" › /model 模型");
    const view = SlashCommandMenuView({ menu: menuState("/m") }) as ReactElement<{
      children: ReactNode;
    }>;
    const row = Children.toArray(view.props.children)[0] as ReactElement<{
      children: ReactElement<{ children: ReactNode }>;
    }>;
    const lineParts = Children.toArray(row.props.children.props.children);
    const highlightedName = Children.toArray(
      (lineParts[2] as ReactElement<{ children: ReactNode }>).props.children,
    )[0] as ReactElement<{ bold?: boolean; color?: string; children: ReactNode }>;
    const label = lineParts[4] as ReactElement<{ dimColor?: boolean }>;
    expect(highlightedName.props).toMatchObject({
      bold: true,
      color: "cyanBright",
      children: "/m",
    });
    expect(label.props.dimColor).toBe(true);
  });

  it("highlights the whole canonical name for an exact match", () => {
    const output = renderToString(
      <SlashCommandMenuView menu={menuState("/model")} />,
      { columns: 80 },
    );

    expect(stripAnsi(output)).toBe(" › /model 模型");
    const view = SlashCommandMenuView({ menu: menuState("/model") }) as ReactElement<{
      children: ReactNode;
    }>;
    const row = Children.toArray(view.props.children)[0] as ReactElement<{
      children: ReactElement<{ children: ReactNode }>;
    }>;
    const lineParts = Children.toArray(row.props.children.props.children);
    const highlightedName = Children.toArray(
      (lineParts[2] as ReactElement<{ children: ReactNode }>).props.children,
    )[0] as ReactElement<{ children: ReactNode }>;
    expect(highlightedName.props.children).toBe("/model");
    expect(lineParts[2]).not.toHaveProperty("props.children.1", "model");
  });

  it("moves the selected marker without inverse row styling", () => {
    const output = renderToString(<SlashCommandMenuView menu={menuState("/", 1)} />, {
      columns: 80,
    });

    expect(stripAnsi(output)).toBe("   /compact 压缩上下文\n › /exit 退出\n   /model 模型\n   /new 新对话");
    expect(output).not.toContain("\u001B[7m");
  });

  it("renders a one-line empty state when no Slash Command matches", () => {
    const output = renderToString(<SlashCommandMenuView menu={menuState("/z")} />, {
      columns: 80,
    });

    expect(stripAnsi(output)).toBe(" 无匹配");
    const view = SlashCommandMenuView({ menu: menuState("/z") }) as ReactElement<{
      children: ReactElement<{ dimColor?: boolean }>;
    }>;
    expect(view.props.children.props.dimColor).toBe(true);
  });

  it("truncates every Slash Command row in a narrow terminal", () => {
    const output = stripAnsi(
      renderToString(<SlashCommandMenuView menu={menuState("/")} />, {
        columns: 10,
      }),
    );

    expect(output.split("\n")).toHaveLength(4);
    for (const line of output.split("\n")) {
      expect(stringWidth(line)).toBeLessThanOrEqual(10);
    }
  });

  it("does not render an idle fallback when the menu is not visible", () => {
    const state = createTuiState({
      status: "idle",
      sessionId: "session-1",
      cwd: "/workspace",
      messages: [],
      pending: null,
      model: "gpt-5-codex",
      reasoningEffort: "high",
      contextWindow: 418_000,
      contextTokens: 0,
      sessionTotalTokens: 0,
      sessionInputTokens: 0,
      sessionCachedInputTokens: 0,
    });
    const output = stripAnsi(
      renderToString(<ActivityLine state={state} now={0} />, { columns: 80 }),
    );

    expect(output).toBe("");
    expect(output).not.toContain("/exit");
    expect(output).not.toContain("命令");
  });

  it("separates the border frame from the input viewport", () => {
    const frame = InputLine({
      input: "first\nsecond",
      cursor: { row: 1, column: 6 },
      columns: 30,
      maxRows: 5,
    }) as ReactElement<{ children: ReactNode }>;
    const body = Children.toArray(frame.props.children)[1] as ReactElement<{
      borderStyle?: string;
      borderTop?: boolean;
      children: ReactNode;
    }>;
    const viewport = Children.only(body.props.children) as ReactElement<{
      overflow?: string;
      children: ReactNode;
    }>;

    expect(body.props.borderStyle).toBe("round");
    expect(body.props.borderTop).toBe(false);
    expect(viewport.props.overflow).toBe("hidden");
    expect(Children.count(viewport.props.children)).toBe(2);
  });

  it("keeps the input border static", () => {
    const output = stripAnsi(renderToString(
      <InputLine input="" cursor={{ row: 0, column: 0 }} columns={40} />,
      { columns: 40 },
    ));
    expect(output).toContain(`╭${"─".repeat(37)}╮`);
    expect(output).not.toContain("Working...");
  });

  it("renders the cursor without moving the surrounding characters", () => {
    const renderAt = (column: number) =>
      stripAnsi(
        renderToString(
          <InputLine
            input="abc"
            cursor={{ row: 0, column }}
            columns={20}
          />,
          { columns: 20 },
        ),
      );
    const firstPosition = renderAt(1);
    const secondPosition = renderAt(2);

    expect(firstPosition).toBe(secondPosition);
    expect(firstPosition).toContain("❯ abc");
    expect(firstPosition).not.toContain("a▍bc");
  });

  it("grows across wrapped and explicit lines", () => {
    const output = stripAnsi(
      renderToString(
        <InputLine
          input={"abcdefghi\nsecond"}
          cursor={{ row: 1, column: 6 }}
          columns={14}
          maxRows={10}
        />,
        { columns: 14 },
      ),
    );

    expect(output.split("\n")).toHaveLength(6);
    expect(output).toContain("❯ abcdef");
    expect(output).toContain("  ghi");
    expect(output).toContain("  second");
  });

  it("caps pasted content and keeps the cursor row visible", () => {
    const output = stripAnsi(
      renderToString(
        <InputLine
          input={"one\ntwo\nthree\nfour\nfive"}
          cursor={{ row: 4, column: 4 }}
          columns={20}
          maxRows={3}
        />,
        { columns: 20 },
      ),
    );

    const lines = output.split("\n");
    expect(lines).toHaveLength(5);
    expect(output).not.toContain("one");
    expect(output).not.toContain("two");
    expect(output).toContain("three");
    expect(output).toContain("four");
    expect(output).toContain("five");
  });

  it("keeps the reported large paste intact inside a bounded viewport", () => {
    const lastLine = reportedPaste.split("\n").at(-1) ?? "";
    const output = stripAnsi(
      renderToString(
        <InputLine
          input={reportedPaste}
          cursor={{
            row: reportedPaste.split("\n").length - 1,
            column: lastLine.length,
          }}
          columns={80}
          maxRows={5}
        />,
        { columns: 80 },
      ),
    );

    const lines = output.split("\n");
    expect(lines).toHaveLength(7);
    expect(output).not.toContain("editor.fontFamily");
    expect(output).toContain('"git.autofetch": true,');
    expect(output).toContain('"explorer.confirmDragAndDrop": false,');
    expect(output).toContain("}");
  });

  it("keeps both side borders outside every pasted-content row", () => {
    const output = stripAnsi(
      renderToString(
        <InputLine
          input={reportedPaste}
          cursor={{ row: 4, column: 20 }}
          columns={30}
          maxRows={5}
        />,
        { columns: 30 },
      ),
    );

    for (const line of output.split("\n")) {
      expect(stringWidth(line)).toBeLessThan(30);
      if (line.startsWith("│")) {
        expect(line.endsWith("│")).toBe(true);
      }
    }
  });

  it("does not emit full-terminal-width rows that a TTY would autowrap", () => {
    const columns = 80;
    const lastLine = reportedPaste.split("\n").at(-1) ?? "";
    const output = stripAnsi(
      renderToString(
        <InputLine
          input={reportedPaste}
          cursor={{
            row: reportedPaste.split("\n").length - 1,
            column: lastLine.length,
          }}
          columns={columns}
          maxRows={5}
        />,
        { columns },
      ),
    );

    const overflowing = output
      .split("\n")
      .filter((line) => line.length > 0 && stringWidth(line) >= columns);
    expect(overflowing).toEqual([]);
  });

  it("does not interleave distinct JSON keys on one visual row after a large paste", () => {
    const output = stripAnsi(
      renderToString(
        <InputLine
          input={reportedPaste}
          cursor={{ row: 26, column: 20 }}
          columns={80}
          maxRows={10}
        />,
        { columns: 80 },
      ),
    );
    const keys = [
      "foxundermoon.shell-format",
      "terminal.integrated.suggest.enabled",
      "git.autofetch",
    ];
    const collisions = output.split("\n").filter((line) => {
      return keys.filter((key) => line.includes(key)).length > 1;
    });
    expect(collisions).toEqual([]);
  });

  it("wraps full-width characters by terminal cell width", () => {
    const output = stripAnsi(
      renderToString(
        <InputLine
          input="你好世界"
          cursor={{ row: 0, column: 4 }}
          columns={12}
          maxRows={10}
        />,
        { columns: 12 },
      ),
    );

    expect(output).toContain("❯ 你好");
    expect(output).toContain("  世界");
  });
});
