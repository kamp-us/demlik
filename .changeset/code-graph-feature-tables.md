---
"@demlik/code-graph": minor
---

Allow a feature to import another feature's `adapters/driven/tables.ts` without B1, so table definitions can declare foreign keys without loading the other feature's entry. Tables otherwise keep the driven-zone rules, and B16 still judges application imports when enabled. Existing B1 ledger entries for these imports are pruned by `--ci`.
