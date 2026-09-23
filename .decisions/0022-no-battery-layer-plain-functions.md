---
id: 0022
title: Reusable logic ships as plain functions and Cmds called from update, never a battery layer
status: accepted
date: 2026-09-23
tags: []
---

# 0022 — Reusable logic ships as plain functions and Cmds called from update, never a battery layer

**What this decides:** demlik has no layer that wraps or mounts a machine for you. Reusable logic
is a plain function or a `Cmd.define`d Cmd, and you call it from your own `update`, as in Elm.

## Context

Map https://github.com/kamp-us/demlik/issues/245 asked how demlik should package reusable logic.
Spikes https://github.com/kamp-us/demlik/issues/261 and
https://github.com/kamp-us/demlik/issues/265 showed that a composition layer (`mount*` helpers,
`with*` machine wrappers, or a new `defineBattery` / `plug` / `wrap` / `composeMachines` API) can
work. Each one also adds API that Elm does without: in Elm, reusable logic is just modules of
functions.

Session https://github.com/kamp-us/demlik/issues/268 ruled on it as R1.1. The founders' ruling is
at https://github.com/kamp-us/demlik/issues/268#issuecomment-5788678598 and is carried onto this
record's issue at https://github.com/kamp-us/demlik/issues/272#issuecomment-5790163287. Can
(cansirin), relayed by umut: "let's just remove batteries man, let's just simplify this". Asked
whether that means "drop the `mount*` and `with*` layers, keep the function libraries", umut
answered: "yes, record it on the map".

This ADR amends [0001](./0001-no-offtheshelf-resilience.md) in part. 0001 scopes itself to "the
wrapper tier (`with-resilience`, `with-deadline`, `resilient-call`, `deadline`)" and talks about
resilience in wrapper terms: the `$resilience` / `$deadline` wrapper slices, "~770 lines per
wrapper", and "every wrapper passes the conformance gate every release". The R1.1 round itself
says 0001 "names the wrapper tier as the user-facing resilience shape and needs an amendment".

It also amends [0010](./0010-export-map-tiers.md) in part. 0010's consolidation verdict 2 keeps
`with-resilience` as the survivor of the `resilient-call` / `with-resilience` collapse, and this
ruling removes `withResilience`.

## Decision

**demlik has no battery or plugin layer: reusable logic lives only as plain functions and
`Cmd.define`d Cmds that users call from their own `update`.**

1. **The L1 bricks stay.** `retry-backoff`, `circuit-breaker`, `rate-limit`, `cache`,
   `idempotency`, `paginator` and the `work-queue` ops keep their pure verbs.
2. **The L2 helpers slim down.** They keep their pure verbs and their Cmd defs. Their
   `handlers(ports)` already goes, per [0021](./0021-handler-outcome-becomes-the-msg.md).
3. **The wrappers are removed.** `mount*`, `withResilience` and `withDeadline` go.
4. **`withTelemetry` moves inside tea** as one of tea's internal extensions
   (https://github.com/kamp-us/demlik/issues/263). It is no longer a user-facing wrapper.

**What this changes in 0001.** The wrapper tier (`with-resilience`, `with-deadline`) leaves
0001's scope, and so do its wrapper wording and its per-wrapper conformance duty. 0001 still
covers the pure verbs (`resilient-call`, `deadline`) and the L1 bricks. Its decision stands
unchanged: resilience is built in-house as pure functions over machine data, it must stay durable
and replayable, and the narrow-exception note still limits when we build instead of install.

**What this changes in 0010.** Verdict 2's survivor, `with-resilience`, is removed, so that
verdict no longer names the resilience door to keep. The resilient-call pure verbs stay, per item
2. The tiers, their semver promises and verdicts 1 and 3 stand.

**Banned.**

- A new API that mounts, wraps or composes machines for the user, such as `mount*`, `with*`
  machine wrappers, `defineBattery`, `plug`, `wrap` or `composeMachines`.
- Treating 0001 as a reason to keep or rebuild `withResilience` or `withDeadline`.

## Consequences

- Users wire the verbs into their own `update` themselves. `mountResilientCall` existed because
  wiring resilient-call by hand took 8 pieces, 3 of which only failed at run time. So those verbs
  have to get simpler to wire.
- No known external user imports anything that is removed. The removal lands in one minor, per
  [0016](./0016-removal-lands-in-a-minor-at-0x.md). The removal itself is spec
  https://github.com/kamp-us/demlik/issues/273, not this record.
- [0015](./0015-hide-the-wiring-never-the-state.md) still governs the convenience surfaces that
  remain. Its scope line lists `withResilience` as an example, and that example goes away with the
  code.

## Records

no vocabulary impact
