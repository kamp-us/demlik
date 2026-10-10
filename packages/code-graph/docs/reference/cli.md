# CLI reference

[Documentation index](../README.md)

```sh
pnpm exec code-graph <directory> [flags]
```

Requires Node.js 20 or later. Paths are relative to the working directory.
The default output is a JSON summary of counts, health, and refactor targets.

## Views

| Flag | Output |
|---|---|
| `--graph` | Complete graph as JSON |
| `--plan` | Top 20 refactor targets; `--json` includes every row |
| `--by <axis>` | Plan order: `rot` (default), `impact`, `complexity`, or `size` |
| `--smells` | Findings grouped by kind; `--json` returns the finding list |
| `--tree` | File/function tree with line ranges, metrics, and findings |
| `--file <file>` | One module and its functions |
| `--blast <id>` | Direct and transitive callers of a function |
| `--html` | Standalone HTML report; enables call analysis |

`--by impact` requires call analysis. A blast target may be a unique name or a
function id. Id paths are relative to the analyzed directory: a scan of `src`
uses `orders.ts:charge`. Ambiguous names exit 1. `--tree --json` returns the
full graph.

## Function headers

`--headers` adds a `header` field to every function node in the JSON that
`--graph`, `--file <file> --json` and `--tree --json` print. Without the flag
the field is absent, and the output is unchanged.

```json
"header": {
  "text": "export function pick(a: string | number): string | number",
  "overloads": [
    { "startLine": 2, "text": "export function pick(a: string): string" },
    { "startLine": 4, "text": "export function pick(a: number): number" }
  ]
}
```

- `text` is the source as written, never reformatted. It starts where the
  node's `startLine` points: `export`, `export default`, `async`, `static` and
  other modifiers are included. It ends at the last token before the body, so
  an arrow's header ends with `=>`. A comment above the function, or between
  the header and the body, is not included.
- `overloads` lists the overload signatures written before the implementation,
  in source order, each with its own start line and without its closing `;`.
  The comments between them are left out. A function with no overloads lists
  none. Overload signatures are never function nodes; this field is the only
  place they appear.
- A node with no body, such as an `interface` accessor, runs to its end without
  the closing `;` or `,`.

## Published API

`--api <map>` prints what a package publishes, per export subpath, as a
consumer's types see it. `<directory>` is the package root. `<map>` is a JSON
file the caller writes:

```json
{
  ".": { "entry": "src/index.ts", "tier": "stable" },
  "./testing": { "entry": "src/testing/index.ts" }
}
```

Each key is a subpath. `entry` is its source file, relative to the package
root. `tier` is optional and any non-empty string; it is copied to the output
and never read. code-graph reads no `package.json` `exports` and no build
config: only the caller knows which source file a subpath comes from.

The mode runs the pinned tsgo with declaration-only emit into a temp folder
outside the checkout, using the tsconfig the package scope picks, and removes
the folder before it exits. A type error does not stop the emit; tsgo's
diagnostic count goes to stderr as one warning line. It prints a
`PublishedApi` JSON object with sorted keys: the package `root`, the tsgo
`compiler` version, and per subpath its `entry`, `tier` (`null` when absent)
and `names`. Each name has its declaration `text` as emitted, without
comments, and `references`: the text of every declaration it reaches that the
subpath does not publish, keyed `<emitted file>#<declared name>`. A change to
a private type therefore changes the published name that uses it.

| Flags | Prints | Exit |
|---|---|---|
| `--api <map>` | `PublishedApi` JSON | 0, 2 |

`--api` combines only with `--json`, `--pretty` and `--out`. Exit 2, with one
stderr line and nothing on stdout, for any other flag beside it, a map that is
not JSON or fails the schema (an unknown key, no subpath, an empty `entry` or
`tier`, an entry that is not a `.ts`, `.tsx`, `.mts` or `.cts` file, lies
outside the package or does not exist), no tsconfig, tsgo failing to start,
or an entry with no emitted file. Without `--api` no emit runs and every other
output is unchanged. The full contract, with an example, is
[SPEC.md §13](../../SPEC.md).

## Analysis options

| Flag | Analysis |
|---|---|
| `--edges` | Calls, callers, resolved imports, and call-chain depth |
| `--deep` | Call analysis using the workspace-root tsconfig |
| `--cross-runtime` | Calls through Cloudflare worker bindings |
| `--kinds` | Function roles: entry, auth, effect, or plain |
| `--unreachable` | Exports with no modeled path from an entry |
| `--unguarded` | Effects reached along a path without an auth check |
| `--clusters` | Groups of connected files compared with their folders |
| `--interface-width` | Exports and consumer files outside each package |
| `--collapse` | Similar functions and shared call blocks for review |
| `--cycles` | Groups of files in module-import cycles |
| `--data` | Access to D1, Durable Object, KV, R2, and queue bindings |
| `--hotspots` | Git churn multiplied by function complexity |
| `--env-keys` | Declared-but-unread and read-but-undeclared environment keys |
| `--comments` | Comment counts by file, package, bucket, and class |
| `--layers` | Imports that violate a declared layer stack |
| `--boundaries` | Crossings of declared feature, library, and worker rules |

