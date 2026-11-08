# Boundary rules

[Documentation index](../README.md) · [Adoption steps](../how-to/enforce-boundaries.md)

```sh
pnpm exec code-graph . --boundaries --boundary-rules boundary-rules.json
```

The rules file declares features, library types, worker constraints, table ownership, which files are tests, which files are composition roots, and each technology's interpreter.
The report checks declared scopes under the analyzed directory. It uses
syntax and import resolution, without a full Graph or tsgo call analysis.
Undeclared rules do not create a verdict.

## Features and layout

```json
{
  "features": { "packages/app": ["billing", "orders"] },
  "lib": ["lib"],
  "testFiles": ["**/*.test.ts"]
}
```

Scope paths are repository-relative. Feature names are folders directly under
that scope's `src/`. Shared helper folders default to `lib`.

A scope uses one of two layouts, picked by the folders `features` lists. In
the per-feature layout each declared feature is its own hexagon:

```text
src/billing/
  index.ts             public entry
  ports.ts             port types
  application/         use cases
  adapters/driving/    HTTP, RPC, cron, and other callers
  adapters/driven/tables.ts  table definitions shared across features
  adapters/driven/     storage and other external operations
```

In the port layout the scope is one hexagon, with its zones straight under
`src/`. A scope declares it by listing all three folders as its features:

```json
{
  "features": { "services/mail": ["application", "driving-adapters", "driven-adapters"] }
}
```

```text
src/
  application/
    driving-ports/     port types the driving adapters call
    driven-ports/      port types the driven adapters implement
    (other files)      use cases
  driving-adapters/    HTTP, RPC, cron, and other callers
  driven-adapters/     storage and other external operations
```

A folder named `application`, `driving-adapters` or `driven-adapters` is a zone
of the scope's hexagon, and any other name is a feature as before. The port
layout needs all three folders, because a folder the scope does not list would
leave its files unjudged. Each of these exits 2 with one line naming the scope
and writes nothing:

- A scope that lists both kinds, port folders and feature folders.
- A scope that lists some of the three folders but not all of them. The message
  names the folders it leaves out, whether or not they exist.
- A scope that lists no port folder while its `src/` holds one. The message
  names the folders it leaves out.

The `for-<verb>-<noun>` folders below a port directory and the technology
folders below an adapter directory only group files; no rule reads them.

The zone paths of the two layouts, which every rule below reads:

| Zone | Per-feature layout | Port layout |
|---|---|---|
| Entry | `index.ts` | none |
| Ports | `ports.ts` | `application/driving-ports/`, `application/driven-ports/` |
| Application | `application/` | the rest of `application/` |
| Driving | `adapters/driving/` | `driving-adapters/` |
| Tables | `adapters/driven/tables.ts` | none |
| Driven | the rest of `adapters/driven/` | `driven-adapters/` |

| Rule | Kind | Violation |
|---|---|---|
| B1 | `cross-feature` | Another feature's internals imported instead of its `index.ts` or `adapters/driven/tables.ts` |
| B3 | `lib-imports-feature` | A shared helper folder imports a feature |
| B4 | `outside-imports-feature-internal` | A file outside features/helpers imports feature internals |

Features add these rules:

| Rule | Kind | Violation |
|---|---|---|
| B6 | `application-imports-adapter` | A use case imports its own feature's adapter |
| B7 | `impure` | An impure global is used where the place may not be impure |
| B8 | `driving-reaches-driven` | A driving adapter imports its own application or driven adapter |
| B10 | `unknown-zone` | A file or folder directly under the feature has no declared zone |

A wiring file outside features and helpers may import hexagonal adapters.
It still cannot import `application/` or `ports.ts`. Cross-feature imports
remain limited to `index.ts` or `adapters/driven/tables.ts`. Table definitions
otherwise follow every driven-zone rule. B16 still judges an application
file importing another feature's tables when enabled.

The port layout has no `index.ts` to go through, so a wiring file outside the
three folders, such as a worker's entry, may import any of its zones. It has no
other feature to import, so B1 does not arise, and every file under the three
folders is in a zone, so B10 does not arise. A report lists the three folders
as the scope's features. In `--json`, a violation's `feature` and `toFeature`
fields hold the scope path for a port-layout file, because the scope is the one
hexagon.

