---
"@demlik/code-graph": minor
---

The repo root no longer needs a `pnpm-workspace.yaml`. `findRepoRoot` and every mode built on it now answer, in order: the nearest ancestor with `pnpm-workspace.yaml`; the nearest ancestor whose `package.json` has a `workspaces` key; the nearest ancestor with a `.git` directory or file; the analyzed folder. So in an npm, yarn, bun or single-package repo, `code-graph packages/core` and `code-graph .` read one ledger at one root. A repo with `pnpm-workspace.yaml` gets the same root as before, and a `package.json` that is not valid JSON just does not count.

**A ledger recorded in an analyzed folder must be moved to the root.** In a repo with no `pnpm-workspace.yaml`, a run on `packages/core` used to read and write `packages/core/unreachable-ledger.json`. It now reads the root's file and will not find the old one. Move each `boundary-ledger.json`, `unreachable-ledger.json`, `smell-ledger.json`, `api-ledger.json`, `comment-ceilings.json` and `collapse-ceilings.json` to the root, merging entries where two folders each hold one, and change each entry's `scope` or `target` to be relative to the root. Nothing migrates them for you.

The rest of what reads the root moves with it in those repos: `.changeset/`, the paths in `--layers`, the env-key and data reports, and `--deep`, which now looks for its tsconfig at or above the new root and exits 2 when none is there.

**`--unreachable --ci` reads an entry from any scope.** An entry now covers a finding when it names the same symbol from another scope, at any kind, or the same kind and symbol from the run's own scope. `packages/core` with `src/x.ts:f` and `.` with `packages/core/src/x.ts:f` are one symbol, and the kind may differ because a run on a package cannot see another package's callers: an export only another package's test calls is `dead` there and `only-called-from-tests` at the root. This also applies in a pnpm workspace: a root run that used to fail on a finding a package run had accepted now passes. Within one scope a changed kind is still a new finding. A run still prunes only its own scope's entries, and the ledger's format does not change.
