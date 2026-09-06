# 0014 — Effect's E and R channels are types on Cmd constructors, never Effect values at the core

- **Status:** Accepted
- **Date:** 2026-09-04
- **Scope:** what `@demlik/tea` takes from the Effect library and what it refuses. Settles
  the recurring "effectify tea" proposal: the typed-error (`E`) and typed-requirements (`R`)
  discipline is adopted as *types* carried by Cmd constructor functions; an `Effect<A, E, R>`
  runtime value is never a Cmd, a Msg, or a member of Model.

**What this decides:** we steal Effect's type-level contract for failures and dependencies, and
we do not let an Effect program anywhere it would have to be saved, hashed, or replayed.

## Context

tea and Effect agree on the founding idea — an effect is a value you *describe*, and something
else *runs* it later. They differ only in how that value is spelled. A tea `Cmd` is a **closed**
plain record (`{ type: "retry", wait: 250 }`): finite, JSON-serializable, structurally hashable.
An `Effect<A, E, R>` is an **open** program: a tree of closures carrying captured state. That
openness is Effect's power and the one property tea's kernel cannot admit, because the kernel's
promise is *crash, reload the JSON, resume at the exact spot*. Two things in this repo depend on
the closed spelling directly: the journal / `recorder` / `trace-replay` surfaces write Cmds as
data, and `structural-hash.test.ts` proves two replays yield structurally-equal output. A closure
can be neither serialized nor compared, so an Effect value emitted by `update` breaks both.
`Effect.runSync` does not rescue it — sync-vs-async was never the axis; saveable-vs-not is.

[0001](./0001-no-offtheshelf-resilience.md) already refused Effect's `Schedule`/`retry` as a
runtime dependency — "fiber state, no mid-flight persist; competes with TEA as a paradigm-level
dependency". That ruling stands untouched; this ADR draws the line one notch finer, between
Effect's runtime (still refused) and its type discipline (taken).

What tea currently *lacks*, and what makes the proposal keep coming back, is Effect's type
discipline at the effect boundary. Today `tryInterpret`'s failure callback receives
`error: unknown` (`src/runtime-types.ts` ~:1010), so a reducer's error cell must sniff a mystery
box, and `Ctx` is one untyped bag a handler can reach into for a dependency nobody provided. Both
are invalid states the types let in — the exact holes Effect's `E` and `R` parameters close.
[0011](./0011-errors-as-data.md) already fixed the *runtime* shape of a recoverable failure as a
`{ _tag }` value; it left the *compile-time* union of those tags unnamed. This ADR names it.

## Decision

**A Cmd's failure union and its runtime requirements are type parameters carried by the
constructor function that builds it; the value it returns stays a plain tagged record, and no
`Effect` value ever crosses into `update`, a Cmd, a Msg, or Model.**

1. **Constructors carry the types, cards carry the data.** Every Cmd is built by a constructor
   function — `Cmd.fetch(url)`, not a hand-written literal — whose return type is
   `Cmd<Type, Ok, E, R>`: `E` the `_tag` union this Cmd can settle with, `R` the slice of `Ctx`
   its handler needs. The returned *value* is the same dead record it is today.
2. **`E` is the `_tag` union, nothing else.** A settled failure remains the plain `{ _tag, … }`
   value 0011 mandates; `E` is its static name. `interpret[type]` returns
   `Result<Ok, E>` with `E` inferred from the constructor, so the reducer's error cell is
   exhaustively typed and a new failure mode is a compile error, not a runtime surprise.
3. **`R` is checked at wiring.** A machine whose Cmds require `{ http }` cannot be handed to a
   `run` whose `Ctx` lacks it; the requirement is the union of every constructor's `R`. Today's
   `undefined` at call time becomes a type error at `run`.
4. **Effect is welcome one step to the right.** An `interpret` handler is `(cmd, ctx) => Msg`;
   its body may be authored in Effect and resolved with `Effect.runPromise` at the edge, returning
   a plain Msg. Effect lives on the impure side of the boundary and never crosses back.
5. **Constructor functions, never classes.** A `class` for a Cmd, Msg, or Model member reloads
   from the `Store<S>` as a prototype-less object — 0011's `{}` failure in a new coat. Only a
   plain-object-returning function may be a constructor here.

**Banned.** Emitting an `Effect` value from `update`; storing one in Model, a Cmd, or a Msg;
hand-writing Cmd literals where a typed constructor exists; a `class` constructor for any
persisted shape; widening a handler's `E` to `unknown` to "keep it simple".

## Consequences

- The kernel's replay and journal guarantees are untouched — every persisted value is still a
  card. This is a stable-tier *type* change, additive: an untyped Cmd defaults `E` to `unknown`
  and `R` to `{}`, so existing machines compile unchanged and tighten as constructors land.
- Errors become exhaustively handled by construction, and a missing dependency fails at `run`
  rather than at 3 a.m. Both advance [0001](./0001-no-offtheshelf-resilience.md)'s in-house
  resilience without a new runtime dependency.
- **Cost:** each battery module grows a small constructor surface, and a contributor learns
  "types on the constructor, data in the record" as the one rule. The reward is that the next
  "let's just use Effect" thread has a settled answer: inside the handler, never at the core.

## Records

no vocabulary impact — `E`/`R` are Effect's own names, used here only as type-parameter labels;
the runtime shapes they annotate (settled-value error, Cmd, Ctx) are already canonized.
