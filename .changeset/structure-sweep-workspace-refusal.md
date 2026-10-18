---
"@demlik/structure-sweep": patch
---

`move apply` now refuses a manifest row that moves a file from one pnpm workspace package into
another, before it commits anything. It names every such row and both packages. Before, such a row
applied with relative imports into the other package's `src/`, which typechecked while the package
line was fake. A repository with no `pnpm-workspace.yaml` applies exactly as before.
