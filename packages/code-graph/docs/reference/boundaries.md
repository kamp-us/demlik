# Boundary rules

[Documentation index](../README.md) · [Adoption steps](../how-to/enforce-boundaries.md)

```sh
pnpm exec code-graph . --boundaries --boundary-rules boundary-rules.json
```

The rules file declares features, library types, worker constraints, which files are tests, and which files are composition roots.
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
| Driven | `adapters/driven/` | `driven-adapters/` |

| Rule | Kind | Violation |
|---|---|---|
| B1 | `cross-feature` | Another feature's internals imported instead of its `index.ts` |
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
remain limited to `index.ts`.

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
| `libraries` | Package directory to type; each directory must hold `package.json` |
| `libraryRoots` | Directories whose packages must all be declared |
| `worldLibraries` | Package globs forbidden in pure libraries, including subpaths |
| `allowImportNames` | Importer directory, to imported library directory, to the names the importer may take although its type does not list that library's type |

Types may import themselves only when listed. `importedFrom` accepts `driven`,
`configurator` (outside features), or `any`. Omitting it allows any location.
Library-to-library imports are configurator imports.

| Rule | Kind | Violation |
|---|---|---|
| B11 | `library-undeclared` | A package under a library root has no declared type |
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
excluded from B6–B8, B10, and B15–B17; other import and ownership rules
still apply, and B20 judges test files only. Globs support `**`, `*`, `?`, and
`{a,b}`.

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

## Workers and workspace imports

`acrossDeployables` enables the listed kinds; none are enabled by default.

| Rule | Kind | Violation |
|---|---|---|
| B17 | `binding-outside-driven-adapter` | A declared worker binding is referenced outside a driven adapter and its worker's `main` |
| B18 | `worker-call-cycle` | Service-binding declarations form a cycle between workers |
| B19 | `relative-import-crosses-workspace` | A relative import points into another package directory |

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

B19 compares the nearest package directories of importer and target, even
when the target path does not exist. Bare specifiers and tsconfig aliases
are outside B19. Type-only relative imports still count.

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
workspace crossings, or `null` for impure globals, bare imports, and structural findings.
The schema validates which kinds may use `null`.

| Mode | Effect |
|---|---|
| Report | Exit 0 after measuring valid declarations |
| `--ci` | Exit 1 on unrecorded crossings; prune resolved entries from the ledger |
| `--accept-crossings --reason <text>` | Add unrecorded crossings with the supplied reason |
| `--migrate-ceilings` | Seed today's ledger and delete the legacy count file |

Scopes outside the analyzed directory remain untouched. Invalid declarations
exit 2 before writing. Migration refuses increases above legacy import
ceilings; impure, structural, library, shape, deployable, and test-reach entries
are seeded without counting toward those import ceilings.

File movers can preserve ledger identities with
[`@demlik/code-graph/boundaries`](./library.md#boundaries).

Source: [base rules](../../src/boundaries/rules.ts),
[library schema](../../src/boundaries/libraries/schema.ts),
[shape schema](../../src/boundaries/shape/schema.ts),
[deployable schema](../../src/boundaries/deployables/schema.ts),
[ledger](../../src/boundaries/ledger.ts), [gate](../../src/boundaries/gate.ts).
