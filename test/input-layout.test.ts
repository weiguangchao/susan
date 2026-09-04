import stringWidth from "string-width";
import { describe, expect, it } from "vitest";
import {
  inputContentWidth,
  layoutInput,
} from "../src/ui/input-layout.js";

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

describe("input layout", () => {
  it("keeps prefix, wrapped text, and the cursor cell inside the text width", () => {
    const columns = 80;
    const width = inputContentWidth(columns);
    const lastLine = reportedPaste.split("\n").at(-1) ?? "";
    const rows = layoutInput(
      reportedPaste,
      {
        row: reportedPaste.split("\n").length - 1,
        column: lastLine.length,
      },
      width,
      10,
    );

    const overflowing = rows.filter(
      (row) => stringWidth(row.text) > width,
    );

    expect(overflowing).toEqual([]);
    expect(rows.some((row) => row.cursorStart !== null)).toBe(true);
  });

  it("keeps a cursor at a wrapped row end on that row", () => {
    const rows = layoutInput("123456", { row: 0, column: 3 }, 3, 10);

    expect(rows).toEqual([
      { text: "123", cursorStart: 3, cursorEnd: 3 },
      { text: "456", cursorStart: null, cursorEnd: null },
    ]);
  });

  it("keeps a cursor at the wrapped end of a pasted long line", () => {
    const width = inputContentWidth(80);
    const longLine = reportedPaste.split("\n")[5] ?? "";
    const rows = layoutInput(
      reportedPaste,
      { row: 5, column: width },
      width,
      10,
    );

    expect(rows[5]).toEqual({
      text: longLine.slice(0, width),
      cursorStart: width,
      cursorEnd: width,
    });
    expect(rows[6]).toEqual({
      text: longLine.slice(width),
      cursorStart: null,
      cursorEnd: null,
    });
  });
});