Result fields and limitations are described in [Analyses](./analyses.md).
[Layer rules](./layers.md) and [boundary rules](./boundaries.md) have their own
references.

## Pass selection and scope

The default scan uses oxc syntax only. `--data` and `--hotspots` can add results
without enabling the call graph.

`--edges`, `--deep`, `--blast`, `--html`, `--cycles`, and `--interface-width`
enable call analysis. Other reports enable the passes they need:

| Report | Also enables |
|---|---|
| `--cross-runtime` | Call analysis |
| `--kinds`, `--clusters` | Cross-runtime and call analysis |
| `--unreachable`, `--unguarded`, `--collapse` | Node kinds, cross-runtime, and call analysis |

`--layers`, `--boundaries`, `--env-keys`, and `--comments` run separately, without
a full Graph or tsgo call analysis. Boundary checks can still require a tsconfig
to resolve imports in a declared scope.

The analyzed directory controls which files enter the graph. Package scope
chooses the nearest `tsconfig.json` at or above that directory. `--deep` chooses
one at or above the workspace root; it **does not widen the file scan**.
Cross-package callers require a directory containing those packages.

The workspace root is the nearest ancestor with `pnpm-workspace.yaml`, or the
analyzed directory if none exists. An edge pass without a tsconfig exits 2.
This monorepo has package tsconfigs, so `--edges` works on a package; it has no
root tsconfig for a root `--deep` run.

## Configuration

| Flag | JSON file |
|---|---|
| `--thresholds <file>` | Partial smell-threshold overrides |
| `--node-kinds <file>` | Function-classification rules |
| `--entry-preset <name>` | Built-in entry conventions; currently `nextjs`, repeatable |
| `--layer-rules <file>` | Layer stack and allowed violations |
| `--boundary-rules <file>` | Feature, door, library, and worker declarations |
| `--collapse-config <file>` | Similarity and shared-block settings |

Unknown JSON keys, invalid values, and invalid patterns are rejected.
Each supplied top-level key replaces that key's default. Custom entry-export
conventions apply alongside active presets.

## Gates and baselines

| Flag | Policy |
|---|---|
| `--ci` | Fail on high-severity smells by default |
| `--fail-on <level>` | `high` (default) or `warn`; `warn` fails on any smell |
| `--max <n>` | Also fail if the total smell count exceeds `n` |
| `--comments --ci` | Check ratios against `comment-ceilings.json` |
| `--collapse --ci` | Check shared-block counts against `collapse-ceilings.json` |
| `--boundaries --ci` | Check crossings against `boundary-ledger.json` |
| `--write-ceilings` | With comments: rewrite ratios. With collapse: record this scope's count |
| `--accept-crossings` | With boundaries: add unrecorded crossings to the ledger |
| `--reason <text>` | Required, non-empty reason for accepting crossings |
| `--migrate-ceilings` | With boundaries: replace a legacy boundary-count file with a ledger |

The ordinary smell gate is syntax-only unless call analysis is also requested.
Boundary, comment, and collapse gates use their own policies. Layers always
gate, without needing `--ci`.

Boundary `--ci` can rewrite the ledger when it prunes resolved crossings.
`--boundaries --write-ceilings` is retired. Acceptance, migration, and boundary
CI are mutually exclusive. See [Adopt a boundary gate](../how-to/enforce-boundaries.md).

## Output and hotspots

| Flag | Behavior |
|---|---|
| `--json` | Return JSON for the selected view |
| `--pretty` | Indent JSON |
| `--out <file>` | Write a view directly to a file; its parent must exist |
| `--hotspots-days <n>` | Window ending now; default 90 days |
| `--hotspots-since <iso>` | Explicit start date, overriding the day count |
| `--hotspots-limit <n>` | Human-view row limit; default 20; JSON includes all rows |
| `--help` | Show the CLI's help |

`--out` keeps script-wrapper banners out of JSON and HTML. The write confirmation
goes to stderr. The ordinary smell `--ci` verdict always goes to stdout, even
when `--json` or `--out` is supplied.

`--graph` includes requested analysis tables. Without it, an analysis flag
selects that analysis's report. Standalone modes take precedence over graph
views. For unrelated reports, separate invocations keep the selected output clear.

## Files and failures

Scans include `.ts` and `.tsx`. Git supplies tracked and untracked files,
honoring ignore rules for untracked files. Outside git, the tool walks folders.
It excludes hidden paths, `*.d.ts`, `*.gen.ts`, `node_modules`, `vendor`, `dist`,
`.next`, and `__generated__`.

Read/parse failures appear in `parseFailures`; those files have no function
nodes. Unmatched oxc/tsgo function nodes produce a stderr warning, and their
calls remain unresolved.

| Exit | Meaning |
|---|---|
| 0 | Successful report or passing gate |
| 1 | Failed gate or missing/ambiguous blast target |
| 2 | Tool-reported input/configuration error, including a missing edge tsconfig |

The option parser also rejects unknown flags. Check stderr for the specific
error and for scope warnings.

Source: [CLI options](../../src/cli.ts), [mode selection](../../src/index.ts),
[file discovery](../../src/extract/project.ts), [published API](../../src/api/cli.ts).
