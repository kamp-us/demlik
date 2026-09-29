---
"@demlik/code-graph": patch
---

`--layers` resolves tsconfig `paths` aliases instead of filing them as `external`.

A bare specifier that is neither relative nor a workspace package name now resolves through the
importing file's nearest `tsconfig.json`, `extends` followed, with the same `oxc-resolver` options
the edge pass uses and no type-checker. An alias such as `@app/features/billing/x` that lands on a
file inside the repo is layered and judged like a relative import, so an upward aliased import is
now a violation. An alias that matches a `paths` key but names no file is counted and listed as
UNRESOLVED. An npm dependency, installed or not, a node builtin and a scheme import stay
`external`, and a repo with no tsconfig gets the same census as before.
