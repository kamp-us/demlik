---
"@demlik/code-graph": minor
---

`--unreachable` no longer reports false findings when packages define their own `paths` alias. A root run, or a `--deep` run, reads one tsconfig, so an import like `@/useda` that only the file's nearest `tsconfig.json` resolves gave no use site, and the exports it reaches were reported as `unused-export` (or `dead`). Every export in a file reached that way is now "uses unknown": none is a finding, a function that would be one is withheld under the new reason `uses-unknown`, and the file is named on stderr.

The limit: a really unused export in such a file is reported by the package's own run and not by the root run, so run the gate on the package as well. Call edges through such an import stay missing, so `--blast` and `calledBy` do not list those callers. A package's own run withholds the same way when a file it loads reaches an export through a tsconfig other than the run's own: a project its `tsconfig.json` references, or a nested tsconfig with its own `paths` such as `e2e/tsconfig.json`. Neither the package run nor the root run reports a really unused export there.
