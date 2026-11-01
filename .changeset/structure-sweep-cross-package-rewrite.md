---
"@demlik/structure-sweep": minor
---

`move apply` now carries a row that moves a file from one pnpm workspace package into another.
Before, such a row applied with relative imports into the other package's `src/`, which typechecked
while the package line was fake. Now apply loads every workspace package that imports a moved file,
and writes each import that crosses a package line as `<package name>/<subpath>`, the subpath read
off the target package's `exports` (wildcard entries included). Imports that stay inside one package
stay relative, spelled as the importer's `tsconfig.json` asks (`./x.js` under NodeNext). `.mts` and
`.cts` files and their `.mjs` / `.cjs` importers are carried the same way. A row whose destination no
`exports` entry reaches, a `null` entry included, or a moved file's import of a file its old package
does not export, is refused before any commit, naming the row and the package. A repository with no
`pnpm-workspace.yaml` applies exactly as before.

Apply now reads the `pnpm-workspace.yaml` globs with `tinyglobby`, the library pnpm's own package
search uses, in place of its own matcher. So brace and character-class globs select what they select
for pnpm, rather than silently matching nothing. `**` follows pnpm too: `packages/**` also takes
`packages` itself when it holds a `package.json`, and a dot directory is no longer searched. A row
path is normalized when it is read, so `./packages/a/x.ts` and `packages/a/x.ts` apply alike.
