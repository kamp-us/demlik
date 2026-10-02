---
"@demlik/code-graph": minor
---

`--boundaries` now judges the package level beside the feature level. A repo whose packages are
libraries of declared types (contract, kernel, util, adapter, ui) declares them in the
`--boundary-rules` file with four new keys, and four new kinds fail the merge gate by name, each a
`boundary-ledger.json` entry recorded with `--accept-crossings --reason` and pruned as it is fixed:

- `libraryTypes`: each type, the types it may import (a table, not `--layers`' total order), whether
  it is `pure`, and optionally where a library of it may be imported from (`importedFrom`:
  `driven`, `configurator` or `any`). The type names are the rules file's, not the tool's.
- `libraries`: a package's directory, to its type. Each is a scope named by its directory.
- `libraryRoots`: directories whose packages must each be declared.
- `worldLibraries`: package globs a pure library may not import (`@sentry/*` matches `@sentry/node`
  and its subpaths).

- **B11 `library-undeclared`**: a package under a library root that `libraries` does not name.
- **B12 `library-imports-up`**: an import to a library whose type the importer's type does not
  list, resolved by package name, subpaths included. Type-only imports are judged.
- **B13 `impure-library`**: in a pure library, any world door used by name or opened as a module,
  and any import of a world library. A call on an injected object is not seen.
- **B14 `adapter-library-imported-outside-driven`**: an import of a library from outside the zones
  its type's `importedFrom` names.

`--boundaries` ends its report with a census of the libraries, the undeclared packages and the
imports left unjudged. `--migrate-ceilings` seeds the four kinds without counting them against a
ceiling. A bad declaration, and the key `pureDependencies`, exit 2 and write nothing.

A rules file that declares none of the four keys is unchanged: its report, its ledger entries and a
ledger written before this release read and gate exactly as they did. An older release refuses a
ledger that holds the new kinds, so upgrade the tool before committing one.
