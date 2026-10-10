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

`@demlik/code-graph/resolve` exports `loadInProcessGraph`, `moduleSymbolOf` and the types
`InProcessGraph`, `InProcessGraphOptions`, `ExportOrigin`, `ExportDeclaration`,
`SubpathEntries`, `SubpathExport`, `UnresolvableSubpath`, and `SubpathAnswer`.

`loadInProcessGraph(root, options)` returns a resolver, or `null` without a
suitable tsconfig. Options default to `scope: "package"` and `repoRoot: root`.

`resolveExportOrigin(fromFile, specifier, exportName)` follows a static import
and its aliases/re-exports to `{ file, name }`. The result's file is absolute.
Missing files, missing imports, or unresolved exports return `null`.

`resolveModuleExport(moduleFile, exportName)` asks a module file itself what it
exports under `exportName`, so an entry file that only re-exports needs no file
importing it. It follows re-exports and aliases to an `ExportDeclaration`:

| Field | Meaning |
|---|---|
| `file` | Absolute path of the declaring file |
| `name` | The declared name, which differs from `exportName` after `export { a as b }` |
| `line` | 1-based line of the declaration's first token, past any doc comment |

A name with several declarations, such as an overloaded function, reports the
first one: its first overload signature. A missing file, or a name the module
does not export, returns `null`.

`resolvePublishingSubpaths(entries, exportName)` asks every entry in
`entries`, a `SubpathEntries` record from subpath to source file such as
`{ ".": "src/index.ts", "./testing": "src/testing/index.ts" }`. It returns a
list of `SubpathAnswer`, in the record's order, and `[]` when no entry
publishes the name and every entry file exists. The caller supplies the map
because an export map points at build output and only the build config knows
which source file each entry comes from. Relative paths resolve against the
working directory.

A `SubpathAnswer` is one of two shapes. Narrow with `"unresolvable" in answer`.

| Shape | Fields | When |
|---|---|---|
| `SubpathExport` | `subpath`, `entry` (absolute), `declaration` (an `ExportDeclaration`) | The entry file publishes the name |
| `UnresolvableSubpath` | `subpath`, `given` (the path as written in `entries`), `entry` (`given` made absolute), `unresolvable: "missing-entry-file"` | The entry file does not exist |

A subpath whose file exists but does not publish the name is left out. A
subpath whose file is missing comes back as `UnresolvableSubpath` for every
name asked, so a stale map is visible instead of reading as "does not
publish". With a map whose files all exist, the list holds only
`SubpathExport` values. `resolveModuleExport` still returns `null` for a
missing file.

One tsgo session opens on the first lookup and is reused. Each lookup gets
its own program. `dispose()` releases the session; create a new handle for
later lookups.

`moduleSymbolOf(program, moduleFile)` is the step under `resolveModuleExport`:
the module symbol a file declares in an open tsgo program, or `undefined`. It
is exported for the published-API view below, which asks the same step; its
`program` argument is code-graph's own tsgo wrapper, so most callers want
`resolveModuleExport` instead.

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

  const publishers = graph.resolvePublishingSubpaths(
    { "./resolve": path.join(root, "src/resolve.ts") },
    "loadInProcessGraph",
  );
  // [{ subpath: "./resolve", entry: "<absolute root>/src/resolve.ts",
  //    declaration: { file: "<absolute root>/src/resolve.ts", name: "loadInProcessGraph", line: <n> } }]
} finally {
  graph.dispose();
}
```

Source: [resolver](../../src/resolve.ts).

## API

`@demlik/code-graph/api` is the library side of `--api` (see the
[CLI reference](cli.md#published-api)). It exports:

| Export | Result |
|---|---|
| `readPublishedApi(root, map, options?)` | `Promise<PublishedApi>`: per subpath, every published name with its text and references |
| `diffPublishedApi(root, map, base, options?)` | `Promise<ApiDiff>`: per subpath, the names added, removed and changed against the commit `base` names |
| `readChangesetsSince(root, base, options?)` | `ChangesetsSince`: the package's name and its changesets added since the commit `base` names |
| `ratchetApiDiff(diff, policy, changesets)` | `ApiRatchetVerdict`: the changes that miss the bump the policy asks for; pure, no I/O |
| `ApiMapSchema`, `BumpPolicySchema` | The zod schemas an API map and a bump policy are parsed through |
| `ApiInputError` | Thrown for every input the CLI refuses with exit 2, with the same message |

and the types `ApiMap`, `ApiEntryText`, `PublishedApi`, `ApiDiff`,
`PublishedApiOptions`, `BumpPolicy`, `Bump`, `Changeset`, `ChangesetsSince`,
`ChangesetsOptions` and `ApiRatchetVerdict`.

`root` is the package root and resolves against the working directory. `map`
is the API map, `{ "<subpath>": { entry, tier? } }`, parsed through
`ApiMapSchema` before use. `options` is `{ repoRoot?, warn? }`: `repoRoot`
defaults to `findRepoRoot(root)`, and `warn` receives the one warning line for
an emit with diagnostics (stderr by default). The emit runs in a temp folder
outside the checkout and is removed before the promise settles.

```ts
import { readPublishedApi } from "@demlik/code-graph/api";

