# TEA Patterns — Canonical Reference

This folder is the **single source of truth** for The Elm Architecture as a discipline.
Every assertion is grounded in the official Elm guide, the elm/browser source,
elm-community examples, elm-spa-example, Elm Radio episodes, and established
implementations (raj, elm-ts, Lustre, Iced).

This is not documentation for any specific codebase. It is the standard that
implementations are measured against.

## File Index

### Core TEA

| File | What it answers |
|------|----------------|
| [01-invariants.md](01-invariants.md) | What makes something TEA vs "just a reducer"? The 4 invariants. |
| [02-elm-examples.md](02-elm-examples.md) | Canonical Elm code from the official guide + raj source. |
| [03-signature.md](03-signature.md) | Why `(Model, Cmd Msg)` is the minimum return type. |
| [04-effects-as-data.md](04-effects-as-data.md) | Cmd, Sub, the effects contract. |
| [05-interpreter.md](05-interpreter.md) | Where the interpreter lives = your architecture. |

### Design Patterns

| File | What it answers |
|------|----------------|
| [11-impossible-states.md](11-impossible-states.md) | Discriminated unions over boolean flags. |
| [12-testing.md](12-testing.md) | How to test TEA — replay, assert on the pair, never mock. |
| [13-error-handling.md](13-error-handling.md) | Errors are Msgs. Result types. Railway pattern. |
| [14-ports-interop.md](14-ports-interop.md) | Ports, flags, custom elements — the JS boundary. |
| [16-module-boundaries.md](16-module-boundaries.md) | When to split files. Opaque types. Parse don't validate. |

### Scaling and Production

| File | What it answers |
|------|----------------|
| [07-msg-scaling.md](07-msg-scaling.md) | When Msg unions become a liability + composition strategies. |
| [15-decisions.md](15-decisions.md) | Decision tables — Cmd vs Sub, init shape, persistence, sub gating. |
| [17-spa-patterns.md](17-spa-patterns.md) | Production TEA: routing, session, forms, loading states, API layer. |

### Context

| File | What it answers |
|------|----------------|
| [06-fractal.md](06-fractal.md) | TEA is not frontend — the isomorphism across systems. |
| [08-typescript-tax.md](08-typescript-tax.md) | What TEA costs in TypeScript vs Elm. |
| [09-anti-patterns.md](09-anti-patterns.md) | Invariant violations — what you have when TEA breaks. |
| [10-landscape.md](10-landscape.md) | raj, elm-ts, redux-loop, Lustre, Iced — comparisons. |
| [sources.md](sources.md) | Every citation with URL. |

## How to use this

| Task | Read |
|------|------|
| Building a new TEA machine | 01 → 02 → 04 → 11 |
| Designing state | 11 (impossible states) → 15 (decisions) |
| Scaling a large app | 07 (msg scaling) → 17 (spa patterns) → 16 (module boundaries) |
| Handling errors | 13 → 15 (msg arm vs log) |
| Writing tests | 12 → 03 (replay contract) |
| JS interop / ports | 14 |
| Debugging a TEA violation | 01 → 09 |
| "Should I Cmd or Sub?" | 15 (decision 1) |
| "When to split into modules?" | 16 → 07 |
