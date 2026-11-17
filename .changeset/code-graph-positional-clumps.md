---
"@demlik/code-graph": minor
---

`--clumps` now reports repeated call shapes whose argument names vary between sites, beside existing exact-name clumps ranked by site count. Positional rows include varying reference slots (including static options-object keys), every site and the distinct-tuple count. Fixed slots are omitted, and the existing value and site floors apply without new settings. This supports reviewing Introduce Parameter Object or Preserve Whole Object refactorings when exact-name groups split a recurring shape. Existing exact-name and repeated-value findings, other views, gates and `--clones` are unchanged.
