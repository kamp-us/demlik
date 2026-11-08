---
"@demlik/code-graph": minor
---

`code-graph --boundaries` gains B22 `table-declared-outside-tables` and B23 `table-written-outside-owner`, enabled only when a rules file lists them in the new `tableOwnership` key. B22 reports a drizzle table constructor (`pgTable`, `sqliteTable`, `mysqlTable`) called outside a feature's `adapters/driven/tables.ts`. B23 reports a table a feature declares that a file outside that feature passes to `insert`, `update` or `delete`, one entry per file per table, and names the owner in the report. Reads, joins, foreign keys, a type-only import and test files stay clean.

Both read syntax only, so a table passed through a helper or written through raw SQL is not matched as a write; the SPEC and `docs/reference/boundaries.md` list each case and say which are counted. Neither judges a port-layout scope or a scope with no features, and an unknown kind name, or a kind listed where no scope uses the per-feature layout, exits 2 and writes nothing. Entries have a null `to` and work with `--ci`, `--accept-crossings` and `--migrate-ceilings`, which seeds them without counting them against a ceiling. A rules file that does not list a kind gets the same report, ledger and `--json` bytes as before.
