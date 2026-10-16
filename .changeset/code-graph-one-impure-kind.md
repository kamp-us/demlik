---
"@demlik/code-graph": minor
---

`code-graph --boundaries` reports one kind, `impure`, where it reported five. A file that is impure where its place forbids it is one entry, and the place comes from the entry's `from` path. This is a hard break with no alias: a `boundary-ledger.json` or `boundary-rules.json` that names an old kind or key is refused.

- `impure-application` (B7), `door-outside-driven-adapter` (B9) and the world half of `impure-library` (B13) become `impure`, labelled B7. It fires in `application/`, `index.ts`, `ports.ts`, a driving adapter and a pure library, and not in a driven adapter or a test file. A pure library's world-library import is still reported, now under `impure`, and the type-only count stays.
- `door-outside-owner` (B5) is deleted, with the `doors` key of the rules file and the `process` member check that only it used. `impure-rules` (B2) is deleted, with the `global` flag on a ledger entry and the `layout` and `contracts` rules keys. Hexagonal is the only layout, so the `rules` layout is gone. Ledger entries of the five old kinds must be removed, and a `--ci` run writes the new `impure` entries once you accept them. B2, B5, B9 and B13 are retired and not reused.
- `--json` impure entries carry `specifier` and `typeOnly` and no `feature` or `global` key.
- The catalog of impure globals is `IMPURE_GLOBALS`, in `impure.ts`. The word "door" is gone from the code, the docs, the README and the CLI help.
- `@demlik/code-graph/boundaries` now exports `BoundaryRulesSchema` and the `BoundaryRules` type, so a tool can parse a `boundary-rules.json` with the same schema the CLI uses.
- `BOUNDARY_KINDS` is derived from the table of crossings in `violation.ts`, so a kind cannot be added without a row. Its name and element type are unchanged, and it now holds `impure` and none of the five old kinds.
