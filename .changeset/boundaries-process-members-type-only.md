---
"@demlik/code-graph": minor
---

`--boundaries` now holds every `process` member to the purity of `rules/`, and stops counting a
type-only import as a door use.

- **Every `process.<member>` is a B2 door in `rules/`.** The catalog's seven `process` rows become
  one family row, and each member is its own door. A rules file that calls `process.hrtime()`, reads
  `process.platform` or `process.versions`, or calls `process.on(...)` passed as pure and is now an
  `impure-rules` entry named for the member (`process.hrtime`), one per file per member:
  `process.hrtime()` beside `process.hrtime.bigint()` is one entry. The seven names the catalog
  listed before (`env`, `argv`, `stdin`, `stdout`, `stderr`, `exit`, `cwd`) keep their spelling, so a
  `boundary-ledger.json` written by the previous release gates unchanged for them. A repo's first
  `--ci` after upgrading lists the current uses of every member beyond those seven until
  `--accept-crossings --reason "<why>"` records them. A `doors` declaration may now name any member
  (`process.platform`, `process.hrtime.bigint`); the bare `process` is the whole family and exits 2,
  and a misspelled member is a valid door nobody uses.
- **A type-only import opens no door.** `import { type Stats } from "node:fs"`,
  `export { type Stats } from`, `import type x = require("node:fs")`, `import("node:fs").Stats` and
  `typeof import("node:fs")` in a type no longer count as B5 `door-outside-owner` uses of `node:fs`
  or `node:child_process`, so entries already ledgered for them are pruned on the next `--ci`. A
  file that also imports the module at run time is still one use, and inside `rules/` a type-only
  import is still the B2 import entry it was.

The graph JSON, `ModuleNode` and `ImportEdge.typeOnly` are unchanged.
