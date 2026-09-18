# Domain docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- Read root `CONTEXT-MAP.md` first. It names the bounded contexts and their relationships.
- Read the `CONTEXT.md` for every package relevant to the task.
- Read relevant ADRs under that package's `docs/adr/`.
- Check root `docs/adr/` for system-level ADRs when the directory exists.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## File structure

This repo has two bounded contexts. Shared core is a foundation package, not a third context.

```
/
├── CONTEXT-MAP.md
├── docs/adr/                  # optional system-level decisions
└── packages/
    ├── core/
    ├── harness/
    │   ├── CONTEXT.md
    │   └── docs/adr/
    └── tui/
        ├── CONTEXT.md
        └── docs/adr/
```

## Use the glossary's vocabulary

When output names a domain concept in an issue title, refactor proposal, hypothesis, or test name, use the term from the owning context's `CONTEXT.md`. Do not use a synonym listed in `_Avoid_`.

Across contexts, refer to the other context's term by name. Do not copy or redefine the other context's glossary entry. `CONTEXT-MAP.md` is the only place that records paths and context relationships.

If the concept you need isn't in the glossary yet, that's a signal: either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If output contradicts an existing ADR, state the conflict instead of silently overriding it. A package ADR owns decisions inside that context. A root ADR, when present, owns a system-level decision. The more specific applicable ADR wins only when it explicitly supersedes the broader one.

> _Contradicts ADR-0007 (event-sourced orders), but worth reopening because…_
