---
"@demlik/code-graph": minor
---

Bring code-graph level with the copy Binclusive runs. New `--boundaries` pass
(configured by `--boundary-rules`, gated per crossing by `boundary-ledger.json`,
which grows only through `--accept-crossings`); one gitignore-aware file lister behind
every pass; `--kinds` entries for `WorkerEntrypoint` / `DurableObject` public
methods, each carrying `reach` and `guards` (Pothos `authScopes` counts);
effects matched on the callee's declaration rather than its name; `--graph`
with analysis flags on; end lines in `--collapse --json`; and a
`@demlik/code-graph/project` export of `loadEdgeProject`. `--boundaries`
declares no contract packages by default — list them under `contracts` in
the rules file (#344).