## Impure globals

An impure global is a recognized reference to the outside world. B7 `impure`
is the one rule for it, and the place comes from the entry's `from` path.
`index.ts`, `ports.ts`, `application/`, `adapters/driving/` and a library
whose type is `pure: true` may not use one. `adapters/driven/` may. In the
port layout, `application/` (its port directories included) and
`driving-adapters/` may not, and `driven-adapters/` may.

| Impure global | Recognized use |
|---|---|
| `process.<member>` | Static references, including literal member access and destructuring |
| `Date.now`, `performance.now` | Clock references |
| `new Date()` | Construction without an argument |
| `Math.random`, `crypto.randomUUID`, `crypto.getRandomValues` | Randomness references |
| `fetch`, `setTimeout`, `setInterval`, `globalThis` | Runtime references |
| `console` | Any `console.*` reference |
| `node:fs`, `node:child_process` | Runtime module imports, including subpaths and unprefixed names |

Bare `process` is not a use. Type positions and type-only module imports are
not uses. Locally bound names suppress global detection; aliases such as
`const p = process` are not followed. Detection of rebinding is per file, not
full lexical data flow.

Each crossing records one file/global pair; another read in the same
ledgered file is not a new entry. A pure library also reports each world
library its files import (`worldLibraries`) under the same kind.

## Library types

Library types describe which package types may import each other.

```json
{
  "libraryTypes": {
    "contract": { "imports": ["contract"], "pure": true },
    "adapter": {
      "imports": ["contract"],
      "pure": false,
      "importedFrom": ["driven"]
    }
  },
  "libraries": {
    "packages/orders-contract": "contract",
    "packages/storage-adapter": "adapter"
  },
  "libraryRoots": ["packages"],
  "worldLibraries": ["drizzle-orm", "@sentry/*"]
}
```

| Key | Meaning |
|---|---|
| `libraryTypes` | Allowed imported types, purity, and optional importer locations |
| `libraries` | Package directory to type; each directory must hold `package.json` and belong to the workspace when a workspace manifest exists |
| `libraryRoots` | Directories whose packages must all be declared |
| `worldLibraries` | Package globs forbidden in pure libraries, including subpaths |
| `allowImportNames` | Importer directory, to imported library directory, to the names the importer may take although its type does not list that library's type |

Types may import themselves only when listed. `importedFrom` accepts `driven`,
`configurator` (outside features), or `any`. Omitting it allows any location.
Library-to-library imports are configurator imports.

| Rule | Kind | Violation |
|---|---|---|
| B11 | `library-undeclared` | A workspace package under a library root has no declared type |
| B12 | `library-imports-up` | A library imports a type its own type does not allow, and takes a name its `allowImportNames` does not license |
| B14 | `adapter-library-imported-outside-driven` | An import violates the target type's `importedFrom` list |

Imports resolve by workspace package name, including subpaths. Relative
cross-package imports are handled by B19. B12 takes precedence over B14 for
the same disallowed library import. Type-only imports still count for B12
and world-library restrictions.

The report's library census lists types, undeclared packages, and unjudged
imports into undeclared workspace packages. Nested files belong to the
nearest declared library. Packages outside declared feature/library scopes
are not read for these file-level rules.

### Licensing some names of a library

B12 judges an import by the target library's type, so a type may import all of
a library or none of it. `allowImportNames` licenses some names of a library to
one importer whose type does not list the library's type. The key is ESLint's
`no-restricted-imports` option, kept as it spells it:

```json
{
  "allowImportNames": {
    "apps/mobile": { "packages/orders-contract": ["OrderDraft"] }
  }
}
```

Both directories are `libraries` keys, and each list is non-empty. A rules file
without the key runs as before.

- A file is no B12 when the allowance lists every name it imports from the
  library, summed over all its imports of it: the root specifier and its
  subpaths, type-only imports included. `import { A as B }` takes `A`,
  and `export { A } from` takes `A`.
- A default import, `import * as ns`, `export * from`, `import()`,
  `import x = require()` and `import "m"` take no readable name, so they are
  B12 whatever the list says.
