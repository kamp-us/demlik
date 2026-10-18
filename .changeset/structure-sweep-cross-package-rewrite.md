---
"@demlik/structure-sweep": minor
---

`move apply` now carries a row that moves a file from one pnpm workspace package into another.
Before, such a row applied with relative imports into the other package's `src/`, which typechecked
while the package line was fake. Now apply loads every workspace package that imports a moved file,
and writes each import that crosses a package line as `<package name>/<subpath>`, the subpath read
off the target package's `exports` (wildcard entries included). Imports that stay inside one package
stay relative. A row whose destination no `exports` entry reaches, or a moved file's import of a
file its old package does not export, is refused before any commit, naming the row and the
package. A repository with no `pnpm-workspace.yaml` applies exactly as before.
