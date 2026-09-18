export type LineEnding = "lf" | "crlf" | "mixed" | "none";

export type LineEndingCounts = {
  readonly lf: number;
  readonly crlf: number;
};

export type Utf8TextDecoding =
  | { readonly ok: true; readonly text: string; readonly bom: boolean }
  | { readonly ok: false };

export function countLineEndings(text: string): LineEndingCounts {
  let lf = 0;
  let crlf = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "\n") {
      continue;
    }
    if (index > 0 && text[index - 1] === "\r") {
      crlf += 1;
    } else {
      lf += 1;
    }
  }
  return { lf, crlf };
}

export function detectLineEnding(text: string): LineEnding {
  const { lf, crlf } = countLineEndings(text);
  return lf === 0 && crlf === 0
    ? "none"
    : lf > 0 && crlf > 0
      ? "mixed"
      : crlf > 0
        ? "crlf"
        : "lf";
}

export function isWellFormedUnicode(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const codeUnit = text.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return false;
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

export function decodeUtf8Text(bytes: Uint8Array): Utf8TextDecoding {
  if (bytes.includes(0)) {
    return { ok: false };
  }
  const bom =
    bytes.length >= 3 &&
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      bom ? bytes.subarray(3) : bytes,
    );
    return { ok: true, text, bom };
  } catch {
    return { ok: false };
  }
}