- The entry is as without the allowance: one per importing file and library,
  so a file that takes a licensed and an unlicensed name is one entry. A
  client's own barrel that re-exports the library is one crossing at the
  barrel; the judgment does not follow it to the files behind.
- The licence waives B12 only. A library whose type lists `importedFrom` is
  still judged by B14.

Four declarations are refused with exit 2 and nothing written, each in one
line naming `allowImportNames` and the entry: an importer that is no declared
library, an imported library that is no declared library, an importer whose
type already lists the imported library's type (the allowance would enforce
nothing), and a name the importer never imports from that library. The last is
judged where the scope is loaded, so a refactor that stops importing a licensed
name turns the run red until the declaration is edited.

## Application shape and tests

`applicationShape` enables either or both of these kinds:

| Rule | Kind | Violation |
|---|---|---|
| B15 | `index-not-exports-only` | A library's `src/index.ts` or hexagonal feature's `index.ts` contains more than named re-exports |
| B16 | `application-import-outside-allowlist` | A use case imports outside its allowlist |

B15 allows named re-exports with `from`, including type-only and renamed
exports, and empty files. It rejects local declarations, default exports,
namespace/star exports, and other statements. Inner barrels are not checked.

B16 allows a feature's own `ports.ts` and `application/`, another feature's
`index.ts`, shared helpers, library types listed in `applicationMayImport`,
and packages matching `pureDependencies`. Type-only imports are checked.
The two allowlist keys require B16 to be enabled.

`testFiles` globs match a file's scope-relative path or its
repository-relative path. `src/**/*.test.ts` applies in every scope, and
`services/*/test-support/**` in worker scopes alone. Matched tests are
excluded from B6–B8, B10, B15–B17 and B22–B24; other import and ownership
rules still apply, and B20 judges test files only. Globs support `**`, `*`,
`?`, and `{a,b}`.

### Tests that load the whole app

In Cockburn's hexagon a test is a driving adapter on one application's ports,
and in Seemann's composition root the wiring happens in one place. A test that
opens the worker entry, or the module that assembles every feature, tests the
wiring and loads every feature to do it.

```json
{
  "testFiles": ["**/*.test.ts", "**/test-support/**"],
  "compositionRoots": ["src/index.ts", "src/schema.ts"]
}
```

`compositionRoots` lists globs of those files, matched as `testFiles` are.
Listing one turns the rule on; a rules file without the key runs no B20.

| Rule | Kind | Violation |
|---|---|---|
| B20 | `test-reaches-composition-root` | A test file opens, when it runs, a file from which a composition root is reached |

A file is in reach when it matches a `compositionRoots` glob or opens a file
in reach. A static import, an `export … from` and a dynamic `import()` open a
file. `import type`, `import { type X }`, `export { type X } from` and a
type-position `import()` open nothing, and an import that resolves to no file
the scope loads is no edge, so a root in another scope is out of reach.

A test gets one entry per file it opens that is in reach. `to` is the first
file on its way to a root, or the root itself when the test opens it directly.
A test that reaches a root by two routes has two entries, and fixing a route
removes exactly its entry. A helper that `testFiles` matches is a test too: it
is reported for its own first file, and by every test that opens it, so fixing
the helper clears them all. A file that matches a root glob is never reported
as a test.

Two declarations are refused with exit 2 and nothing written, each in one line
naming `compositionRoots`: a non-empty list with an empty or absent
`testFiles`, and an entry that is not a glob. A test that exists to test the
wiring is accepted by name with `--accept-crossings --reason`.

### Read allowances

`readAllowance` permits a driving adapter to import specific driven files:

```json
{
  "readAllowance": {
    "packages/app": {
      "driven": ["src/orders/adapters/driven/order-reads.ts"],
      "decidedBy": ["contract"]
    }
  }
}
```

With `decidedBy`, the driving file must also make a runtime import from a
library of a listed type. Without it, any driving file may use the listed
reads. Empty lists are invalid; the scope must have hexagonal features. Each
`driven` file sits in a driven zone: `adapters/driven/`, or `driven-adapters/`
in the port layout.

