---
"@demlik/code-graph": minor
---

`--boundaries --ci` gates a per-edge ledger instead of a per-scope count (#412).

`boundary-ledger.json` at the repo root holds one entry per crossing import (scope, rule kind,
importer, target or bare specifier, the specifier as written, and an optional reason), keyed by
`(scope, kind, from, to ?? specifier)` and written sorted. The gate exits 1 only when a measured
crossing has no entry, and lists each one, so removing one crossing and adding a different one in
the same scope now fails. Entries whose crossing is gone are pruned from the file on every run and
printed, never failed on. The ledger grows only through
`--boundaries --accept-crossings --reason "<why>"`, which refuses without a reason.
`--boundaries --write-ceilings` now exits 2 naming `--accept-crossings`; `--comments` and
`--collapse` keep `--write-ceilings`.

**Migration.** A repo with a `boundary-ceilings.json` runs this once, from the repo root, and
commits the result:

```sh
code-graph . --boundaries --migrate-ceilings
```

It seeds `boundary-ledger.json` from the crossings measured now and deletes
`boundary-ceilings.json`. It refuses (exit 2, nothing written) when any scope crosses more than
its recorded count: remove the new crossings first. Until then `--boundaries --ci` exits 2 naming
`--migrate-ceilings`.

New subpath `@demlik/code-graph/boundaries`: the ledger schema, reader and writer, and
`rekeyBoundaryLedgerFile(file, moves)` / `rekeyBoundaryLedger(ledger, moves)`, which re-key the
entries whose importer or target moved so a tool that moves files keeps the ledger in step in the
same commit.

`InProcessGraph` (from `@demlik/code-graph/resolve`) gains `dispose()`. A graph now holds one tsgo
session from its first `resolveExportOrigin` call instead of starting tsgo on every call, with
the same answers. `dispose()` ends that tsgo process; a lookup after it throws.