const api = await readPublishedApi("packages/tea", {
  ".": { entry: "src/index.ts", tier: "stable" },
  "./testing": { entry: "src/testing/index.ts", tier: "stable" },
});
api.subpaths["./testing"]?.names.expectCmdEmitted?.text;
// "export declare function expectCmdEmitted<S, M extends {\n    type: string;\n}, …>(…): void;"
```

`diffPublishedApi` takes the same `root`, `map` and `options`, plus `base`, any
rev git resolves to a commit in the repository that holds `root`. It writes
that commit's tree from git's objects into a temp folder outside the checkout,
links the checkout's installed `node_modules` into it, reads the same view
there, and compares it with the view of the working tree as it is. The
checkout's files, index, branch and stash are never written, and the temp
folders are removed before the promise settles. A rev that names no commit
throws `ApiInputError` before anything is emitted. Per subpath, the result has
the `tier` and `added` (`{ after }`), `removed` (`{ before }`) and `changed`
(`{ before, after }`) maps of `ApiEntryText`, with `base` as the full sha.

```ts
import { diffPublishedApi } from "@demlik/code-graph/api";

const diff = await diffPublishedApi("packages/tea", map, "origin/main");
diff.subpaths["./testing"]?.changed.expectCmdEmitted?.before.text;
// "…, cmd: NoInfer<C>): void;"  (and `.after.text` ends "…, cmd: C): void;")
```

`readChangesetsSince` and `ratchetApiDiff` are the library side of
`--api-policy`. `readChangesetsSince(root, base, options?)` is synchronous and
only reads. It returns `{ package, changesets }`: `package` is the `name` in
`root`'s `package.json`, and each `Changeset` is `{ file, bump, body }` for a
file that counts, with `file` repo-relative, `bump` one of `major`, `minor`
and `patch`, and `body` the text after the frontmatter. The
[CLI reference](cli.md#published-api) says which files count. `options` is
`{ repoRoot? }`, the folder that holds `.changeset/`, defaulting to
`findRepoRoot(root)`. A `package.json` with no `name`, or a changeset whose
frontmatter does not parse, throws `ApiInputError`.

`ratchetApiDiff(diff, policy, changesets)` judges a diff and reads nothing but
its arguments. `policy` is the bump policy, parsed through `BumpPolicySchema`
before use:
`{ callout, tiers: { "<tier>": { added, changed, removed } }, default? }`, each
rule `{ bump, callout? }` with `bump` one of `none`, `patch`, `minor` and
`major`. The library holds no policy of its own. The verdict has `passed`,
`base`, `package`, the counted `changesets`, `highestBump`, `calloutFound` and
`misses`, sorted by subpath, then name, each with `subpath`, `tier`, `name`,
`kind`, `needs`, `before` and `after`. An invalid policy throws
`ApiInputError`, and so does a changed name whose tier the policy gives no row
and no `default`.

```ts
import {
  diffPublishedApi,
  ratchetApiDiff,
  readChangesetsSince,
} from "@demlik/code-graph/api";

const diff = await diffPublishedApi("packages/tea", map, "origin/main");
const verdict = ratchetApiDiff(
  diff,
  {
    callout: "**Breaking",
    tiers: {
      stable: {
        added: { bump: "minor" },
        changed: { bump: "minor", callout: true },
        removed: { bump: "minor", callout: true },
      },
    },
  },
  readChangesetsSince("packages/tea", diff.base),
);
if (!verdict.passed) process.exitCode = 1;
```

Source: [API exports](../../src/api.ts).

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
