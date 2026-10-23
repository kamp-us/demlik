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
| `--hexagon` | One feature's Ports & Adapters, human text; `--json` returns the inventory |
| `--file <file>` | One module and its functions |
| `--blast <id>` | Direct and transitive callers of a function |
| `--find <name>` | Every function and top-level declaration with that name, as JSON |
| `--html` | Standalone HTML report; enables call analysis |

`--by impact` requires call analysis. A blast target may be a unique name or a
function id. Id paths are relative to the analyzed directory: a scan of `src`
uses `orders.ts:charge`. Ambiguous names exit 1. `--tree --json` returns the
full graph.

`--find` always prints JSON (`--pretty` indents it): `{ name, scope, matches }`.
Each match has `id`, `name`, `kind`, `file`, `line`, `isExported`, and `uses`, a
list of `{ file, line }`. A function's uses are its call sites. A declaration's
are every place the type checker resolves to it. Several matches exit 0. No
match prints an empty list, warns on stderr, and exits 0.

## Feature hexagon

`code-graph <featureDir> --hexagon` reads `ports.ts`, immediate `application/*.ts`
files, and adapter files recursively under `adapters/driving/` and
`adapters/driven/`. It needs no tsconfig or model. `--json`, `--pretty` and `--out`
work as on other views.

Sections appear in this order: Commands, External systems, Other bags, Ports
declared in ports.ts but in no bag, Use cases, Adapters. Empty sections print
`none`. JSON fields are `feature`, `commands`, `externalSystems`, `otherBags`,
`unbaggedPorts`, `useCases` and `adapters`; empty lists are `[]`.

The exported factory `createX` supplies the feature name; `X` and `XDriven` are
the driving and driven bags. The factory in `application/<directory-name>.ts`
takes precedence, then factories with matching bags, then file/name order.
Without a factory, the directory name becomes PascalCase. Other exported object
aliases and interfaces are listed as bags, including data objects. Local
intersections and interface inheritance are expanded. Members keep their written
types and local function signatures; imported references and generic
instantiations stay as written. Unbagged ports are local `For` type aliases
followed by a capital letter that no bag references, directly or through local
aliases. Use cases list each file's exported functions. Standard source filters
apply, including tests. Lists and JSON keys are sorted deterministically.

Missing `ports.ts`, unreadable selected files, syntax errors, and cyclic bags
exit 2 with a path or bag name on stderr and no partial output.
The complete extraction contract is [SPEC.md §14](../../SPEC.md#14-feature-hexagon---hexagon).

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

`--api-base <rev>` diffs that view against a base commit. `<rev>` is any rev
git resolves to a commit (`origin/main`, a sha, `HEAD~1`); in CI, fetch it
first, because `actions/checkout` fetches one commit. The base commit's tree is
written from git's objects into a temp folder outside the checkout
(`git archive`), with the checkout's installed `node_modules` linked in, and
the same view runs there. The "after" side is the working tree as it is,
uncommitted edits and untracked files included. The checkout's files, index,
branch and stash are never written. It prints an `ApiDiff` JSON object: the
package `root`, the base commit's full sha as `base`, the tsgo `compiler`, and
per subpath its `tier` and three maps of names: `added` (with `after`),
`removed` (with `before`) and `changed` (with both). A name is `changed` when
its text or its references differ, so a change to a private type shows on the
published name that uses it. A subpath whose entry the base commit lacks has
every name `added`. The diff reports and does not gate: it exits 0 whatever it
finds.

```sh
code-graph packages/tea --api tea-api.json --api-base origin/main --pretty
```

`--api-policy <file>` gates that diff on the package's changesets, for a CI
job. `<file>` is a JSON bump policy the caller writes. code-graph ships no
policy and no default row:

```json
{
  "callout": "**Breaking",
  "tiers": {
    "stable": {
      "added": { "bump": "minor" },
      "changed": { "bump": "minor", "callout": true },
      "removed": { "bump": "major", "callout": true }
    },
    "experimental": {
      "added": { "bump": "none" },
      "changed": { "bump": "none" },
      "removed": { "bump": "none" }
    }
  }
}
```

- `tiers` maps a tier, as the API map spells it, to one rule per change kind.
  All three kinds, `added`, `changed` and `removed`, are required. A rule's
  `bump` is `none`, `patch`, `minor` or `major`, the least changeset bump that
  change needs. Its `callout` is optional and defaults to `false`.
- `callout` is the marker text, required and non-empty. A rule with
  `callout: true` is met only when a counted changeset's body contains it.
- `default` is optional and has the shape of one tier's row. It covers a
  subpath whose tier `tiers` does not name, and a subpath with no tier.
  Without it, a changed name in such a subpath exits 2 naming the subpath and
  the tier. A subpath with no change needs no row.

A changeset counts when it is a `.md` file directly in `.changeset/` at the
repo root, is not `README.md`, exists in the working tree, does not exist in
the base commit's tree, and its frontmatter gives the package (the `name` in
`<directory>/package.json`) a `major`, `minor` or `patch` bump. A changeset
for another package does not count. The highest bump among the counted files
is the bump found, `none` when no file counts, and the callout is found when
any counted file's body contains the marker.

