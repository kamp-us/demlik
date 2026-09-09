# Explanation

Understanding-oriented discussion of `@demlik/tea` — why it is shaped the way it
is, and what each shape promises you. These pages stand on their own; read one
straight through without following a link.

- [What durability actually promises](./durability-model.md) — how state survives
  a crash, why effects are at-least-once rather than exactly-once, the window
  where a handler can run twice, and what to do about it.
- [Why failures are values and bugs are throws](./errors-as-data.md) — the one
  question that decides an error's shape, and why a recoverable failure cannot be
  an `Error` object in a Model that has to survive persistence.
- [What each import is allowed to do to you](./export-tiers.md) — the `stable` /
  `battery` / `experimental` tiers, what each promises across a version bump, and
  why the surface is not flat.

## Further reading — the decision records

The pages above are written for someone using the package. The records below are
written for someone maintaining it: they carry the alternatives considered and
the history, and they live in the repository rather than in the published docs.
They are one global ADR sequence, indexed in [`.decisions/`](../../.decisions/index.md).

- [ADR 0001 — Resilience is built in-house, not installed](../../.decisions/0001-no-offtheshelf-resilience.md) — why the wrapper tier is hand-built, not an off-the-shelf library.
- [ADR 0002 — A Durable-Object host layer, not a DO framework](../../.decisions/0002-do-host-layer.md) — the `@demlik/tea/do` host is composable functions, not a base class.
- [ADR 0003 — The DO host targets event-sourced virtual actors](../../.decisions/0003-do-targets-event-sourced-virtual-actors.md) — the target the DO host layer is converging toward.
- [ADR 0004 — An opt-in context-compaction seam on `createAgent`](../../.decisions/0004-agent-context-compaction.md) — how an agent trims its own conversation without leaving the reducer.
- [ADR 0005 — Web timeline player: hosting + render primitive](../../.decisions/0005-web-timeline-player-hosting-and-render-primitive.md) — where the devtools timeline is hosted and how it renders.
- [ADR 0006 — Client-prediction fold seam + runtime-free import boundary](../../.decisions/0006-client-prediction-fold-seam-and-pure-boundary.md) — reusing the authoritative reducer on the client, and keeping the runtime out of that bundle.
- [ADR 0007 — Docs are a source-generated, drift-gated Diátaxis factory](../../.decisions/0007-source-generated-diataxis-docs-factory.md) — why these docs are structured this way.
- [ADR 0008 — The reference drift gate fails with the patch, single-sourced](../../.decisions/0008-reference-drift-gate-fails-with-the-patch.md) — how a stale reference tells you exactly what to regenerate.
- [ADR 0010 — Export-map tiers: kernel/battery/experimental](../../.decisions/0010-export-map-tiers.md) — the record behind [What each import is allowed to do to you](./export-tiers.md).
- [ADR 0011 — Errors are data; a throw is reserved for a contract breach](../../.decisions/0011-errors-as-data.md) — the record behind [Why failures are values and bugs are throws](./errors-as-data.md).
- [ADR 0015 — A convenience layer hides the wiring, never the state](../../.decisions/0015-hide-the-wiring-never-the-state.md) — what a higher-level API may absorb, and what it may never hide.
- [ADR 0016 — Removal lands in a minor at 0.x](../../.decisions/0016-removal-lands-in-a-minor-at-0x.md) — why there is no deprecation holding pattern while the package is pre-1.0.
- [ADR 0017 — Fencing is an optional `Store` widening](../../.decisions/0017-fencing-is-an-optional-store-widening.md) — why refusing a second live writer added an interface instead of changing `Store<S>`.
- [TEA discipline & patterns](../../.patterns/tea/patterns/README.md) — the conceptual canon the library implements.
