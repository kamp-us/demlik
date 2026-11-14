---
"@demlik/code-graph": minor
---

`code-graph <pkg> --api <map> --api-docs <shape> --ci` fails when a published declaration has a doc block that is missing or out of shape and nobody has excused it.

Before, the doc report listed those declarations and exited 0, so a new public export with no doc block still landed green. Now `--ci` beside the report exits 1 on each one that `api-docs-ledger.json` at the repo root does not hold, and prints its finding lines:

```
API DOCS LEDGER FAILED — 1 declaration(s) in scope packages/core not in api-docs-ledger.json:
  src/ledger/Log.ts:42  make  no doc block
Fix each doc block, or record the declaration: --api <map> --api-docs <shape> --accept-api-docs --reason "<why>".
```

`--accept-api-docs --reason "<why>"` records every such declaration, so a package with a backlog can turn the gate on today and fail only on what is new. An entry is `{ scope, block, file, name, reason }`, with no line number. When a recorded declaration has no finding any more, `--ci` drops its entry and prints it. On a run where the read could not see everything it drops nothing. It works like the API ledger (`--api <map> --ci`), needs no git and runs no emit.

Two things changed on the way:

- The doc report names a declaration inside a namespace with its namespaces, `Labels.long` where it printed `long`, in the text and in `name` of `--json`. Two namespaces of one file can each hold an `Options`, and the ledger needs to tell them apart.
- `api-ledger.json` is written sorted by code unit, so it reads the same on every machine. A file whose names differ in case can be reordered the next time `--api <map> --ci` or `--accept-api` writes it. No entry is added or dropped by this.
