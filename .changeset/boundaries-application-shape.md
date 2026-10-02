---
"@demlik/code-graph": minor
---

`--boundaries` now judges the shape of a hexagonal feature's own files, beside the feature level
(B1-B10), the library level (B11-B14) and the deployable level (B17-B19). Two new kinds fail the
merge gate by name, each a `boundary-ledger.json` entry recorded with `--accept-crossings --reason`
and pruned as it is fixed, and four more `--boundary-rules` keys change what the existing rules
judge. Six new keys in all:

- `applicationShape`: the kinds that run, none by default.
- **B15 `index-not-exports-only`**: the entry file of a declared library (`src/index.ts`) or of a
  hexagonal feature (`src/<feature>/index.ts`) that holds anything but named re-exports. One entry
  per file; the specifier is the first offending form in source order (`export *`,
  `export default`, `local export`, `import`, `declaration` or `statement`) and the whole identity.
- **B16 `application-import-outside-allowlist`**: an `application/` import of anything but its own
  `ports.ts` and `application/`, another feature's `index.ts`, a `lib` folder, a library whose type
  `applicationMayImport` lists, or a package `pureDependencies` matches. Type-only imports are
  judged. An import another kind judges (B1, B6, B7, B14) is that kind's alone.
- `applicationMayImport` and `pureDependencies`: what B16 allows beyond the zones. They need B16
  listed, and there is no built-in type name.
- `testFiles`: globs of the files that are tests. A matched file sits in no zone, and one table (a
  row per kind) says which kinds still judge it: B1-B5, B12, B14 and B19 do; B6-B10, B13, B15, B16
  and B17 do not. A test beside a feature's `index.ts` is no B10 entry.
- `strictDriving`: scopes where B9 judges every catalog door in `index.ts`, `ports.ts` and
  `adapters/driving/`, declared or not.
- `readAllowance`: per scope, the driven files a driving adapter may import when it also imports a
  library of a `decidedBy` type when it runs. A listed file that writes through a data binding (the
  access `--data` computes) is never licensed, and the report names the write; the ledger entry
  keeps the shape and key of any B8.

**B15 and B16 are off until `applicationShape` lists them**, so a minor release never fails the gate
of a repo that did not ask for them. A repo that declares none of the six keys is unchanged: its
report, ledger entries and `--json` are exactly what they were, no wrangler config is read and no
further repo listing is made. A bad declaration (a kind outside the two, a key that needs B16 while
it is off, a type `libraryTypes` lacks, an invalid glob, a scope that is not hexagonal, a driven file
that is not under `adapters/driven/` or that the scope does not load) exits 2 and writes nothing, and
so does a wrangler config it cannot parse while `readAllowance` is declared. `--migrate-ceilings`
seeds the two kinds without counting them against a ceiling.

The `@demlik/code-graph/boundaries` subpath accepts the two new kinds in a ledger, so its published
schema widens. An older release refuses a ledger that holds them, so upgrade the tool before
committing one.
