# Boundary rules

[Documentation index](../README.md) · [Adoption steps](../how-to/enforce-boundaries.md)

```sh
pnpm exec code-graph . --boundaries --boundary-rules boundary-rules.json
```

The rules file declares features, library types, and worker constraints.
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

A declared feature uses this layout by default:

```text
src/billing/
  index.ts             public entry
  ports.ts             port types
  application/         use cases
  adapters/driving/    HTTP, RPC, cron, and other callers
  adapters/driven/     storage and other external operations
```

`layout: { "packages/app": "rules" }` selects the older layout: `index.ts`
is public, `rules/` is pure, and other files are internal. `contracts` lists
the package imports allowed from `rules/`.

| Rule | Kind | Violation |
|---|---|---|
| B1 | `cross-feature` | Another feature's internals imported instead of its `index.ts` |
| B2 | `impure-rules` | `rules/` imports beyond itself/contracts or uses a world door |
| B3 | `lib-imports-feature` | A shared helper folder imports a feature |
| B4 | `outside-imports-feature-internal` | A file outside features/helpers imports feature internals |
| B5 | `door-outside-owner` | A declared world door is used outside its owner files |

Hexagonal features add these rules:

| Rule | Kind | Violation |
|---|---|---|
| B6 | `application-imports-adapter` | A use case imports its own feature's adapter |
| B7 | `impure-application` | A use case opens a world door |
| B8 | `driving-reaches-driven` | A driving adapter imports its own application or driven adapter |
| B9 | `door-outside-driven-adapter` | A door is opened in `index.ts`, `ports.ts`, or a driving adapter |
| B10 | `unknown-zone` | A file or folder directly under the feature has no declared zone |

A wiring file outside features and helpers may import hexagonal adapters.
It still cannot import `application/` or `ports.ts`. Cross-feature imports
remain limited to `index.ts`. B2 applies only to the `rules` layout.

## World doors

A door is a recognized reference to an external facility. `doors` assigns
exact scope-relative owner files:

```json
{
  "features": { "packages/app": ["billing", "orders"] },
  "doors": {
    "packages/app": {
      "process.env": ["src/env.ts"],
      "node:fs": ["src/billing/adapters/driven/files.ts"]
    }
  }
}
```

| Door family | Recognized use |
|---|---|
| `process.<member>` | Static references, including literal member access and destructuring |
| `Date.now`, `performance.now` | Clock references |
| `new Date()` | Construction without an argument |
| `Math.random`, `crypto.randomUUID`, `crypto.getRandomValues` | Randomness references |
| `fetch`, `setTimeout`, `setInterval`, `globalThis` | Runtime references |
| `console` | Any `console.*` reference |
| `node:fs`, `node:child_process` | Runtime module imports, including subpaths and unprefixed names |

Deeper static paths, such as `process.stdin.isTTY`, may have their own owners.
The most specific declared prefix wins. Bare `process` is not a valid door.
Its first member must exist on the running Node process; platform and launch
mode can therefore affect declaration validation.

Type positions and type-only module imports do not open doors. Locally bound
names suppress global detection; aliases such as `const p = process` are not
followed. Detection of rebinding is per file, not full lexical data flow.

B2, B7, and B9 enforce their zone's door restriction even without an owner
declaration, and take precedence over B5 there. `rules/` import restrictions
can still reject a type-only import that opens no runtime door.

Owners must name loaded files outside forbidden zones. Each crossing records
one file/door pair; another read in the same ledgered file is not a new entry.

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

Types may import themselves only when listed. `importedFrom` accepts `driven`,
`configurator` (outside features), or `any`. Omitting it allows any location.
Library-to-library imports are configurator imports.

| Rule | Kind | Violation |
|---|---|---|
| B11 | `library-undeclared` | A package under a library root has no declared type |
| B12 | `library-imports-up` | A library imports a type its own type does not allow |
| B13 | `impure-library` | A pure library opens a door or imports a world library |
| B14 | `adapter-library-imported-outside-driven` | An import violates the target type's `importedFrom` list |

Imports resolve by workspace package name, including subpaths. Relative
cross-package imports are handled by B19. B12 takes precedence over B14 for
the same disallowed library import. Type-only imports still count for B12
and world-library restrictions.

The report's library census lists types, undeclared packages, and unjudged
imports into undeclared workspace packages. Nested files belong to the
nearest declared library. Packages outside declared feature/library scopes
are not read for these file-level rules.

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

`testFiles` matches repository-relative globs. Matched tests are excluded
from B6–B10, B13, and B15–B17; other import and ownership rules still apply.
Globs support `**`, `*`, `?`, and `{a,b}`.

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
reads. Empty lists are invalid; the scope must have hexagonal features.

A recognized storage write in a listed file always blocks the allowance.
The B8 report names its first write site. ORM writes and `unknown` access
remain outside this check. An unparsed worker config refuses a run that
declares read allowances, because write detection would be incomplete.

## Workers and workspace imports

`acrossDeployables` enables the listed kinds; none are enabled by default.

| Rule | Kind | Violation |
|---|---|---|
| B17 | `binding-outside-driven-adapter` | A declared worker binding is referenced outside a driven adapter |
| B18 | `worker-call-cycle` | Service-binding declarations form a cycle between workers |
| B19 | `relative-import-crosses-workspace` | A relative import points into another package directory |

`bindingOwners` can further limit a binding to exact scope-relative driven
files. It requires B17 and a scope declaring features.

B17 reads the nearest top-level Wrangler config and recognizes `env`, `.env`
receivers, and one alias level. Arbitrary receiver names, deeper aliases,
and named config environments are not followed. Its census includes clean
and violating binding sites.

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

Identity is `(scope, kind, from, to ?? specifier)`, plus `global` when present.
`specifier` is display-only for file targets. `global: true` distinguishes a
by-name door from a package import for `impure-rules`. Reasons are optional
in existing entries; accepting new entries requires a reason.

Targets are files for ordinary imports, package directories for library and
workspace crossings, or `null` for doors, bare imports, and structural findings.
The schema validates which kinds may use `null`.

| Mode | Effect |
|---|---|
| Report | Exit 0 after measuring valid declarations |
| `--ci` | Exit 1 on unrecorded crossings; prune resolved entries from the ledger |
| `--accept-crossings --reason <text>` | Add unrecorded crossings with the supplied reason |
| `--migrate-ceilings` | Seed today's ledger and delete the legacy count file |

Scopes outside the analyzed directory remain untouched. Invalid declarations
exit 2 before writing. Migration refuses increases above legacy import
ceilings; door, structural, library, shape, and deployable entries are seeded
without counting toward those import ceilings.

File movers can preserve ledger identities with
[`@demlik/code-graph/boundaries`](./library.md#boundaries).

Source: [base rules](../../src/boundaries/rules.ts),
[library schema](../../src/boundaries/libraries/schema.ts),
[shape schema](../../src/boundaries/shape/schema.ts),
[deployable schema](../../src/boundaries/deployables/schema.ts),
[ledger](../../src/boundaries/ledger.ts), [gate](../../src/boundaries/gate.ts).