A recognized storage write in a listed file always blocks the allowance.
The B8 report names its first write site. ORM writes and `unknown` access
remain outside this check. An unparsed worker config refuses a run that
declares read allowances, because write detection would be incomplete.

## Interpreters

A technology gets one interpreter, the one adapter that reads every row of one
kind, and a feature keeps no ports or adapters for it. `interpreters` declares
that per scope, and naming a scope is what turns B24 and B25 on:

```json
{
  "interpreters": {
    "apps/cli": {
      "cli": {
        "root": "src/interpreters/cli",
        "modules": ["@b8e/kontrol-operations", "graphql", "src/util/graphql"]
      }
    }
  }
}
```

| Field | Meaning |
|---|---|
| `<scope>` | A scope that declares `features` |
| `<technology>` | A name; several technologies may share a scope |
| `root` | The scope-relative folder the interpreter sits in |
| `modules` | What the technology covers: package globs, and scope-relative paths that start with `src/` |

A package entry is a glob spelled as `worldLibraries` spells it: it matches the
package and its subpaths, with `*` inside one segment. It is matched on the
specifier as written. A `src/` entry names a file with its extension dropped, or
a folder, and is matched on the file an import resolves to, however it was
spelled. A module listed under two technologies of one scope is two entries on a
file that imports it. `{}` is the same as leaving the key out, and there is no
list of kinds.

| Rule | Kind | Violation |
|---|---|---|
| B24 | `technology-outside-interpreter` | A feature's `ports.ts` or adapter file imports a module its scope's technology covers |
| B25 | `interpreter-imports-feature` | A file under an interpreter root imports a file of a feature |

