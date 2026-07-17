# Explanation

Understanding-oriented discussion of how `@demlik/tea` works and why it is shaped this way.

- [ADR 0001 — Resilience is built in-house, not installed](./adr/0001-no-offtheshelf-resilience.md) — why the wrapper tier is hand-built, not an off-the-shelf library.
- [ADR 0002 — A Durable-Object host layer, not a DO framework](./adr/0002-do-host-layer.md) — the `@demlik/tea/do` host is composable functions, not a base class.
- [ADR 0003 — The DO host targets event-sourced virtual actors](./adr/0003-do-targets-event-sourced-virtual-actors.md) — the target the DO host layer is converging toward.
- [ADR 0004 — An opt-in context-compaction seam on `createAgent`](./adr/0004-agent-context-compaction.md) — how an agent trims its own conversation without leaving the reducer.
- [ADR 0005 — Web timeline player: hosting + render primitive](./adr/0005-web-timeline-player-hosting-and-render-primitive.md) — where the devtools timeline is hosted and how it renders.
- [ADR 0006 — Client-prediction fold seam + runtime-free import boundary](./adr/0006-client-prediction-fold-seam-and-pure-boundary.md) — reusing the authoritative reducer on the client, and keeping the runtime out of that bundle.
- [ADR 0007 — Docs are a source-generated, drift-gated Diátaxis factory](./adr/0007-source-generated-diataxis-docs-factory.md) — why these docs are structured this way.
- [TEA discipline & patterns](../../../../.patterns/tea/patterns/README.md) — the conceptual canon the library implements.