A changed name misses when its rule's bump is above the bump found, or when
its rule asks for the callout and none is found. A pass prints one line:

```text
API RATCHET: pass — 4 changes against 4b1c0de, highest changeset bump minor, callout found
```

A miss prints one block per name that misses, sorted by subpath, then name,
then a summary line. Each block names the name, subpath, tier and change kind,
the bump and callout it needs, and what was found, then the before and after
text with references (an added name has no before, a removed name no after):

```text
API RATCHET: parse in . (stable) changed — needs a minor changeset with a "**Breaking" callout; found minor with no callout
  before:
    export declare function parse(text: string): number;
  after:
    export declare function parse(text: string, radix?: number): number;
API RATCHET: 1 of 1 change misses its bump against 4b1c0de
```

`--json` prints an `ApiRatchetVerdict` instead: `passed`, the full `base` sha,
the `package` name, the counted `changesets` (repo-relative, sorted),
`highestBump`, `calloutFound` and `misses`, each with `subpath`, `tier`,
`name`, `kind`, `needs` (`{ bump, callout }`), `before` and `after` (`null`
where the name has none). The same commits give the same bytes.

```sh
git fetch origin main
code-graph packages/tea --api tea-api.json --api-base origin/main --api-policy tea-bumps.json
```

| Flags | Prints | Exit |
|---|---|---|
| `--api <map>` | `PublishedApi` JSON | 0, 2, 3 |
| `--api <map> --api-base <rev>` | `ApiDiff` JSON | 0, 2, 3 |
| `--api <map> --api-base <rev> --api-policy <file>` | the verdict as text; `--json` for `ApiRatchetVerdict` | 0 pass, 1 miss, 2, 3 |

`--api` combines only with `--api-base`, `--api-policy`, `--json`, `--pretty`
and `--out`.
Exit 2, with one stderr line and nothing on stdout or in `--out`, for any other
flag beside it, a map that is not JSON or fails the schema (an unknown key, no
subpath, an empty `entry` or `tier`, an entry that is not a `.ts`, `.tsx`,
`.mts` or `.cts` file, lies outside the package or does not exist), no
tsconfig, tsgo failing to start, or an entry with no emitted file. With
`--api-base`, also for `--api-base` without `--api`, a package outside any git
repository, a rev that does not resolve to a commit, or a failed `git archive`.
With `--api-policy`, also for `--api-policy` without `--api-base`, a policy
that is not JSON or fails the schema (an unknown key, an empty `callout`, a
row missing a change kind, a `bump` outside the four), a
`<directory>/package.json` that is missing or has no `name`, a changeset
added since the base whose frontmatter does not parse, or a changed name whose
tier has no row and no `default`.
Exit 3 for any other error inside the run, in all three: one stderr line,
`code-graph: unexpected error: <message>`, no stack trace and nothing on
stdout. The diagnostics warning above is a line of its own and still comes
first when tsgo reported any. An `--out` file that cannot be written exits 3,
not 2. Exit 1 therefore always means a ratchet miss, never a crash.
Without `--api` no emit runs and every other output is unchanged. The full
contract, with examples, is [SPEC.md §13](../../SPEC.md).

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

