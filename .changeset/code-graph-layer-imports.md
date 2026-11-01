---
"@demlik/code-graph": minor
---

`--layers` can fail an import that skips a layer. A layer in the rules file may now list the lower layers it can import, as `"imports": ["coordination"]`. An edge to a lower layer outside the list breaks the rule `outside-imports` and fails with exit 1, the same as an upward edge, and an `allowed` entry can excuse it under the same site count and stale checks. `"imports": []` lets a layer import only itself, and imports inside one layer always pass.

An `imports` entry that names an unknown layer, or a layer above the one declaring it, exits 2 before any analysis. When any layer declares `imports`, the text report tags each edge `[upward]` or `[outside-imports]` and the `--json` edges carry a `rule` field. A rules file with no `imports` prints exactly what it printed before.
