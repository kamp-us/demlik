---
"@demlik/structure-sweep": minor
---

`structure-sweep sweep --nominated` asks Jev only about the files the import graph says may be
misplaced, and reports how many Jev calls it skipped (#445).

A file's current feature is the vocabulary feature whose folder name (`_` → `-`) is the deepest
matching directory segment of its path. Its pull is `move plan`'s: the feature holding a strict
majority of its import edges to files that have a current feature. A file is asked only when the
two disagree; a file whose pull matches its folder, or that has neither, is skipped. A folder run
reads that folder's graph; under `--files` the graph spans the nearest `tsconfig.json` scope above
each listed file. The graph is read from the checkout, not `--ref`, and a tree with no feature
folders asks nothing. Each folder's progress line and the summary line add the skipped count
(files neither nominated nor cached); `SweepScopeResult` carries it as `skipped`, and
`SweepOptions.nominate` (the new `Nominate` type) is the hook. A run without `--nominated` is
unchanged. `graphPulls` and `agreementOf` now live in a module both commands share.
