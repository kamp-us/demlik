# 0016 — While 0.x, a removal lands in one minor with a changeset callout, never a deprecation lag

- **Status:** Accepted
- **Date:** 2026-09-04
- **Scope:** how a published subpath, module or exported name leaves `@demlik/tea` before 1.0.
  Retires the staged "deprecate, don't delete" ritual in `MAINTAINING.md` and amends
  [0010](./0010-export-map-tiers.md) in part — the tiers and their semver promises stand; only
  the removal ritual changes. Governs the export collapse that follows.

**What this decides:** until 1.0 we delete outright — one PR removes the thing and ships a
changeset that names its replacement — instead of publishing a deprecated twin for a minor first.

## Context

The deprecate-don't-delete ritual (stamp `@deprecated`, keep the door published for a minor,
then remove) buys one thing: a stranger who imported the old door gets a compile-time nudge
before a break. That is worth a minor of duplicated surface **when strangers exist**. They do
not yet. Every repository on GitHub importing `@demlik/tea` is ours — `Binclusive/monorepo`,
`cansirin/monorepo`, `kamp-us/phoenix` — and the ~7.7k monthly downloads are our own CI. The
ritual is currently paying its cost and collecting no benefit.

Meanwhile the cost is compounding. `./resilient-call` has sat "deprecated" since #270 while
remaining the 766-line implementation that `with-resilience` and nine other modules still
import from, so the deprecated door is load-bearing and the successor is a wrapper — the ritual
froze a migration halfway. Two more deprecated aliases (`diff` → `parityEqual` in `./parity`,
the `NoCtx` alias in `pure/core`) have zero in-tree uses and exist only to wait out a minor.
The export collapse ahead (≈65 doors → ≈15) would, under the ritual, ship every old door as a
deprecated re-export for a release, briefly *doubling* the parts bin the collapse exists to
shrink.

The tier policy already permits the fast path: a **battery** may break in a minor with a
changelog flag, and a **stable** break at 0.x lands in a minor with a callout. The ritual was a
courtesy layered on the policy, not the policy. This ADR withdraws the courtesy for the window
in which it protects nobody.

## Decision

**Before 1.0, a subpath, module or exported name is removed in the same PR that replaces
it, carrying a changeset whose breaking-change note names the successor; no deprecated
re-export is published first.**

1. **One PR, one changeset.** The removal, the internal import rewrites and the changeset
   land together. The changeset is `minor` for a stable or battery subpath and states, per the
   tier policy, what moved where — `./retry-backoff` → `./resilience` `{ retryBackoff }`.
2. **A collapse moves parts, never drops them.** A grouped door re-exports every primitive of
   the doors it replaces under a named export; removing the old door removes a path, not a
   capability ([0015](./0015-hide-the-wiring-never-the-state.md)). A genuinely dead twin — a
   superseded implementation, an inverted-name alias — is deleted, with its migration named.
3. **Stable tier still pays the callout, not the lag.** Removing a stable name at 0.x is a
   minor with an explicit breaking-change entry, exactly as the policy already says; the only
   thing withdrawn is the mandatory deprecated minor in between.
4. **Experimental removes silently**, as the tier already allows.
5. **This ADR expires at 1.0.** The first `1.0.0` changeset re-instates a staged removal
   ritual for stable subpaths (post-1.0 removal is a major) — that ritual is written then, for
   the consumers who exist then, not inherited from the one retired here.

**Banned.** Publishing a `@deprecated` re-export as a holding pattern for a removal that can
land now; removing a primitive without a named home in the changeset; a removal PR without a
changeset; citing the retired ritual as a reason to keep a dead door.

## Consequences

- The export collapse ships as N small PRs that each *shrink* the map, with no interim
  doubling. `./resilient-call` finally finishes its migration — the implementation moves into
  its successor and the old door goes.
- A future stranger reads one changelog entry per removal, each naming where the thing went.
  That is the same information the `@deprecated` note carried, delivered once instead of
  published for a release.
- **Cost:** our own three consumers take a compile break on upgrade and fix imports from the
  changeset — a cost we pay once per removal rather than carrying dead surface across a
  release. The 1.0 changeset owes a new ritual (item 5).
- `MAINTAINING.md` §"Deprecate, don't delete" is rewritten to this rule in the same PR, since
  0010 names that file the living contract.

## Records

no vocabulary impact.
