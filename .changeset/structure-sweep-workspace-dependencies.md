---
"@demlik/structure-sweep": minor
---

`move apply` now finishes a move across pnpm workspace packages so the result installs. Each
package whose files now import another workspace package gains `"<name>": "workspace:*"` in its
`package.json` `dependencies` (one it already declares is left alone), and apply runs
`pnpm install --lockfile-only` so the updated `pnpm-lock.yaml` lands in the same rewrite commit.
The report lists the additions under `dependenciesAdded`. Refused before the rename commit, with
`HEAD` and the tree unchanged: a move whose added dependency would make workspace packages depend on
each other (the cycle is named package by package), and a move that must add a dependency when no
`pnpm` is on `PATH`. A move that adds no dependency never runs pnpm.
