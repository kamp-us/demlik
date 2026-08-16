---
"@demlik/tea": patch
---

Republish from the package's new home, `kamp-us/demlik`.

`@demlik/tea` was extracted out of a private monorepo into its own public repo.
No runtime behavior changes. What does change in the published artifact:

- `repository` now points at `kamp-us/demlik`, so the npm page links to the code.
- `bugs` gains an issue-tracker URL.
- Doc comments that referenced private consumer codebases, incident numbers and
  issue numbers are genericized. Those comments ship in the `.d.ts` files and the
  sourcemaps, so this is a visible change to the tarball even though no code moved.