`--edges`, `--deep`, `--blast`, `--find`, `--html`, `--cycles`, and
`--interface-width` enable call analysis. Other reports enable the passes they need:

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
| `--boundary-rules <file>` | Feature, library, and worker declarations |
| `--collapse-config <file>` | Similarity and shared-block settings |

Unknown JSON keys, invalid values, and invalid patterns are rejected.
Each supplied top-level key replaces that key's default. Custom entry-export
conventions apply alongside active presets.

## Gates and baselines

| Flag | Policy |
|---|---|
| `--ci` | Fail on high-severity smells by default; with a smell ledger, check gated smells against `smell-ledger.json` |
| `--fail-on <level>` | `high` (default) or `warn`; `warn` fails on any smell |
| `--max <n>` | Also fail if the total smell count exceeds `n` |
| `--accept-smells` | Add unrecorded smells of the gated rules to `smell-ledger.json` |
| `--comments --ci` | Check ratios against `comment-ceilings.json` |
| `--collapse --ci` | Check shared-block counts against `collapse-ceilings.json` |
| `--boundaries --ci` | Check crossings against `boundary-ledger.json` |
| `--unreachable --ci` | Check unreachable exports against `unreachable-ledger.json` |
| `--write-ceilings` | With comments: rewrite ratios. With collapse: record this scope's count |
| `--accept-crossings` | With boundaries: add unrecorded crossings to the ledger |
| `--accept-dead` | With unreachable: add unrecorded findings to `unreachable-ledger.json` |
| `--dead-only` | With `--unreachable --ci`: gate only `dead` findings |
| `--reason <text>` | Required, non-empty reason for `--accept-crossings`, `--accept-dead` or `--accept-smells` |
| `--migrate-ceilings` | With boundaries: replace a legacy boundary-count file with a ledger |

The ordinary smell gate is syntax-only unless call analysis is also requested.
Boundary, comment, collapse, and unreachable gates use their own policies.
Layers always gate, without needing `--ci`.

Boundary `--ci` can rewrite the ledger when it prunes resolved crossings.
`--boundaries --write-ceilings` is retired. Acceptance, migration, and boundary
CI are mutually exclusive. See [Adopt a boundary gate](../how-to/enforce-boundaries.md).

### The unreachable ledger

`--unreachable --ci` gates the `--unreachable` findings, and never the smells.
`unreachable-ledger.json` sits at the repo root, beside `boundary-ledger.json`:

```json
{
  "entries": [
    {
      "id": "src/shell/execute.ts:inWords",
      "kind": "dead",
      "reason": "kept for the move",
      "scope": "packages/core"
    }
  ]
}
```

- An entry is keyed by `(scope, kind, id)`. `scope` is the analyzed path relative
  to the repo root (`.` for the root itself). `kind` is `dead` or
  `only-called-from-tests`. `id` is the finding's scope-relative id. `reason` is
  required.
- `--unreachable --accept-dead --reason "<why>"` adds every finding of this scope
  that the ledger does not name yet. It also drops this scope's entries whose
  finding is gone.
- `--unreachable --ci` exits 1 on a finding of this scope that the ledger does not
  name, and lists each one. It never fails on an entry whose finding is gone: it
  rewrites the ledger without that entry and prints it, so the ledger only shrinks.
- A run changes only entries of its own scope, but it reads and validates the
  whole file first: a bad entry in any scope exits 2.
- Both kinds are gated by default. `--dead-only` gates only `dead`: an
  `only-called-from-tests` finding neither fails the run nor is pruned.
