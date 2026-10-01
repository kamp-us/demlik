---
"@demlik/code-graph": minor
---

`--boundaries` now sees the outside world, not only imports. One catalog names the world doors a
file can open (`process.env`, `process.argv`, `process.stdin`/`stdout`/`stderr`/`exit`/`cwd`,
`Date.now`, `new Date()` with no argument, `Math.random`, `crypto.randomUUID`,
`crypto.getRandomValues`, `performance.now`, `fetch`, `setTimeout`, `setInterval`, `globalThis`,
`console`, and the modules `node:fs` and `node:child_process`), and two checks read it:

- **B5 `door-outside-owner`**: a `doors` key in the `--boundary-rules` file,
  `{ "<scope>": { "<door>": ["<scope-relative owner file>", …] } }`, declares who may open a door.
  A use of a declared door in any other file is a ledger entry. A declaration may be narrower than a
  catalog row (`process.stdin.isTTY` under `process.stdin`). A bad declaration (a door outside the
  catalog, a scope that declares no `features`, an owner that names no loaded file, an owner under
  `src/<feature>/rules/`) exits 2 and writes nothing.
- **B2 `impure-rules` on globals**: inside `src/<feature>/rules/**` every use of any catalog door,
  declared or not, is now a B2 entry. Before, a rules file that read `process.env`, called `fetch`
  or asked the clock for the time passed as pure because B2 read import edges only. A repo's first
  `--ci` after upgrading lists its current uses until `--accept-crossings --reason "<why>"` records
  them.

An entry is one file per door, so the ledger names which files still depend on a door, not how
often. `boundary-ledger.json` gains the kind `door-outside-owner` (its `to` is `null`, as for a B2
bare import) and an optional `"global": true` on an `impure-rules` entry for a global read by name,
which keeps a global `fetch` and a bare `import "fetch"` from one file two entries. A ledger written
before this change reads and gates exactly as it did. `--boundaries --migrate-ceilings` compares
only import crossings against the recorded count and seeds the door and global entries into the
ledger with the same reason, so a repo that predates the doors still migrates.
