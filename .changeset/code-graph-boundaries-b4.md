---
"@demlik/code-graph": minor
---

`--boundaries`: rule **B4** judges imports from code outside every declared feature (#393).

Until now the pass only looked at an importer inside a declared feature or a
`lib` folder, so under incremental adoption, with one feature declared and the
rest of the tree undeclared, any other file could reach into a feature's
internals unflagged. B4 closes that: a file in no declared feature and no `lib`
folder may import a feature only through its `src/<feature>/index.ts`; any
other file of the feature, `rules/` included, is a B4
`outside-imports-feature-internal` violation. `lib` importers stay with B3, and
B1–B3 verdicts are unchanged.

Each B4 crossing is its own entry in `boundary-ledger.json`, so a scope with
outside-to-internal imports today fails `--boundaries --ci` on every one the
ledger does not name after upgrading. Record the ones that stay with
`code-graph <scope> --boundaries --accept-crossings --reason "<why>"`, then
remove them one crossing at a time.
