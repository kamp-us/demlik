# Library API

[Documentation index](../README.md)

The named subpaths are ESM and ship TypeScript declarations. There is no root
library export; the `code-graph` executable is the CLI.

## Project

`@demlik/code-graph/project` exports shared discovery and path helpers:

| Function | Result |
|---|---|
| `listVisibleFiles(root, keep)` | Relative POSIX paths accepted by the predicate |
| `listSourceFiles(root)` | Absolute source paths using the CLI's file filters |
| `discoverPackageRoots(root)` | Relative package directories, including `""` for the root |
| `resolveEdgeTsConfig(root, scope, repoRoot)` | Selected tsconfig path; throws if none exists |
| `toRelative(root, path)` | Relative POSIX path |
| `findRepoRoot(root)` | Nearest ancestor with `pnpm-workspace.yaml`, otherwise the given root |

Use absolute roots. `EdgeScope` is `"package" | "deep"`.
The former `loadCheapProject`, `loadEdgeProject`, `LoadedProject`, and
`LoadedEdgeProject` exports were removed with the ts-morph engine.

Source: [project exports](../../src/project.ts).

## Resolve

`@demlik/code-graph/resolve` exports `loadInProcessGraph` and the types
`InProcessGraph`, `InProcessGraphOptions`, and `ExportOrigin`.

`loadInProcessGraph(root, options)` returns a resolver, or `null` without a
suitable tsconfig. Options default to `scope: "package"` and `repoRoot: root`.

`resolveExportOrigin(fromFile, specifier, exportName)` follows a static import
and its aliases/re-exports to `{ file, name }`. The result's file is absolute.
Missing files, missing imports, or unresolved exports return `null`.

One tsgo session opens on the first lookup and is reused. Each lookup gets
its own program. `dispose()` releases the session; create a new handle for
later lookups.

Example, run in this checkout's `packages/code-graph` directory after building:

```ts
import path from "node:path";
import { loadInProcessGraph } from "@demlik/code-graph/resolve";

const root = process.cwd();
const graph = loadInProcessGraph(root);
if (graph === null) throw new Error("No tsconfig.json found for the resolver");

try {
  const origin = graph.resolveExportOrigin(
    path.join(root, "src/index.ts"),
    "./extract/project.js",
    "findRepoRoot",
  );
  // { file: "<absolute root>/src/extract/project.ts", name: "findRepoRoot" }
} finally {
  graph.dispose();
}
```

Source: [resolver](../../src/resolve.ts).

## SCC

`@demlik/code-graph/scc` exports `stronglyConnectedComponents` and `sccMembers`.

The inputs are string node ids and a `Map<string, string[]>` adjacency list.
Components receive ascending numbers from leaves toward callers. Nodes in
one component keep input order. This ordering supports traversing a
condensed call graph from dependencies to dependents.

Source: [SCC exports](../../src/scc.ts).

## Boundaries

`@demlik/code-graph/boundaries` exports the ledger schema, types, and helpers.

| Helpers | Purpose |
|---|---|
| `parseBoundaryLedger`, `readBoundaryLedger` | Read statuses: `absent`, `read`, or `invalid` |
| `serializeBoundaryLedger`, `writeBoundaryLedger` | Sorted ledger output |
| `boundaryLedgerOf` | Sort and deduplicate entries, retaining reasons |
| `ledgerKey`, `ledgerTargetOf` | Crossing identity and effective target |
| `rekeyBoundaryLedger`, `rekeyBoundaryLedgerFile` | Update identities after exact file moves |

It also exports `BoundaryLedgerSchema`, `BOUNDARY_KINDS`, `LEDGER_FILENAME`,
and the ledger/move/status types.

Move paths are repository-relative. Rekeying updates importing files and
file targets, preserves reasons, and leaves worker identities and package
directory targets alone. It does not rewrite source imports or decide
whether a crossing still exists; the next boundary gate does that.

Source: [ledger API](../../src/boundaries/ledger.ts).
