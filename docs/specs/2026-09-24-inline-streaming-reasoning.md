# Print the provider's reasoning while it streams

Status: ready-for-agent · 2026-09-24 · prototyped in `packages/tui/src/prototype/reasoning/` (variant C won)

## Problem Statement

Susan already receives reasoning from every provider that produces it (Anthropic
thinking deltas, Responses reasoning summaries, OpenAI-compatible
`reasoning_content`), but the TUI throws almost all of it away. The live region
prints the last 400 characters on one wrapping line, dim purple, and then wipes
it the moment the answer starts.

For a user watching a long turn this is the worst of both worlds:

- While reasoning streams, the visible text is a sliding window with no
  beginning: sentences are cut mid-word at the left edge and the line's height
  jumps around as the window slides.
- Once the answer arrives, the reasoning is gone. There is no way to see why the
  agent chose the tool it chose, so the one artifact that explains a wrong turn
  is unrecoverable. Re-running is the only recourse, and reasoning is not
  reproducible.
- Nothing says how long the model has been thinking, or how long the turn has
  been running. A slow turn and a hung turn look identical.

## Solution

Reasoning becomes transcript content instead of a transient status effect.

While a reasoning block streams, susan prints it in full under a header that
names it and counts its elapsed time:

```
✳ Thinking · 1.6s
The user says the status bar flickers while tokens stream. Two things could cause
that. Either the bar re-renders on every delta and Ink repaints the whole frame,
or the usage numbers themselves change width on every delta and the

 ⠏ Working · 2.3s
```

When the block ends, that same rendering stays in the transcript, in order,
above the tool calls and the answer it led to. The header's timer stops and
freezes at the block's total duration. Nothing is truncated and nothing
disappears:

```
✳ Thinking · 4.4s
The user says the status bar flickers while tokens stream. ... Let me read the
status bar and check what it depends on.

✔ read packages/tui/src/components/StatusBar.tsx
  └ read 41 lines

✳ Thinking · 1.4s
Confirmed. The percentage is recomputed from usage.inputTokens on every render
and usage_progress arrives per delta, so the row does change width mid-stream.

The flicker is layout, not repaint. StatusBar right-aligns the model label, and
the token count next to it changes width on every usage_progress.
```

Separately, the working row gets the same treatment as the thinking header: the
spinner is followed by `Working` (capitalised) and the elapsed time of the whole
run, so a turn that is merely slow can be told apart from one that is stuck.

The two clocks mean different things and that is deliberate: `Thinking · 4.4s`
is one reasoning block and stops when the block ends; `Working · 12.4s` is the
whole run, spans tool calls and multiple reasoning blocks, and disappears when
the run ends.

## User Stories

1. As a susan user, I want the model's reasoning printed in full as it streams, so that I can read it as prose instead of a sliding 400-character window.
2. As a susan user, I want reasoning to start at its beginning rather than mid-word, so that I can follow the argument from the top.
3. As a susan user, I want the reasoning block to stay in my scrollback after the turn, so that I can go back and see why the agent did what it did.
4. As a susan user, I want each reasoning block to sit above the tool calls it led to, so that the transcript reads in causal order.
5. As a susan user, I want a second reasoning block later in the same run to appear as its own block, so that I can tell "thought, acted, thought again" from one long thought.
6. As a susan user, I want a header that labels reasoning as reasoning, so that I never confuse it with the answer.
7. As a susan user, I want reasoning styled distinctly from the answer, so that I can skim past it when I only want the result.
8. As a susan user, I want the elapsed time of the current reasoning block, so that I can judge whether the model is thinking hard or wandering.
9. As a susan user, I want that timer to freeze at the block's final duration once the block ends, so that the transcript records how long each thought took.
10. As a susan user, I want the working row to read `Working`, so that the live region is capitalised consistently with `Thinking`.
11. As a susan user, I want the elapsed time of the whole run next to the working spinner, so that I can tell a slow turn from a hung one.
12. As a susan user, I want the run timer to keep counting while a tool runs, so that a long `bash` call does not look like a freeze.
13. As a susan user running a turn with no reasoning at all, I want the live region to look exactly as it does today apart from the run timer, so that the change costs nothing on non-reasoning models.
14. As a susan user on a provider that streams no reasoning, I want no empty reasoning header, so that the transcript is not littered with blank blocks.
15. As a susan user, I want reasoning line-wrapped to my terminal width, so that resizing does not corrupt the transcript.
16. As a susan user on a narrow terminal, I want the header and the run timer to stay on one line, so that the footer does not reflow while the timer ticks.
17. As a susan user, I want to interrupt with esc mid-thought and still see the partial reasoning that had arrived, so that I know what the agent was about to do.
18. As a susan user who interrupts, I want the partial block's timer frozen rather than left ticking, so that no spinner or clock runs after the run has stopped.
19. As a susan user, I want `/clear` to drop reasoning along with the rest of the transcript, so that a cleared session is really empty.
20. As a susan user scrolling far back, I want reasoning frozen into scrollback like every other finished item, so that scrolling is not slowed by re-rendering old thoughts.
21. As a susan user, I want the answer to keep streaming into the live region as it does today, so that reasoning display does not delay the answer.
22. As a susan user on Anthropic with interleaved thinking, I want each thinking block between tool calls to render as its own block, so that the transcript matches what the model actually did.
23. As a susan user on a Responses-style gateway, I want reasoning summaries rendered the same way as Anthropic thinking, so that switching providers does not change how susan reads.
24. As a susan user on an OpenAI-compatible endpoint that returns `reasoning_content`, I want that text rendered identically, so that the display does not depend on which vendor is behind the loop.
25. As a susan user switching models mid-session with `/model`, I want reasoning from both providers to render the same way, so that the transcript stays uniform.
26. As a susan user, I want token usage in the status bar to keep updating while reasoning streams, so that I can see reasoning tokens being spent.
27. As a susan developer, I want the harness to tell the TUI where a reasoning block ends, so that the TUI does not have to guess block boundaries from the order of other events.
28. As a susan developer, I want the mock provider to emit the same block-boundary event as the real ones, so that `--mock` exercises the real rendering path.
29. As a susan developer, I want a reasoning block closed even if a provider stream ends without a boundary event, so that a truncated stream cannot leave a block open forever.
30. As a susan developer, I want the reasoning rendering to live in the same component as the rest of the transcript, so that there is one place that decides what a log item looks like.

