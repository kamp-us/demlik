---
"@demlik/structure-sweep": minor
---

`move apply` now carries a row that moves a file from one pnpm workspace package into another.
Before, such a row applied with relative imports into the other package's `src/`, which typechecked
while the package line was fake. Now apply loads every workspace package with a TypeScript or
JavaScript file that imports a moved file (tracked `.js`, `.jsx`, `.mjs` and `.cjs` files, with or
without `allowJs`), and writes each import that crosses a package line as
`<package name>/<subpath>`, the subpath read off the target package's `exports` (wildcard entries
included). Imports that stay inside one package stay relative, spelled as the importer's
`tsconfig.json` asks (`./x.js` under NodeNext), with an `.mjs` or `.cjs` importer always keeping an
extension. `.mts` and `.cts` files and their `.mjs` / `.cjs` importers, `import x = require()`
included, are carried the same way. Refused before any commit, naming the row: a destination no
`exports` entry reaches, a `null` entry included; a moved file's import of a file its old package
does not export, a non-TypeScript file included; a relative import in a moved file that names no
file; a package-name import into a package a row leaves that apply cannot follow to a file; and an
alias from tsconfig `paths`, tsconfig `baseUrl` or `package.json` `imports` in a moved file or
naming one. A package with no `exports` is read as Node reads it, by `main` and by the path under
the package. Files of other kinds, such as `.vue` or `.mdx`, are not read. A repository with no
`pnpm-workspace.yaml` applies exactly as before.

Every move now also reads `import x = require()`, `require()` and `declare module` as imports. A move
inside one package keeps a moved file's import of a `.json` or other non-TypeScript file
naming that file, where before it lost the extension or stayed as written.

Apply now reads the `pnpm-workspace.yaml` globs with `tinyglobby`, the library pnpm's own package
search uses, in place of its own matcher. So brace and character-class globs select what they select
for pnpm, rather than silently matching nothing. `**` follows pnpm too: `packages/**` also takes
`packages` itself when it holds a `package.json`, and a dot directory is no longer searched. Like
`pnpm -r`, it reads a member under `test` or `tests`, where the old matcher skipped them. A row path
is normalized when it is read, so `./packages/a/x.ts` and `packages/a/x.ts` apply alike.
