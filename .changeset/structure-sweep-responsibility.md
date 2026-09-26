---
"@demlik/structure-sweep": minor
---

Add a per-function, multi-label responsibility stage to structure-sweep's lowering, and a
deterministic rollup of it to files and folders (#456).

- **The responsibility stage** (`responsibilityRequests`, `responsibilityStage`,
  `labelResponsibilities`). Jev is shown each function's lowered branches, their stage-3
  resolutions and its callees' stage-4 summaries, never its source. For every feature in the
  vocabulary it answers `serves` or `does-not-serve` through `gateAll`, under a `gatePolicy`
  derived from this stage's gold set. It writes one fact per (function, feature), and each reads
  through `verdictOf` as `serves`, `does-not-serve` or `unknown`. An abstained feature also goes to
  the human queue. Runs are keyed through `runStage`, so an unchanged function is a `hit`.
- **The rollup** (`rollup`). For each file and folder and each feature, it counts the functions
  that serve it, the ones that do not, and the ones that are `unknown`, with no Jev call. A folder
  sums the files beneath it, and the output is byte-identical for the same facts.
