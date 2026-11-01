---
"@demlik/code-graph": patch
---

`--api` now sees the same modules the compile saw, so it no longer drops names re-exported from a dependency installed at the repo root, which is where npm and yarn workspaces put them. The read gives each source file its emitted declarations in place, so `export *` and `export { x } from` over a hoisted package, `#` imports, `paths` and a `declare module` in a source `.d.ts` all resolve as they did in the compile, and the nearest install wins. `--api-base`, `--api-policy` and the API ledger read the same way. A specifier the read still cannot resolve now prints a warning naming it and counts as a diagnostic, so the ledger prunes nothing on that run instead of deleting a recorded name and its reason. A name reached through `paths` now shows its emitted text instead of its source text. Nothing is linked or written to the checkout.