B24 judges the ports (`ports.ts`, or the port folders under `application/` in the
port layout) and every adapter zone: `adapters/driving/`, `adapters/driven/` with
`tables.ts`, any other entry under `adapters/`, and the port layout's
`driving-adapters/` and `driven-adapters/`. It does not judge `application/` or
`index.ts`, and a file that a nested library owns belongs to that library's
scope. Static, type-only, `export … from`, dynamic and type-position `import()`
and `import x = require()` all count. The entry is one per file per technology:
`from` the file, `to` null, `specifier` the technology's name, and `typeOnly`
true only when every matching import is type-only. A technology no scope lists is
never judged, so a local effect such as git, Playwright or the keychain stays
in its feature. A file `testFiles` names is not judged, which is how Binclusive's
F17 reads (Binclusive/monorepo#8540).

B25 judges any import of a file under a root that lands in a file of any feature
of its scope, `index.ts` included. It is one entry per file and target: `to` the
feature file, `specifier` the first one written, `typeOnly` true only when every
import of the target is. It is the only verdict for these edges, so B4 does not
also fire, and it judges test files, as B4 does. Importing a `lib` file, a
sibling in the root or the root's own modules is clean. No rule judges a feature
importing an interpreter file.

A file under a root is an adapter wherever another rule reads the zone table:

- It may be impure, so `node:fs` and `fetch` there are not B7, where the same use
  in a feature's `ports.ts` still is.
- It may use a worker binding, so B17 is clean there, and `bindingOwners` accepts
  a file under a root as an owner.
- It satisfies a library whose type lists `importedFrom: ["driven"]`. A library
  that lists only `configurator` imported from it is B14.

A file under an interpreter root is a file in no feature for B22 and B23, so its
table declaration is B22, its write of a feature's table is B23, and its import
of that feature's `tables.ts` is also B25. A root that keeps a table of its own
accepts the B22 by name (`--accept-crossings --reason`).

Each of these is refused with exit 2 and nothing written, in one line naming
`interpreters` and the entry:

- A scope that declares no `features`.
- A technology with an empty `modules`.
- A package entry that is not a glob.
- A `root` that is, holds or sits inside a declared feature folder or a `lib`
  folder.
- Two roots of one scope where one is, holds or sits inside the other.
- A `root` that holds no source file the scope loads, and a `src/` module that
  names no file or folder the scope loads. Both are judged where the scope is
  loaded, so a stale name cannot quietly turn the check off.

Resolving a `src/` module needs the scope's dependencies installed, because a
path alias or a tsconfig that extends a package resolves nothing without them.

## Workers and workspace imports

`acrossDeployables` enables the listed kinds; none are enabled by default.

| Rule | Kind | Violation |
|---|---|---|
| B17 | `binding-outside-driven-adapter` | A declared worker binding is referenced outside a driven adapter and its worker's `main` |
| B18 | `worker-call-cycle` | Service-binding declarations form a cycle between workers |
| B19 | `relative-import-crosses-workspace` | A relative import points into another package directory |
| B21 | `package-import-crosses-deployable` | A package import names another workspace with a worker config at its root |

`bindingOwners` can further limit a binding to exact scope-relative driven
files, under `adapters/driven/` or, in the port layout, `driven-adapters/`. It
requires B17 and a scope declaring features.

B17 reads the nearest top-level Wrangler config and recognizes `env`, `.env`
receivers, and one alias level. Arbitrary receiver names, deeper aliases,
and named config environments are not followed. Its census includes clean
and violating binding sites.

A worker's `main`, the file its Wrangler config names, is clean for that
worker's own bindings: it is where they are wired to the driven adapters,
whether or not it sits in a feature and whether or not `bindingOwners` names
the binding. Every other file still needs a driven adapter. A config
with no `main`, or a `main` that names no file the scope loads, cleans
nothing. A file under a nested worker's directory is judged against that
worker, so it is clean only when that worker's config names it.

B18 runs only at the repository root and uses service declarations, including
unused bindings. Self-bindings are ignored. Durable Object and Workflow
bindings do not contribute B18 edges. Overlapping cycles form one component;
unknown target workers are counted separately.

Package roots are directories holding a visible `package.json` that match the
repo's `pnpm-workspace.yaml` `packages`, or, without that file, the root
`package.json`'s `workspaces` (array or Yarn `{ "packages": [...] }` form).
Workspace patterns are matched as pnpm matches them; the repo root package
and the analyzed root are always included. An empty pnpm manifest or one without
`packages` includes only the root package. A fixture manifest outside those
patterns is neither a B11 library nor a B19 package boundary. Without a workspace
manifest, every visible `package.json` directory remains a package root.
Malformed workspace declarations fail with the manifest path.

B19 compares the nearest package roots of importer and target, even
when the target path does not exist. Bare specifiers and tsconfig aliases
are outside B19. Type-only relative imports still count.

B21 matches a bare specifier's package name, scoped or unscoped, with any
subpath stripped, against workspace package names. A target is a deployable
only when its package root holds a worker config in the existing manifest
catalog. Libraries, non-worker apps and imports of the workspace's own
package name are clean. The importing workspace need not itself be a worker.
Static imports, re-exports, dynamic imports and type-only imports count,
including in files matched by `testFiles`.

Like B19, B21 writes one entry per importer and target workspace: `from` the
importer, `to` the workspace directory, `specifier` the first spelling in
source order and `typeOnly` true only when all imports of that workspace are
type-only. Workspace roots and the package name map are read once per run
when B21 is listed; roots are shared with B19. An unreadable worker config
exits 2 and writes nothing when B17, B18 or B21 is listed.

To require worker-to-worker access through RPC bindings and shared contracts,
add `"package-import-crosses-deployable"` to `acrossDeployables`. No rule runs
until listed, so adding this kind in a release does not enable it for a repo.

## Tables

`tableOwnership` enables either or both of these kinds. None run until listed,
so adding a kind in a release does not enable it for a repo.

| Rule | Kind | Violation |
|---|---|---|
| B22 | `table-declared-outside-tables` | A drizzle table constructor is called outside a feature's `adapters/driven/tables.ts` |
| B23 | `table-written-outside-owner` | A table is passed to `insert`, `update` or `delete` by a file outside the feature that declares it |

```json
{ "tableOwnership": ["table-declared-outside-tables", "table-written-outside-owner"] }
```

A table's owner is the feature whose `adapters/driven/tables.ts` declares it.
Both kinds judge a scope laid out per feature and no other: the port layout has
no `tables` zone, and a scope with no `features` is a library. An unknown kind
name exits 2, and so does a kind listed while no scope in the file uses the
per-feature layout, in one line naming `tableOwnership`; nothing is written.

B22 reports a call of `pgTable`, `sqliteTable` or `mysqlTable` bound by an
import from `drizzle-orm/pg-core`, `drizzle-orm/sqlite-core` or
`drizzle-orm/mysql-core`. An alias (`pgTable as table`) and a namespace member
(`pg.pgTable(...)`) are followed. It writes one entry per file per constructor:
`to` is `null` and `specifier` is the constructor's imported name. A function
of the same name that the file defines or imports from elsewhere, and a mention
in a string or comment, report nothing.

B23 reports a call whose callee is a static member named `insert`, `update` or
`delete` on any receiver, an optional call included, and whose first argument
names a table: a binding the file imports at run time, or a member `ns.t` of a
namespace import. The name is followed through every re-export to the module
that defines it, by ECMAScript's own algorithm,
[ResolveExport](https://tc39.es/ecma262/#sec-resolveexport), and the table is
one when that module is a feature's `adapters/driven/tables.ts`. The call is
reported when the file is not in the owning feature: another feature, a `lib`
folder, or a file in no feature. The owner is the feature of the tables file
the name comes to. It writes one entry per file per table: `to` is `null` and
`specifier` is the name the tables file exports the table under, so an alias,
or a rename on the way through a barrel, changes no identity. The report names
the owner: `owner` on the `--json` row, and `[owner: <feature>]` on the plain
row and the `--ci` failure line. The ledger entry does not keep it. Reads,
joins, foreign keys, a type-only import and a feature writing its own table are
clean.

A file under an interpreter root is a file in no feature for B22 and B23, so its
table declaration is B22, its write of a feature's table is B23, and its import
of that feature's `tables.ts` is also B25. A root that keeps a table of its own
accepts the B22 by name (`--accept-crossings --reason`).

Neither kind judges a file `testFiles` matches. Both read syntax only, with no
type checker and no data flow. What they follow, what they count and what they
leave alone:

| Case | Outcome | Why |
|---|---|---|
| `export { t } from "./m"`, `export { t as u } from "./m"` | followed | an indirect export: the table keeps the name its tables file exports it under |
| `export * from "./m"` | followed | a star export supplies every name of the module but `default` |
| `export * as ns from "./m"`, and `import * as ns from "./m"; export { ns }`, written as `ns.t` or `b.ns.t` | followed | a namespace export, entered one name at a time |
| `import { t } from "./m"; export { t }`, with or without `as` | followed | ECMA-262 files an imported, then exported, binding as an indirect export |
| A feature's own `index.ts`, a schema barrel such as `drizzle/schema.ts`, a chain of them of any length, a circle of them | followed | the walk keeps the (module, name) pairs it has visited, as ResolveExport does, so a circle ends and a name no module defines comes to nothing |
| A write whose table the run cannot trace: a variable, a call result, a parameter that shadows the import, a spread, the result of `require()` or `await import()`; or an import of a name that a file outside the tables files holds, or a member of one (`o` of `export const o = orders`, `schema.t` of `export const schema = { t }`, a table a `lib` or loose file declares) | counted as `untraced-write` | no syntax says which table it is, and the run follows a name, not a value (no data flow). A table a `lib` or loose file declares has no feature to own it, and B22 reports where it is declared. `Map#delete(key)` with a variable key is counted too, since syntax cannot tell it from a write; a literal key is not |
| A write whose table is imported from a module the run did not load: a package, a path no loaded file answers | counted as `unloaded-module` | the module may define a table a feature owns |
| A table written through `export default`, `import t from`, or `export { default as t }` | counted as `default-export` | no star supplies `default`, and a default carries no name to be the table's identity |
| A name that two `export *` supply with different bindings | counted as `ambiguous-star` | ResolveExport answers ambiguous: the module has no such export |
| A name from a module that says `export = x` | counted as `export-equals` | the export is one object whose members the syntax does not name |
| Raw SQL that begins as a write (`INSERT INTO`, `REPLACE INTO`, `UPDATE … SET`, `DELETE FROM`) in a string or a template | counted as `raw-sql` | a table named in a string is no import |
| `export type { t } from`, `export { type t } from`, `export type * from`, `import type` | neither | erased at run time: it writes nothing |
| A table passed to a helper (`insertInto(db, t)`) or to a computed member (`db["insert"](t)`) | neither | `insertInto` is any function and `["insert"]` any key; only a static member named `insert`, `update` or `delete` is a write, so the file lists as a read |
| A namespace taken whole (`...ns`, `use(ns)`), a member name (`row.orders`), an object key, an export list, a table named in raw SQL that only reads | neither | none of these is a table named at run time, and a read in raw SQL is no write to count |
| A `pgSchema(...).table(...)` declaration, `pgView`, `pgEnum`, sequences | neither | B22 reads the three constructors by name; the schema object a `.table(…)` call is made on is not resolved |

A write the run counts is not clean. When a rules file lists either kind, the
report, plain or `--json`, ends with a census beside the violations, as the
library and deployable censuses do (`--ci` and `--accept-crossings` print none):
one line of counts and one row per file and kind.

```text
tables: 2 not followed (untraced-write 1, unloaded-module 0, default-export 0, ambiguous-star 0, export-equals 0, raw-sql 1)
  services/api/src/billing/adapters/driven/rebound.ts  untraced-write  write whose table the run cannot trace
  services/api/src/billing/adapters/driven/seed.ts  raw-sql  raw SQL that writes
```

Every kind is printed, with an explicit `0`. `--json` carries the same under
`tables`: `{ "notFollowed": { "<kind>": <count> }, "rows": [{ "file", "kind" }] }`.
A rules file that lists neither kind prints no census, and every byte of its
output is the output it had before. `--owners` lists the same rows under
`Not followed`. The census never fails a run: it makes a blind spot visible
rather than a violation.

A write that has to stay is accepted by name with
`--accept-crossings --reason "<why>"`.

The reads and foreign keys these kinds leave clean are listed by
`code-graph <path> --owners --boundary-rules <file>`, beside the writes: see
[Owners](cli.md#owners).

## Ledger and gate behavior

`boundary-ledger.json` stores accepted crossings, one entry per identity:

```json
{
  "entries": [{
    "scope": "packages/app",
    "kind": "cross-feature",
    "from": "packages/app/src/billing/application/charge.ts",
    "to": "packages/app/src/orders/application/private.ts",
    "specifier": "../../orders/application/private.js",
    "reason": "Expose an orders reader, then remove this internal import."
  }]
}
```

Identity is `(scope, kind, from, to ?? specifier)`. `specifier` is display-only
for file targets. Reasons are optional in existing entries; accepting new
entries requires a reason.

Targets are files for ordinary imports, package directories for library and
workspace crossings, or `null` for impure globals, bare imports, tables, a technology
(B24, whose identity is the file and the technology's name), and structural findings.
The schema validates which kinds may use `null`.

| Mode | Effect |
|---|---|
| Report | Exit 0 after measuring valid declarations |
| `--ci` | Exit 1 on unrecorded crossings; prune resolved entries from the ledger |
| `--accept-crossings --reason <text>` | Add unrecorded crossings with the supplied reason |
| `--migrate-ceilings` | Seed today's ledger and delete the legacy count file |

Scopes outside the analyzed directory remain untouched. Invalid declarations
exit 2 before writing. Migration refuses increases above legacy import
ceilings; impure, structural, library, shape, deployable, test-reach, table, and
interpreter entries are seeded without counting toward those import ceilings.

File movers can preserve ledger identities with
[`@demlik/code-graph/boundaries`](./library.md#boundaries).

Source: [base rules](../../src/boundaries/rules.ts),
[library schema](../../src/boundaries/libraries/schema.ts),
[shape schema](../../src/boundaries/shape/schema.ts),
[deployable schema](../../src/boundaries/deployables/schema.ts),
[table schema](../../src/boundaries/tables/schema.ts),
[interpreter schema](../../src/boundaries/interpreters/schema.ts),
[ledger](../../src/boundaries/ledger.ts), [gate](../../src/boundaries/gate.ts).
