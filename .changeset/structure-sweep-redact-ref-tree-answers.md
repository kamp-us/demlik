---
"@demlik/structure-sweep": patch
---

`sweep --redact` numbers an alias by a file only when that file is in the tree
`--ref` names (#471).

- **Answers are checked against `--ref`.** The resolver still reads the
  checkout on disk, but an in-repo answer counts only when it is a file at
  `--ref`. An ignored file a `paths` fallback reaches first, an untracked file,
  a file inside a submodule (at its recorded commit or drifted), and build
  output such as a workspace package's ignored `dist/*.d.ts` now read as
  unresolved, keyed on the specifier text, so none of them gets an id.
- **Off-ref configuration refuses.** A tsconfig-chain member or a
  `package.json` outside `node_modules` that is on disk but not at `--ref`,
  ignored or untracked, stops the run and is named as `ignored <path>` or
  `untracked <path>`.
- **An untracked source file no longer refuses.** Any other untracked file
  cannot move an answer onto a file at `--ref`, so the run goes ahead. Tracked
  additions, deletions, retypes, retargeted symlinks and edits to a
  `package.json` or tsconfig-chain member still refuse, as before.
