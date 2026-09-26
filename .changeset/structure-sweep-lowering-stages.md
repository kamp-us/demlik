---
"@demlik/structure-sweep": minor
"@demlik/code-graph": minor
---

Add lowering stages 2 to 5 to structure-sweep, and expose code-graph's SCC pass as
`@demlik/code-graph/scc` (#423).

- **`@demlik/code-graph/scc`** re-exports `stronglyConnectedComponents` and `sccMembers`. No CLI
  flag, JSON schema or config key changes.
- **Stage 2, lowering** (`lowerStage`, `loweringInput`). Parses a file with `oxc-parser`, now a
  runtime dependency, and writes one fact per `return`, per `throw`, and per call under a non-empty
  path condition. Each fact carries atoms with their own spans and a `return` / `throw` / `call`
  outcome. Names are neutral and `console` calls (plus any added logging roots) are stripped. A
  function that does not parse lowers to `unknown` (`undetermined`).
- **Stage 3, the lexicon** (`resolveStage`, `loadLexicon`, `proposeLexicon`).
  `structure-sweep.lexicon.json` maps an identifier to a `flag`, `entitlement`, `role`, `plan`,
  `setting` or `env` concept. Resolution is deterministic, and the lexicon's fingerprint keys the
  stage. `proposeLexicon` drafts entries through the gate and never writes over the reviewed file.
- **Stage 4, callee summaries** (`summarize`). Walks the call graph leaves-first by SCC. Each
  summary carries return-value facts and each branch's stage-5 label as a `FactValue`. A caller's
  `=== null` check on a callee's result resolves to the callee's condition, and each SCC's key cites
  its callees' summary digests.
- **Stage 5, the branch label** (`branchLabelQuestion`, `labelBranches`, `branchLabeller`). Labels
  are `rule`, `defence`, `plumbing` and `could-be-data`, and each criterion has a definition and
  anchoring examples. Jev names the atoms and spans it relies on before it gives the label, and that
  evidence is recorded with the answer. `evaluateAnchoring` compares the flip rate with and without
  the examples.
- `gate`, `gateAll` and `Asker` take an optional answer type, and `Gated` now carries each item's
  `settled` outcome.
