/** One place for every color, so the UI reads as a single system. */
export const theme = {
  accent: "#d97757",
  accentDim: "#8a4f38",
  user: "#7aa2f7",
  text: "white",
  muted: "gray",
  thinking: "#9d7cd8",
  success: "#8ec07c",
  error: "#e06c75",
  warn: "#e5c07b",
  border: "#3b4048",
} as const;

export const glyphs = {
  prompt: "›",
  bullet: "⏺",
  pending: "◌",
  ok: "✔",
  fail: "✖",
  thinking: "✳",
} as const;

export const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
