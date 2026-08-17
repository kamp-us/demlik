# 0007 — Docs are a source-generated, drift-gated Diátaxis factory

- **Status:** Accepted
- **Date:** 2026-07-17
- **Scope:** packages/tea/docs

> Superseded in part by 0012 (in the originating monorepo): ADRs now live in root .decisions/, not the explanation quadrant.

## Context

`@demlik/tea` shipped a Locked API Surface, ~19 public modules across the root
entry and its subpaths, six ADRs, and a `.patterns/tea/` canon — but no product
documentation. A consumer arriving at the package had the TSDoc in `src/` and the
examples in `examples/`, and nothing that told them which door to walk through
for the job they had. The four jobs a docs reader actually arrives with are
distinct — *learn the library*, *get one task done*, *look a symbol up*,
*understand why it is shaped this way* — and a single flat `README` serves none
of them well because it blurs all four.

The failure mode we had to design against is not "too little documentation"; it
is documentation that **rots** and documentation that **sprawls**. A hand-written
API reference drifts from the code the day after it is written. And a naïvely
generated one goes the other way: an unfiltered per-symbol dump of the typedoc
model exploded to **713 files** — one page per exported symbol — which is not a
reference a human navigates, it is a haystack.

## Decision

Product documentation lives in `packages/tea/docs/{tutorial,how-to,reference,explanation}/`
— the four Diátaxis quadrants, co-located and versioned with the library. The
in-repo markdown is the **sole source of truth**: a future docs site is a
downstream build over these files, never a second copy that can disagree with
them.

Each quadrant is produced and trusted differently, because the four jobs demand
different guarantees:

- **reference is generated, never hand-written.** It is derived from a structured
  source — the typedoc JSON model — filtered by a curated `MODULE_ALLOWLIST` to
  **one page per public module a consumer imports (~19), never one page per
  symbol.** The 713-file per-symbol dump is the named anti-pattern: curation to
  human scale is the invariant, not an optimization. Drift is caught in CI by a
  `TEA_DOCS_WRITE`-gated vitest guard — `docs:reference` regenerates and writes;
  `docs:reference:check` regenerates in memory and fails if the committed pages
  differ. The generated tree is a build output that happens to be committed, so
  it is reviewable; it is never edited by hand.

- **tutorial and how-to are hand-written prose**, because a learning path and a
  task recipe are authored artifacts a generator cannot invent. Their happy-path
  is tracer-verified against the runnable `examples/` — the verification asserts
  *shape* (the example imports the symbols the prose names, the flow runs), never
  exact counts, so an example gaining a step does not break the doc.

- **explanation is the ADRs** — the recorded "why" of every non-trivial fork,
  this file included — with the conceptual TEA canon in `.patterns/tea/` as the
  deeper reading a reader graduates into.

The through-line is that **assertion strictness is per-quadrant**: reference is an
exact snapshot (any drift is a signal, so the guard is byte-exact); tutorial and
how-to are shape-only (the prose is right as long as the example still runs the
shape it describes). Matching the strictness to the quadrant's job is what keeps
the factory both honest and low-friction.

## Deferred debts (the dogfood loop's findings)

Recorded so they are not rediscovered from scratch:

1. **Some public exports still lack per-symbol TSDoc summaries.** Where a symbol
   has no doc comment, its row in the generated reference table has a blank
   description cell. The generator faithfully reflects the source, so the fix is
   TSDoc on the export, not a patch to the reference — but until that TSDoc lands,
   the reference has honest blanks.
2. **The tutorial/how-to tracer lands in Layer 3.** This layer stands up the
   quadrant front-doors and the generated reference; the hand-written lessons and
   guides — and the shape-assertion tracer that binds them to `examples/` — are
   the next increment. Until then the tutorial and how-to compasses list no
   lessons, only the note that they grow.

## Consequences

- A consumer lands on a four-quadrant compass and walks through the door for the
  job they have; no single flat README blurs the four.
- The reference cannot silently drift: a public API change that skips
  `docs:reference` fails `docs:reference:check` in CI.
- A future docs site is a pure downstream build over `docs/` — zero duplicated
  files, nothing that can disagree with the repo.
- The per-quadrant strictness is now the standing rule for adding docs: generate
  and byte-check reference, hand-write and shape-check tutorial/how-to, record
  decisions as ADRs under explanation.