- A finding whose kind changes is a new finding, and its old entry is pruned.
- Withheld symbols (`public-entry-surface`, `referenced-in-non-test-file`,
  `test-support-surface`) are not findings and never enter the ledger.
- `--json` prints `{ passed, scope, gated, unrecorded, pruned }` for `--ci`, and
  `{ scope, accepted, pruned, reason }` for `--accept-dead`.
- Exit 2, with one line on stderr and nothing written: `--accept-dead` without a
  non-empty `--reason`, with `--ci`, or without `--unreachable`; `--dead-only`
  without `--unreachable --ci`; `--reason` on `--unreachable` without
  `--accept-dead`, unless `--boundaries` is also given (the boundary gate judges
  `--reason` then); and an unreadable or schema-invalid `unreachable-ledger.json`.

```sh
code-graph packages/core --unreachable --accept-dead --reason "baseline"   # once
code-graph packages/core --unreachable --ci                                # in CI
```

### The smell ledger

A plain `--ci` judges every smell in the tree. The smell ledger lets a repo gate
the rules it chooses at today's count: old smells may only shrink, and a new one
fails. `smell-ledger.json` sits at the repo root, beside the other ledgers:

```json
{
  "entries": [
    {
      "reason": "split in the core sweep",
      "rule": "big-file",
      "target": "packages/core/src/host.ts",
      "value": 900
    }
  ],
  "gated": ["big-file"]
}
```

- `gated` names the rules the repo gates, from the ten smell rules. No rule is
  gated until named. While the file is absent or `gated` is empty, `--ci` is the
  plain gate above, with the same output and exit codes.
- Once a rule is gated, `--ci` reads the ledger instead of `--fail-on` and
  `--max`. Only smells of gated rules count, at any severity. A smell of another
  rule neither fails nor is recorded.
- An entry is keyed by `(rule, target)`. `target` is relative to the repo root:
  a function's id (`<file>:<name>`, never its start line), a module's file, or a
  directory's path. `value` is the measure it may not exceed, such as a file's
  line count. `reason` is required.
- `--ci` exits 1 on a smell the ledger does not name, and on a recorded smell
  whose value grew. It lists each, with the recorded and measured value.
- `--ci` writes improvements back: an entry whose smell shrank is lowered to the
  new value, and an entry whose smell is gone is pruned. Both are printed.
- `--accept-smells --reason "<why>"` is the only way the ledger grows. It adds
  every unrecorded smell of a gated rule, and raises every recorded one that grew
  to its measured value. It also lowers and prunes as `--ci` does.
- A run changes only entries under the analyzed path, so `code-graph .` and
  `code-graph packages/core` judge `packages/core` the same way.
- `high-fan-in`, `deep-call-chain`, `dependency-cycle` and `cross-boundary-import`
  are measured only by the edge pass. Gating one turns the edge pass on, so its
  entries are always measured, never pruned unmeasured.
- A function renamed, or a file moved, is a new smell, and its old entry is
  pruned. A second function of the same name in one file renames the first id
  (`#<n>` is added).
- `--json` prints `{ passed, scope, gated, unrecorded, worsened, lowered, pruned }`
  for `--ci`, and `{ scope, gated, accepted, raised, lowered, pruned, reason }`
  for `--accept-smells`.
- Exit 2, with one line on stderr and nothing written: an unreadable or
  schema-invalid `smell-ledger.json`, including a rule name that is not a smell
  rule; `--accept-smells` without a non-empty `--reason`, with `--ci`, with no
  rule gated, or beside `--unreachable`, `--boundaries`, `--comments`,
  `--collapse` or `--layers`.

```sh
echo '{ "gated": ["big-file"] }' > smell-ledger.json                        # name the rule
code-graph packages/core --accept-smells --reason "split in the core sweep"  # once
code-graph packages/core --ci                                                # in CI
```

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
when `--json` or `--out` is supplied. The smell ledger verdict follows `--json`
and `--out`.

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
