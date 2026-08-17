# 0010 — Export-map tiers: kernel/battery/experimental, showcases off the map

- **Status:** Accepted
- **Date:** 2026-07-17
- **Scope:** the shape of the `@demlik/tea` npm `exports` map — how many
  stability promises it carries and where integration demos live. Records the
  tiering + consolidation verdicts already landed across the raft-move
  (#268/#269), the `./resilient-call` deprecation (#270), and the tier stamps
  (#272). The full tier table, per-tier semver policy, deprecate-don't-delete
  ritual, and store-factory-per-host table are the living contract in
  [`../../MAINTAINING.md`](../MAINTAINING.md) — this ADR records *why* the map
  is tiered, not the table itself.

## Context

`@demlik/tea` publishes a wide `exports` surface — a small pure kernel plus a
growing family of named patterns (the call-hardening / flow / observability
batteries) and a couple of raw experimental primitives. Left flat, every one of
those ~50 subpaths would carry a single, undifferentiated stability promise: one
semver contract stretched across a frozen kernel and a still-moving battery. That
has three costs. **Semver hostage** — a breaking change to any experimental
primitive forces a major (or a dishonest minor) on the whole package, so the
kernel's stability is held hostage by the least-settled corner. **Attention
dilution** — a consumer reading the export map cannot tell the load-bearing
kernel from a demo; everything reads as equally blessed. **Conceptual-integrity
drift** — with no tier boundary, showcase/integration code creeps onto the
published surface and the "what is the kernel" question loses its answer.

The raft-move (#268/#269) pulled the Raft *showcase* out of the published package
into its own workspace package consumed by `services/site`; the
`./resilient-call` deprecation (#270) exercised the deprecate-don't-delete path;
and #272 stamped every remaining subpath with a tier. Those three changes are
already merged. This ADR records the decision they implement.

## Decision

**The `@demlik/tea` export map is tiered, not flat. Every published subpath
carries exactly one tier stamp — `stable` (kernel) / `battery` / `experimental` —
and each tier binds its own semver promise.**

- **kernel (`stable`)** — the pure core; the strongest promise.
- **battery** — a published named pattern built over the kernel (call-hardening /
  flow / observability families); may break in a **minor** when flagged in the
  changelog.
- **experimental** — a raw primitive allowed to move fastest.

**Showcases are OFF the export map.** An integration proof like the Raft showcase
is **not** a published subpath: it lives in `packages/raft-showcase` and is
consumed like any external customer, so a kernel break breaks
the site build — the honest signal a demo is supposed to give.

The tier table (every subpath → its stamp), the per-tier semver policy, the
deprecate-don't-delete ritual (stamp `@deprecated` + mark the row, then remove
per the tier's rule — live example `./resilient-call` → `./with-resilience`), and
the store-factory-per-host table are the single source of truth in
[`../../MAINTAINING.md`](../MAINTAINING.md). This ADR does not duplicate them.

### Consolidation verdicts — which near-duplicate subpaths collapse, and why

Tiering the map forced a per-family question: where two subpaths look alike, do
they collapse to one or stay distinct? Three families were adjudicated. The
verdict and its *rationale* are recorded here (the resulting stamps live in the
`MAINTAINING.md` tier table):

1. **throttle / debounce / throttled-input → NO collapse.** These are not
   duplicates — `throttle` and `debounce` are two distinct timing primitives, and
   `throttled-input` is a machine *composed over* them. Collapsing would merge a
   primitive with a thing built from it; they are a layering, so all three stay
   as separate subpaths.
2. **resilient-call → with-resilience → collapse; survivor is `with-resilience`.**
   These two *were* the same concern expressed twice. `with-resilience` (the
   higher-order `withResilience(base, …)` wrapper) is the survivor; `resilient-call`
   is deprecated (#270). The deprecation is a **migration, not a drop-in re-export**
   — the APIs are deliberately not interchangeable (see the migration map in the
   `resilient-call` module's `@deprecated` JSDoc), so it walks the
   deprecate-don't-delete steps rather than aliasing.
3. **workflow / saga → keep both; the boundary is compensation.** They look
   adjacent but differ in a load-bearing way: a `SagaStep` **requires** both `do`
   and `undo` (a step without its inverse is not a saga step —
   `packages/tea/src/saga/index.ts`), whereas a `WorkflowStep`'s `compensation` is
   **optional** (a step with no compensation is simply skipped on the unwind —
   `packages/tea/src/workflow/index.ts`). Mandatory-inverse vs optional-compensation
   is a real semantic split, so both subpaths stay.

**Rejected — a flat, untiered export map (~50 subpaths at one stability
promise).** It makes the kernel a semver hostage to the least-settled subpath,
dilutes the consumer's attention across kernel and demo alike, and lets showcase
code drift onto the published surface. The tier split is what keeps "what is the
kernel" answerable.

## Consequences

- Every published subpath must be stamped in the tier table before it ships;
  an unstamped subpath is an incomplete surface, not a default-stable one.
- A break in an `experimental` or `battery` subpath no longer forces a major on
  the whole package — the promise is read per tier, so the kernel stays stable
  independently.
- Showcases never enter `package.json` `exports`. New integration demos follow
  the Raft precedent: a workspace package consumed by `services/site`, off the
  published surface.
- **Banned:** adding a subpath to `exports` without a tier stamp; publishing a
  showcase/integration proof as a subpath; deleting a deprecated subpath without
  walking the deprecate-don't-delete steps in `MAINTAINING.md`.
- **Cost:** the map carries per-tier bookkeeping — every subpath needs a stamp
  and the table must stay in sync. The payoff is an honest semver contract and a
  kernel whose stability is no longer hostage to the frontier.
