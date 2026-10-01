---
"@demlik/code-graph": minor
---

`--boundaries` now understands a second feature layout, Alistair Cockburn's hexagonal zones, one
scope at a time. A `layout` key in the `--boundary-rules` file opts a scope in:
`"layout": { "services/api": "hexagonal" }`. That scope's features are laid out as `index.ts`,
`ports.ts`, `application/`, `adapters/driving/` and `adapters/driven/`, and five new kinds judge
inside them, each a `boundary-ledger.json` entry recorded with `--accept-crossings --reason` and
pruned as it is fixed:

- **B6 `application-imports-adapter`**: `application/` importing its own feature's `adapters/`.
- **B7 `impure-application`**: any world door used by name or module door opened in
  `application/`, declared or not.
- **B8 `driving-reaches-driven`**: `adapters/driving/` importing its own `application/` or
  `adapters/driven/` instead of going through `ports.ts` and `index.ts`.
- **B9 `door-outside-driven-adapter`**: a declared door used in `index.ts`, `ports.ts` or
  `adapters/driving/`.
- **B10 `unknown-zone`**: a feature entry outside those zones (`domain/`, `helpers.ts`,
  `adapters/shared/`), once per entry.

A file outside every feature may import any feature's adapters (the composition root). A `layout`
for a scope with no `features`, a value other than `rules` or `hexagonal`, and a door owner in a
hexagonal `index.ts`, `ports.ts`, `application/` or `adapters/driving/` exit 2 and write nothing.

A scope without `layout` keeps the `rules/` layout and is unchanged: its report, its ledger entries
and a ledger written before this release read and gate exactly as they did.
