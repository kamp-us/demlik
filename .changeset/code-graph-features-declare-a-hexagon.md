---
"@demlik/code-graph": minor
---

A scope that declares `features` in the boundary rules is now a hexagon: its features are laid out
in the hexagonal zones, so B6-B10 judge it, and B9 judges every catalog door in its `index.ts`,
`ports.ts` and `adapters/driving/`, with no second list to keep. The `layout` key is now only an
opt-out: `layout: { "<scope>": "rules" }` keeps a scope on the `rules/` layout, which is what a scope
with no `layout` entry used to get. The `strictDriving` key is removed, because every hexagonal
scope has what it switched on, and a rules file that still holds it is refused as an unknown key.

To upgrade a rules file, add `layout: { "<scope>": "rules" }` for each scope that declares
`features` and relied on the `rules/` layout, and delete `strictDriving`.