## Implementation Decisions

### The harness gains an explicit reasoning-block boundary

`ProviderEvent` gains `thinking_end` and `AgentEvent` gains
`thinking_end` carrying the accumulated text, mirroring the existing
`text_delta` / `text_end` pair:

```ts
// ProviderEvent — providers know where their own block ends
| { type: "thinking_end" }

// AgentEvent — the loop accumulates the block and hands it over whole
| { type: "thinking_end"; text: string }
```

The TUI must not infer the boundary from "the first non-thinking event after
some thinking deltas". Inference happens to work for today's providers, but it
silently merges two adjacent reasoning blocks and it puts knowledge of provider
streaming shape in the renderer. The loop already owns exactly this
accumulate-then-announce job for text, so reasoning follows that precedent.

Emission points per provider:

- **anthropic**: `content_block_stop` for a block whose start was a thinking block.
- **responses**: the reasoning summary text `done` event.
- **openai-completion**: the first delta that carries content or tool calls after
  reasoning has been seen, and at stream end if a block is still open.
- **mock**: after its scripted thinking chunks.

The loop emits `thinking_end` inside the provider-stream iteration, so ordering
against `tool_pending` is preserved: a block that precedes a tool call is
announced before that tool's row appears. The loop also closes an open block
before `stream.final()` if the provider never announced one, so a truncated or
misbehaving stream cannot leave a block open.

Multiple summary parts arriving with no boundary between them stay one block.
Blocks separated by a boundary event stay separate blocks, each with its own
duration.

### The TUI keeps reasoning as a transcript item

`session-state.ts` gains a `ReasoningItem` in the `LogItem` union:

```ts
export interface ReasoningItem {
  kind: "reasoning";
  id: string;
  text: string;
  /** Wall-clock duration of the block, measured in the TUI. */
  ms: number;
}
```

`LogView.tsx` gains the matching case, so committed reasoning is rendered by the
same component that renders every other finished item, and is frozen into
`<Static>` scrollback with them.

`use-agent.ts` replaces `thinkingText` (a `slice(-400)` string) with a
reasoning-in-flight value; this is the shape the prototype settled on:

```ts
interface ReasoningState {
  text: string;            // full block, never truncated
  active: boolean;
  startedAt: number | null;
  endedAt: number | null;
}
```

- `thinking_delta` appends and stamps `startedAt` on the first delta.
- `thinking_end` appends a `ReasoningItem` to the live run with
  `ms = now - startedAt`, then resets the in-flight value.
- `done` with any reason other than `end_turn` commits whatever partial block is
  open, so an interrupt keeps the thought that was in progress, with its timer
  frozen.

