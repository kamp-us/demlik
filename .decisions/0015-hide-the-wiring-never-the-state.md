# 0015 — A convenience layer hides the wiring, never the state

- **Status:** Accepted
- **Date:** 2026-09-04
- **Scope:** the governing law for every intent-altitude surface built over the kernel —
  `defineAgent`, `defineWorkflow`, `withResilience`, Cmd constructors, the `noCmd`/`withCmds`
  sugar, and any facade that collapses several primitives into one call. Names the property a
  lid may absorb (assembly) and the property it may never absorb (visibility of the durable Model).

**What this decides:** a higher-level API in `@demlik/tea` may spare you from assembling the
parts, but it may never stop you from reading, replacing, or bypassing them.

## Context

The kernel is a pure reducer whose Model is plain JSON that survives eviction and replays exactly
([`.patterns/tea/tea-invariants.md`](../.patterns/tea/tea-invariants.md), invariants 2 and 6).
That is the library's differentiator over the durable-agent frameworks it defines itself against:
their state is a black box inside a runtime they own; ours is one `console.log` away.

The same kernel is hard to adopt. It publishes ~65 subpaths, each named for a *mechanism*
(`fan-out`, `monitored-run`, `llm-call`), and building an agent means hand-wiring `stages`,
`turnOf`, `toolOf`, an interpret map, the `withStructuredOutput` dance and a six-step drive loop.
A newcomer meets a parts bin. The evidence is internal: an engineer with full context of this
library, hardening a scheduled crawl in a downstream repo, hand-rolled backoff, per-item fan-out,
a poller tick and an attempt-vs-success ledger — four things this package already ships — rather
than enter the parts bin (Binclusive/monorepo#5677). The missing piece is an *intent* layer, and
the moment we write one, the question is what it is allowed to take away.

[0002](./0002-do-host-layer.md) already answered it for the DO host in passing — composable
functions, "not a base class that would own the consumer's lifecycle and hide the wiring." That
instinct was local to one adapter. As the `defineAgent` layer opens, it needs to be the law for
the whole altitude, stated once.

## Decision

**A convenience layer removes assembly, never visibility: it may default, generate and sequence
the wiring between kernel parts, but the durable Model stays plain inspectable data and every
layer beneath remains a first-class, reachable escape hatch.**

1. **Wiring is what a lid may hide.** Defaulted stages, a generated `toolOf` + interpret cell
   from one `tool()` value, an absorbed drive loop, a default clock at the effect boundary,
   a constructor that builds a tagged Cmd — all of it is assembly, and a lid exists to delete it.
2. **State is what a lid may never hide.** The Model a lid produces is the same
   JSON-serializable slice the raw kernel would produce, under the same keys; the lid adds no
   private store, no opaque handle, no wrapper object whose contents cannot be read back.
   `getState`, `observe`, `replay` and the journal see exactly what a hand-wired machine shows.
3. **Progressive disclosure is a contract, not a courtesy.** Each altitude is a real door to the
   one below — `defineAgent` → `createAgent` → the composed bricks → the raw reducer — and
   descending one step never requires rewriting the steps above. A lid that can only be used
   whole, or a primitive that can only be reached through a lid, breaks this.
4. **Facade where the common case composes three or more parts; bare where one part suffices.**
   This is the test for whether a lid should exist at all. A one-liner primitive stays a
   one-liner door; the export collapse groups siblings, it does not bury them.
5. **A lid's own ceremony is a measurement.** Every piece of plumbing a lid must perform to sit
   on the kernel is a candidate for the kernel to absorb, for the lid *and* every power user.
   The lid is written thin and named — each hidden thing a helper (`toolRouter`,
   `driveToDone`) — so what it hides stays legible in the source.

**Banned.** A lid that stores Model in a private field or non-JSON wrapper; a facade whose
output cannot be fed to the raw `run`; a primitive removed from the export map because a lid
"covers" it (deprecate-don't-delete, per [0010](./0010-export-map-tiers.md)); a lid that reads
the clock or RNG inside a transition to spare the user threading `at` — that moves impurity into
the kernel rather than hiding wiring at the edge.

## Consequences

- The `defineAgent` work has a pass/fail test: the 3-line program reaches `phase: "done"`, and
  its final Model has the same slice keys as the hand-wired `createAgent` machine.
- The library keeps its one honest claim against LangGraph-class frameworks — you can always
  see the state and always drop a level — while no longer forcing assembly on a newcomer.
- **Cost:** every lid pays for a named-helper decomposition instead of an inline body, and a
  reviewer checks "what did this hide?" against the two lists above. That review question is
  the point; it is cheaper than re-deciding the boundary per PR.

## Records

no vocabulary impact — "wiring" and "state" carry their ordinary meanings; the terms this ADR
governs (Model, Cmd, lid altitude) are already canonized.
