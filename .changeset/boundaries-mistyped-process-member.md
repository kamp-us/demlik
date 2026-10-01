---
"@demlik/code-graph": patch
---

A `doors` declaration of a mistyped `process` member is refused again. Since the `process` rows
became one family, `process.envv` was accepted and policed nothing; it now exits 2 naming the
door, the Node that judged it and the nearest member that Node has (`process.env`), and writes
nothing. The members come from the running Node's own `process`, read by name at the config edge,
so every real member stays declarable (`process.on`, `process.hrtime.bigint`, `process.stdin.isTTY`)
and no list is kept in the catalog. The check ends at the member: what lies below it is the
runtime's. Door detection, ledger entries and reports never consult it, so a repo gives the same
ledger and report on every supported Node, and a member only some Nodes have
(`process.loadEnvFile`) is refused with the Node named where the running one lacks it.
