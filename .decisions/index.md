# Decisions

One row per ADR, repo-wide. Read the file for the why.

| # | Title | Status | Date |
|---|-------|--------|------|
| [0001](./0001-no-offtheshelf-resilience.md) | Resilience is built in-house, not installed | Accepted | 2026-06-09 |
| [0002](./0002-do-host-layer.md) | A Durable-Object host layer, not a DO framework | Accepted | 2026-06-22 |
| [0003](./0003-do-targets-event-sourced-virtual-actors.md) | The DO host targets event-sourced virtual actors | Accepted | 2026-06-23 |
| [0004](./0004-agent-context-compaction.md) | An opt-in context-compaction seam on `createAgent` | Accepted | 2026-06-23 |
| [0005](./0005-web-timeline-player-hosting-and-render-primitive.md) | Web timeline player: hosting + render primitive | Accepted | 2026-06-24 |
| [0006](./0006-client-prediction-fold-seam-and-pure-boundary.md) | Client-prediction fold seam + runtime-free import boundary | Accepted | 2026-06-27 |
| [0007](./0007-source-generated-diataxis-docs-factory.md) | Docs are a source-generated, drift-gated Diátaxis factory | Accepted | 2026-07-17 |
| [0008](./0008-reference-drift-gate-fails-with-the-patch.md) | The reference drift gate fails with the patch, single-sourced | Accepted | 2026-07-17 |
| [0010](./0010-export-map-tiers.md) | Export-map tiers: kernel/battery/experimental | Accepted | 2026-07-17 |
| [0011](./0011-errors-as-data.md) | Errors are data; a throw is reserved for a contract breach | Accepted | 2026-07-17 |
| [0013](./0013-fabrika-is-the-work-pipeline.md) | fabrika is this repo's work pipeline | Accepted | 2026-08-16 |
| [0015](./0015-hide-the-wiring-never-the-state.md) | A convenience layer hides the wiring, never the state | Accepted | 2026-09-04 |

Numbers are inherited from the `csirin/monorepo` sequence this package was extracted
from, and the gaps are real: 0009 (the brain/hand seam) and 0012 (the single-root ADR
convention) are decisions about that monorepo, not about this package, and stayed
behind. Numbering continues from 0013 here.
