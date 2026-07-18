# 0005 — Web timeline player: hosting + render primitive

- **Status:** Accepted
- **Date:** 2026-06-24
- **Scope:** the build slices of epic #137 (the Raft `SimTrace` web timeline
  player). Two decisions only — **where the player is served** and **what
  primitive draws the cluster diagram**. No UI code; this records the choices
  that unblock #142–#144.

## Context

Epic #137 builds a shareable web player for a deterministic, JSON-serializable
`SimTrace`: a play/seek timeline over a multi-node Raft run, a cluster diagram
(role-colored node boxes, RPC arrows), and a side panel (per-node state + the
event/Msg stream). The epic's Approach already fixes the interaction layer
(TEA: `Model`/`Msg`/pure `update`/`view` over a pure `toTimelineModel` adapter)
and defers two infra forks the codebase does not settle to this ADR:

1. **Hosting.** `services/scratchpad` already wires the exact stack the player
   needs — Vite 7 + `@cloudflare/vite-plugin`, `wrangler deploy`, React 19 (via
   the pnpm catalog), Tailwind 4, and hash-based routing in `App.tsx`
   (`#/editor`, `#/ascii-art`, `#/d/:id`, `#/packs`). It already hosts a second,
   unrelated sub-app (`ascii-art`) under one service and one deploy. The
   alternative is a tiny new Vite+Workers service. The tension: scratchpad is a
   calculator app, so a Raft visualization is a thematic stranger to its bundle.

2. **Render primitive.** `@demlik/tea/devtools` is a published subpath export
   (`StateInspector`, `MsgLog` / `useMsgHistory`, `StateDiff` / `diffState`,
   plus `devtools/styles.css`) — props-driven and fully decoupled from the
   runtime, so it drops into any React host. But it ships no spatial layout:
   node-boxes-positioned-in-2D-with-arrows-between-them is not something any
   devtools component provides. The question is whether to hand-roll that
   diagram or contort an existing component into a layout it was never meant
   for.

## Decision

**1. Host the player as a route inside `services/scratchpad`, not a new
service.** Add a hash route (e.g. `#/raft` / `#/sim/:id`) following the
`ascii-art` sub-app precedent already in `App.tsx`. Rationale: every piece of
infra the player needs — Vite + Cloudflare plugin, `wrangler deploy`, React 19,
Tailwind, hash routing, and `@demlik/tea` reachable as a `workspace:*` dep — is
already wired and deployed in scratchpad, which already proves the
multiple-sub-apps-in-one-service pattern with `ascii-art`; standing up a second
Vite+Workers service would duplicate that toolchain and CI surface to dodge a
purely cosmetic "calculator vs. raft" bundle-coupling worry, while a route gives
the maintainer a live, shareable URL on an already-deployed origin today —
exactly the demo-able artifact #137 is for. The bundle concern is real but
cheap to neutralize: the player is a lazy-loaded route, so it costs scratchpad's
existing users nothing until visited, and a vanity path can be cut over to a
dedicated service later without changing a line of the player's TEA code.

**2. Hand-roll the cluster diagram as SVG; reuse `@demlik/tea/devtools` for the
side panel.** Draw role-colored node boxes at computed positions with RPC arrows
as SVG over them, and compose `StateInspector` (focused node's state) and
`MsgLog` (the event/Msg stream) from `@demlik/tea/devtools` for the inspector
panel — do not force the spatial node-and-arrow layout into a devtools component.
Rationale: the devtools components are presentational, props-only, and a
published subpath, so they are the correct reuse for the panel and re-implementing
a JSON inspector or message log would be pointless duplication; but a 2D layout of
positioned boxes with arrows between them is categorically not what those
components model, and bending one to fake it would invert the dependency (UI
shape dragging the inspector around) for no saving over ~100 lines of
deterministic SVG. SVG is the honest primitive for a spatial diagram, keeps the
view a pure function of `toTimelineModel`'s render cells, and stays testable.
This confirms — does not revise — the Approach and Resolved-questions sections
of #137.

## Consequences

- The player ships as a lazy route in `services/scratchpad`; #142–#144 target
  that service and reach `@demlik/tea` (incl. `/devtools`) via `workspace:*`.
  scratchpad gains its first `@demlik/tea` dependency.
- The shareable URL lives under the existing scratchpad origin — no new
  Worker, no new deploy pipeline. A later extraction to a dedicated service
  remains a pure-mechanical move because the player is self-contained TEA.
- Two render layers with one seam: hand-rolled SVG for the diagram, reused
  `devtools` for the panel. New visual work is confined to the diagram; the
  inspector/log inherit devtools' behavior and `devtools/styles.css`.
- Arrow data and the rest of the render contract are governed by #137's
  Resolved questions (the optional additive `SimStep` field in #144); this ADR
  does not change `SimTrace`/`SimStep`.
