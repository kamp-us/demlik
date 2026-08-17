# 0011 — Errors are data; a throw is reserved for a contract breach

- **Status:** Accepted
- **Date:** 2026-07-17
- **Scope:** how `@demlik/tea` represents a failure. One principle decides it —
  is the failure recoverable, or is it a bug? Records the idiom landed in PR #307
  (issue #283), locked by
  [`../../src/error-idiom.test.ts`](../src/error-idiom.test.ts). The two
  resulting shapes are canonized as **settled-value error** / **thrown error** in
  `.glossary/TERMS.md` (in the originating monorepo).

## Context

An audit item (#283) proposed one uniform error idiom — `class extends Error`
with a `readonly _tag`, everywhere. That is the right shape for *some* failures
and the wrong shape for others, and picking by shape-first is what made the
question confusing. The real question is not "what class do I use" — it is **what
is the caller supposed to do next?**

Two things can go wrong at runtime, and they want opposite handling:

- A **recoverable failure** has a sensible next move — retry the call, send the
  user to log in again, or give up on this one item and carry on. The program is
  working correctly; the world just said no.
- A **contract breach** — a bug — has *no* sensible next move. Two ports were
  registered under one name; a reducer has no cell for a Msg; a reducer returned
  a Promise. Nothing downstream can "handle" this; the code itself is wrong.

TEA adds a hard constraint on the first kind: Model must be **serializable**. It
is folded from Msgs and persisted through a `Store<S>` as JSON. Any failure that
becomes part of Model must survive a JSON round-trip.

## Decision

**A recoverable failure — one with a sensible next move (retry, re-login, give
up) — is DATA: a `{ _tag }` value folded into Model, never thrown. A throw is
reserved for a contract breach — the code itself is wrong and there is no next
move.**

**1. Recoverable failure → a plain labeled value folded into Model.** It is a
`{ _tag, … }` record, `_tag`-switchable, JSON round-trip-equal — never thrown,
because the caller *has* a next step and needs the failure in hand to take it.
Real settle sites in the code:

- a `resilient-call` deadline lapses → the call settles with
  `{ _tag: "deadline_exceeded", … }` (`../../src/resilient-call/index.ts` ~:664),
  and the machine's next move is retry-or-give-up.
- an `authed-call` comes back 401 → it settles with `{ _tag: "unauthorized", … }`
  (`../../src/authed-call/index.ts` ~:381), and the next move is re-login.

These are outcomes of a correctly-running program, so they belong in Model. A
`class extends Error` **cannot** live in Model: reloaded from the `Store<S>` JSON
it comes back as `{}` — it loses **both** its prototype (so `instanceof` dies)
**and** its `_tag`. A plain sentinel survives the round-trip intact, which is why
it is the only correct shape here.

**2. Contract breach → thrown as a `class extends Error` with a `readonly
_tag`.** When the code is wrong there is no handler to hand a value to, so it is
thrown — the developer gets `PortNameCollisionError: …` with a real stack and a
line number, and the test goes red immediately at the fault. Examples:
`PortNameCollisionError` (`../../src/runtime-types.ts`), `NoCellError`
(`../../src/pure/core.ts`); siblings `QuiescenceTimeoutError`,
`TerminalTimeoutError`, `RetryExhaustedError`. The `_tag` rides along so a
consumer can also branch by tag, but the shape is a real `Error` because it is
meant to *stop the program at the bug*, not flow through Model.

**Why not make bugs data too, for consistency?** Because a bug has no handler. If
you hand a `{ _tag: "port_collision" }` up as a value, one of two things happens:
either it bubbles untouched to the top and gets re-thrown there anyway (so the
throw only *moved* — and you paid for `Result`-plumbing on every call in
between), or someone quietly swallows it and the program runs on corrupted —
silent corruption, which is strictly worse than stopping. Stopping at the fault,
loudly, is the correct behavior for a bug. So the throw stays.

**The best case: most bugs never reach a throw at all — the types refuse to
compile.** A reducer that returns a Promise won't type-check (the non-thenable
`SyncReturn` return type rejects it); an exhaustive cell map makes a missing case
a compile error. The runtime throws are the **backstop** for the cases types
can't catch — a type-bypass (`as`, bad boundary data) or a value that arrived
untyped from the wire. Compile-time refusal first; the throw is the safety net
under it.

**Rejected — the audit's "one idiom, class+`_tag` everywhere."** Uniform-by-shape
puts a `class extends Error` into Model, where it reloads as `{}` and breaks the
serializable-Model bedrock of TEA. One shape cannot straddle the
recoverable/bug boundary, because the two kinds want opposite handling.

## Consequences

- The choice is mechanical, not stylistic: *does the caller have a next move?*
  Yes → a `{ _tag }` value in Model. No → throw a tagged `Error` at the boundary.
- The invariant is locked by
  [`../../src/error-idiom.test.ts`](../src/error-idiom.test.ts): settled errors
  JSON-round-trip-equal, with a contrast test proving a class member would not.
- **Banned:** throwing a recoverable failure (the caller needs it as a value);
  putting a `class extends Error` into Model (reloads as `{}`); relying on
  `instanceof` for a settled value (only its `_tag` survives persistence);
  swallowing a contract-breach throw to "keep going" (that is the silent
  corruption the throw exists to prevent).
- **Cost:** a contributor learns the one question instead of memorizing a class
  list. The payoff is that recoverable failures stay durable in Model and bugs
  stop loudly at the fault — each correct by construction for its site, with a
  test fence that fails if a recoverable failure regresses into a thrown class.
