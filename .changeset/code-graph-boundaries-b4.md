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

B4 violations join each scope's existing count in `boundary-ceilings.json`, so a
scope with outside-to-internal imports today reports `EXCEEDED` under
`--boundaries --ci` after upgrading. Re-record the ceilings once with
`code-graph <scope> --boundaries --write-ceilings` to freeze that debt, then
ratchet it down.
