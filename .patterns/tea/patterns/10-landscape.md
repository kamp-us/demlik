# Pattern 10 — The TEA Landscape

Other implementations of TEA and what each gets right or wrong.
Measured against the four invariants and Elm's canonical design.

## Comparison table

| Dimension | Elm (reference) | raj | redux-loop | hyperapp | elm-ts | Lustre (Gleam) | Iced (Rust) |
|---|---|---|---|---|---|---|---|
| Cmd repr | Opaque algebraic data | `effect(dispatch)` fn | Plain JS object | `[fn, payload]` | `Observable<Task<Option<Msg>>>` | Opaque `Effect(msg)` | `Task<Message>` |
| Sub repr | Managed Sub (opaque) | None | None | `[subscriberFn, payload]` | `Observable<Msg>` | Within effects | `Subscription<T>` |
| State purity | Returned | Returned | Returned | Returned | Returned | Returned | `&mut self` mutation |
| Msgs serializable | Always | Any value | Yes (actions) | No (fns) | Yes | Yes (custom types) | Yes (enums) |
| Active | Language stalled | Complete (34 lines) | Dormant | "Done" | Dead (2021) | Active | Very active |

## raj — the existence proof

**Source:** https://github.com/andrejewski/raj (34 lines, 190 bytes)

Proves TEA doesn't need Elm. The runtime is one function. The effect model is
`effect(dispatch)` — a function, not data. This is the simplest possible TEA:
too small to abuse.

**Gets right:** Core loop is faithful. `init` returns `[state, effect]`.
`update(msg, state)` returns `[state, effect]`. View is a side effect of state.

**Gets wrong:** Effects are functions, not data — loses serializability and
testability-by-inspection. No subscriptions.

## redux-loop

**Source:** https://github.com/redux-loop/redux-loop (2k stars, dormant)

Bolts Cmd back onto Redux via store enhancer. Reducers return
`loop(newState, cmd)` — a tuple of state + effect description.

**Gets right:**
- Cmds are pure data, testable via `.simulate()`
- Core insight preserved: "the reducer decides what happens next"

**Gets wrong:**
- No subscriptions — half the TEA effects model is missing
- Bolting onto Redux means you carry all Redux baggage alongside TEA
- `successActionCreator`/`failActionCreator` API is imperative-flavored

## hyperapp

**Source:** https://github.com/jorgebucaran/hyperapp (19k stars, "done")

Actions return `[newState, ...effects]`. ~1KB framework.

**Gets right:**
- Subscriptions are first-class, state-reactive (lifecycle managed automatically)
- `[effecter, payload]` is a genuinely elegant two-tuple encoding
- Extreme minimalism

**Gets wrong:**
- Actions as functions lose serializable-message property (no time-travel, no logging)
- No types — `[State, ...Effects]` has no type safety
- Effecters receive raw `dispatch` — escape hatch into imperative

## elm-ts

**Source:** https://github.com/gcanti/elm-ts (301 stars, dead since 2021)

Most theoretically pure TS implementation. `Cmd<Msg>` is literally
`Observable<Task<Option<Msg>>>`.

**Gets right:**
- Most faithful TEA port: `init: [Model, Cmd<Msg>]`, `update: (msg, model) => [Model, Cmd<Msg>]`
- Interpreter (BehaviorSubject + subscribe) is visible and explicit

**Gets wrong:**
- Requires fp-ts + RxJS — heavy dependency chain
- `Observable<Task<Option<Msg>>>` is three layers of wrapping — type correct, DX hostile
- Dead project, no maintenance path

## Lustre (Gleam)

**Source:** https://github.com/lustre-labs/lustre (1.6k stars, active)

Graduated application types: `lustre.simple` (no effects) →
`lustre.application` (full TEA). Three-phase effect timing
(synchronous / before_paint / after_paint).

**Gets right:**
- Graduated types provide an on-ramp (like Elm's sandbox → element)
- Gleam's type system makes the pattern feel native (exhaustive matching, no null)
- Server components — Elm meets LiveView

**Gets wrong:**
- No standalone subscriptions concept — simplification but loses declarative sub management
- Gleam ecosystem still young

## Iced (Rust)

**Source:** https://github.com/iced-rs/iced (30k stars, very active)

`update` takes `&mut self` and returns `Task<Message>`. Used by COSMIC desktop.

**Gets right:**
- Rust's type system makes impossible states impossible
- Subscription lifecycle via stream identity is elegant
- Massive community, production use

**Gets wrong:**
- `&mut self` breaks pure-function guarantee — update is impure mutation
- No tuple return `(State, Cmd)` — state mutation and effect return are separate channels
- Struct-with-methods means state and behavior are coupled

## Key takeaway

The implementations closest to Elm's design (elm-ts) died from ecosystem
weight. The ones that thrive (Iced, Lustre) adapted TEA to their language's
idioms while keeping the core loop.

The winning move: keep `init → (model, effect)` and
`update(msg, model) → (model, effect)` as the skeleton, but make the effect
type language-native rather than trying to replicate Elm's exact type structure.
