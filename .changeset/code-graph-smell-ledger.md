---
"@demlik/code-graph": minor
---

The smell gate can now be switched on at today's count. Name the rules to gate in `smell-ledger.json` at the repo root (`{ "gated": ["big-file"] }`), record today's smells once with `--accept-smells --reason "<why>"`, and from then on `--ci` fails only on a smell of a gated rule the ledger does not name, at any severity, or on a recorded one that got worse, such as a 900-line file grown to 950. Improvements are written back: an entry whose smell shrank is lowered, and one whose smell is gone is pruned, so the ledger only tightens. Entries are keyed by rule and repo-relative target (a function by its id, never its line), so one file covers every package and `code-graph .` judges a package the same as `code-graph packages/core`. Gating an edge-pass rule turns the edge pass on. A repo that gates no rule keeps today's `--ci`, `--fail-on` and `--max` unchanged.
