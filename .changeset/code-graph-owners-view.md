---
"@demlik/code-graph": minor
---

`code-graph <path> --owners --boundary-rules <file>` prints who owns what in the scopes the rules file declares under the path, and who reaches in. Per feature: the tables its `adapters/driven/tables.ts` declares, every other file that reaches one of them labelled `write` (passed to `insert`, `update` or `delete`, B23's own fact), `foreign-key` (the file is itself a feature's tables file) or `read` (named at run time and not written), with the file and where it sits, and the ports it offers and needs as `--hexagon` prints them. Per worker: each binding's kind, the files `bindingOwners` narrows it to, and every site. Per technology a scope's `interpreters` declares: the interpreter root and the files that import from it. `--json` returns the same as data.

It is a view and never a gate: it adds no rules-file key, reads and writes no ledger, exits 0 whatever the scopes hold, and exits 2 only where `--boundaries` would refuse to start. It exits 2 beside any gate flag, `--hexagon` or `--env-keys`. It reads syntax only, so a namespace taken whole and a table named in raw SQL are not matched. `--boundaries` prints the same bytes as before.