Elapsed time is measured in the TUI, not the harness: it is a display concern
and the harness stays free of wall-clock concerns. Consequence, accepted: a
session rehydrated from the session store would have reasoning text but no
durations. The store keeps thinking blocks for the model's benefit, not for
redisplay, and the TUI does not rehydrate transcripts today.

### Rendering

- Live block and committed block use the same markup, so nothing shifts on the
  screen at the moment a block completes; only the timer stops.
- Header: `✳ Thinking` in `theme.thinking`, then a dim `· <duration>`.
- Body: full text in `theme.thinking`, dim, italic. Terminals without italic
  degrade to plain dim purple, which is acceptable.
- Working row: spinner, then `Working` in `theme.thinking`, then a dim
  `· <duration>` of the whole run, measured from `send()`.
- Duration format: below 10s one decimal (`4.4s`), below a minute whole seconds
  (`12s`), above that `1m05s`.
- The run timer ticks on a ~150ms interval while the run is busy, and the
  interval is cleared when it is not, so an idle susan does not re-render.
- The working row keeps its single-line layout under narrow terminals: the
  spinner and label do not shrink, and the timer truncates rather than wrapping.
  The prototype hit a real Ink defect here — a sibling `Text` with
  `wrap="truncate-end"` shrinks the spinner out of existence unless the spinner
  and its label sit in a `flexShrink={0}` box and the truncating text sits in a
  `flexGrow={1} minWidth={0}` box. Carry that fix over.

### Deliberately unchanged

The harness's `ThinkingBlock` conversation type, the session store format, and
provider request construction all stay as they are. This is a display feature
plus the one event needed to drive it.

## Testing Decisions

A good test here asserts what the user sees, never how the state got there: it
renders the real `App` against a fake `ModelProvider` and matches Ink frames.
No test should reach into `use-agent` internals or assert on `ReasoningState`.

Seam: the existing App-level seam only. No new seams.

Prior art to copy verbatim in structure: `packages/tui/test/status-usage.test.mjs`
(inline fake provider whose stream is gated on deferred promises, frames
collected from a `Writable`, `waitForFrame(frames, pattern)`) and
`packages/tui/test/footer-layout.test.mjs` (real `App` at several terminal
sizes).

Cases worth one test each, driven by a fake provider that yields
`thinking_delta` → `thinking_end` → `tool_use_start` → `thinking_delta` →
`thinking_end` → `text_delta`:

1. Reasoning is visible in full while it streams — assert on a phrase from the
   start of the block, which today's 400-character tail would have dropped.
2. The completed block is still present after the answer arrives, and appears
   above the tool row and the answer.
3. Two blocks in one run render as two blocks with two headers.
4. The headers carry a duration, and the run timer appears next to `Working`.
5. Interrupting mid-block leaves the partial block in the transcript and no
   spinner or ticking timer behind.
6. A provider that emits no reasoning produces no header.

Timers make frame assertions racy if a test waits for a specific duration
string; match the shape (`/Thinking · \d/`), not a value.

The harness change is covered through the same seam. `packages/harness/test`
gets no new file: the existing loop tests already cover event ordering, and the
one new event is observable from the App seam.

## Out of Scope

- Collapsing, expanding, or hiding reasoning (`ctrl+t`, a `/thinking` command, a
  setting). Variants B and D in the prototype covered those; the decision was
  full inline prose with no controls. A collapse affordance can be added later
  on top of `ReasoningItem` without revisiting this spec.
- Rendering reasoning from a resumed session, and therefore persisting
  durations.
- Any change to how reasoning is sent back to the provider, and to thinking
  signature round-tripping.
- Reasoning token counts in the status bar or in the reasoning header. The
  prototype showed a `chars` counter and it was cut.
- The pre-existing ordering wart whereby a turn with both text and tool calls
  commits its assistant text below the tool rows, because `text_end` is emitted
  after `tool_pending`. Worth fixing, unrelated to this feature.
- The `StatusBar` reflow bug used as filler content in the prototype's canned
  script. It is a plausible bug, but it was never diagnosed.

## Further Notes

The prototype lives at `packages/tui/src/prototype/reasoning/` with five
variants (tail line, fixed panel, inline prose, status row, sentence bullets)
switchable with the arrow keys, driven by a canned replay so every variant is
judged against the same tokens. Variant C (inline prose) won. It is throwaway
code: once this spec is implemented, the prototype and its `pnpm proto:reasoning`
script come out of `master` and live on a throwaway branch.

The rejected variants are worth remembering as the alternatives this spec turned
down: a fixed-height bordered panel that never changes height (rejected as
heavier chrome that still discards the text), a one-line status-row gist
(rejected as too little), and one line per completed sentence (rejected as
lossy, since it truncates every sentence to a line).
