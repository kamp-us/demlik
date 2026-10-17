---
"@demlik/code-graph": minor
---

`code-graph --boundaries` reports a test that loads the whole app. The rules file has a new key, `compositionRoots`: globs of the files that assemble the app (a worker entry, the module that builds every feature's schema), matched against a file's scope-relative or repo-relative path as `testFiles` are. Listing one turns on B20 `test-reaches-composition-root`, and a rules file without the key runs no B20.

- A file `testFiles` matches that opens a file in reach when it runs is one entry per such file: `from` the test, `to` the first file on its way to a root, or the root when it opens one directly. A file is in reach when it matches a root glob or opens a file in reach, through a static import, an `export … from` or a dynamic `import()`. `import type`, `import { type X }`, `export { type X } from`, a type-position `import()` and an import that resolves to no file the scope loads open nothing.
- The entry is keyed by `(scope, kind, from, to)`, so a repo adopts B20 at today's count with `--accept-crossings --reason` and the count only goes down: fixing a shared helper prunes every entry behind it. A deliberate test of the wiring stays in the ledger by name and with a reason.
- A non-empty `compositionRoots` with an empty or absent `testFiles`, and a `compositionRoots` entry that is no glob, exit 2 and write nothing.
- `BoundaryRules` gains `compositionRoots`, and `BOUNDARY_KINDS` gains `test-reaches-composition-root`. `--migrate-ceilings` seeds a B20 crossing without counting it against a legacy ceiling.
