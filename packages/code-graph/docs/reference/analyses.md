# Analysis reference

[Documentation index](../README.md) · [CLI flags](./cli.md)

## Metrics and refactor plans

A function node represents a declaration with a body, method, constructor,
accessor, or named arrow/function expression. Anonymous callbacks contribute
to their enclosing function's metrics. Overloads and bodyless declarations
have no separate nodes.

Each node includes an id, file, line range, line/comment counts, complexity,
nesting depth, and findings. A named nested function owns its own metrics.

| Plan axis | First ranking input |
|---|---|
| `rot` | Number of findings, then complexity and caller count |
| `impact` | Distinct caller count; requires call analysis |
| `complexity` | Complexity |
| `size` | Lines of code |

Plan rows include their ranking inputs. Thresholds and the exact metric rules
are defined in [the schema](../../src/schema/core.ts) and
[extraction specification](../../SPEC.md#7-metrics).

## Declarations and name lookup

A declaration node represents a top-level type alias, interface, enum, class,
or `const` binding that is not already a function node. Each has an id, name,
kind, file, line, exported flag, and `uses`: every `file` and `line` where the
type checker resolves a name to it, through renamed imports and re-exports.
`uses` is `null` without call analysis. Declarations have no metrics or findings.

`--find <name>` prints every function and declaration with that bare name as
JSON. A function's uses are its call sites. Several matches are listed, not
refused. The rules are in the
[extraction specification](../../SPEC.md#a1--what-gets-a-node).

## Calls and import cycles

Call analysis adds `calls`, `calledBy`, `callChainDepth`, `importedBy`, and
resolved import edges. Self-recursion is reported separately from external
fan-in. `--blast` follows callers within the loaded graph.

`--cycles` reports module-import cycles as file groups. It is a report;
the ordinary smell gate can separately fail on `dependency-cycle` findings.

## Cross-runtime calls

`--cross-runtime` resolves service-binding calls to worker methods, Durable
Object dispatches to their methods, and Workflow `create`/`createBatch` calls
to the workflow's `run`.

Bindings come from top-level `wrangler.json`, `wrangler.jsonc`, or
`wrangler.toml` declarations. Named deployment-environment blocks are not read.
Both workers' files must be in the analyzed directory for a target to resolve.

Unresolved edges retain `calleeId: null` and a reason: `target-service-unknown`,
`target-not-loaded`, or `ambiguous-target`. Their call ids use `unresolved:`;
ordinary external calls use `external:`. The census includes unused bindings.

Source: [cross-runtime resolution](../../src/extract/cross-runtime.ts).

## Storage access

`--data` records access to bindings declared as D1, Durable Object, KV, R2,
or queue producers. It works on syntax alone.

| Binding | Read | Write |
|---|---|---|
| D1 | Literal SQL starting with `SELECT`; `dump` | Literal SQL starting with `INSERT`, `UPDATE`, `DELETE`, `REPLACE`, `CREATE`, `DROP`, or `ALTER` |
| KV | `get`, `getWithMetadata`, `list` | `put`, `delete` |
| R2 | `get`, `head`, `list` | `put`, `delete`, multipart upload creation/resumption |
| Queue | — | `send`, `sendBatch` |
| Durable Object | Access stays `unknown` | Access stays `unknown` |

Other methods, non-literal SQL, `WITH`, and a whole binding passed to another
function have `unknown` access. This classification is narrower than the
node-kind effect rules below.

A site identifies its worker, binding, kind, method, access, line, and column.
Named functions own their sites. Module-level sites without a named owner go
to `unattributed`. Reports also include `configFiles` and `unparsedConfigs`.

Recognized receivers include `env.X`, `this.env.X`, and `c.env.X`, plus one
level of aliasing or destructuring. A binding name identifies a worker's
binding; two workers using `DB` need not share a database.

The standalone report is `DataReport`. With `--graph --data`, it is `Graph.data`.
Source: [data extraction](../../src/data/extract.ts) and
[access classification](../../src/data/access.ts).

## Node kinds

`--kinds` gives each function one role. Every matching rule remains in its
evidence; precedence is `entry`, then `auth`, then `effect`, then `plain`.

| Kind | Meaning |
|---|---|
| `entry` | A platform handler, RPC/DO entry, CLI command, or framework-called export |
| `auth` | A recognized authorization function or call |
| `effect` | A recognized storage, network, queue, or workflow operation |
| `plain` | No rule matched; displayed as unclassified |

Entries also carry `reach`: `public`, `service-binding`, or `platform`.
A Workflow's `run` is reached through its creation call, rather than becoming
an independent entry.

Defaults cover common platform handlers and libraries. Effect rules match
the callee's declaration, such as `drizzle-orm:PgDatabase.update`, rather than
every function named `update`. Untyped receivers have no effect declaration.

`--node-kinds` replaces each supplied rule group. Custom names must therefore
include any defaults that should remain in that group. The complete groups
and default patterns live in [node-kind rules](../../src/kinds/rules.ts).

### Framework entry exports

The `nextjs` preset activates when a package depends on `next`, or through
`--entry-preset nextjs` / `entryExportPresets` in the rules file. It covers App
Router special files, route methods, metadata/static-parameter functions,
Pages Router exports, middleware/proxy, and instrumentation.

Only function exports become nodes. Custom `pageExtensions` and `distDir`
settings are not read. The exact file/name list is in
[the preset table](../../src/kinds/presets.ts).

A custom convention supplies package-relative file globs and export names:

```json
{
  "entryExportConventions": {
    "job-runner": { "files": "{,src/}jobs/*.ts", "exports": ["run"] }
  }
}
```

Custom conventions add to active presets. Globs support `**/`, `*`, `?`, and
`{a,b}`; brackets and route-group parentheses are literal. Unknown presets,
invalid globs, and empty export lists are rejected.

## Unreachable exports

`--unreachable` uses calls plus modeled references and dynamic dispatch.
Candidates must be unreachable from entries, outside the package's declared
public surface, and absent from other non-test files.

| Result | Meaning |
|---|---|
| `dead` | No reference survives those checks |
| `only-called-from-tests` | References remain only in test files |
| Withheld | Public surface, test-support surface, or a non-test reference prevents a finding |

The report counts withheld candidates with their reasons. The wider walk
includes passed function values, fallback functions, dynamic imports,
factory options, module-level calls, object members, and rooted class methods.

## Unguarded effects

`--unguarded` follows calls and cross-runtime edges from entries to effects.
Each finding includes its shortest call path and the entry's reach.
References alone do not establish that an effect ran.

Recognized entry guards, such as Pothos `authScopes`, start the path guarded.
Findings are assigned the most exposed reach found: public, then service
binding, then platform. Callable factory results can resolve to config
members that the returned function invokes.

These results depend on recognized entries, guards, effects, and calls.
Source: [reachability queries](../../src/query/reach.ts) and
[unguarded paths](../../src/query/unguarded.ts).

## Interface width

`--interface-width` counts consumer files outside each declaring package.
It includes function exports beyond those named by the package's export map.

Zero observed consumers make an export worth reviewing. Consumers outside
the analyzed directory or in other repositories are not counted. Name
collisions can inflate consumer counts because detection uses identifier
occurrences.

## Collapse candidates

`--collapse` reports candidates for human or model review. It does not establish
that two functions should be merged.

| Signal | Comparison |
|---|---|
| `shape` | Lines, complexity, and nesting |
| `callees` | Functions they call |
| `callers` | Functions that call them |
| `name` | Shared name tokens |

At least two signals must match; `minSignals` defaults to 2. Candidates rank
by confidence divided by estimated change cost. Cost includes caller count,
package spread, crossing a package boundary, and downstream effects.

Groups are cliques: every member matches every other member. Oversized search
keys skipped by the index are listed, rather than hidden.

### Partial twins

These are shared ordered call blocks followed by different calls. A finding
requires a shared block, the same named constant in its call arguments, and
a different next call in both functions. A shared block can occur anywhere.

Defaults are `partialMinPrefix: 3` calls and `partialMinSharedConstants: 1`.
A function ending at the shared block is not a divergence. Full setting names
and defaults are in [collapse settings](../../src/collapse/settings.ts).

`--collapse --ci` gates only partial-twin counts in `collapse-ceilings.json`.
Both increases and stale decreases fail. `--write-ceilings` records the
analyzed scope without changing other entries.

## Clusters

`--clusters` groups the file-level call/import graph, including cross-runtime
calls, and reports folders spanning groups or groups spread across folders.
It is a heuristic report, with no CI gate.

Tests, isolated files, and type-only import edges do not participate.
Excluded/isolated counts remain visible. The human view truncates large
groups; JSON includes the full lists. Louvain traversal and tie-breaking
are fixed to keep the partition repeatable.

## Hotspots

`--hotspots` multiplies commits touching a file by the sum of that file's
function complexity. The default window is the last 90 days.

Reports state the resolved time window and current HEAD. `--hotspots-since`
fixes the start; the end still moves with the current time. Reproducibility
requires the same history and the same resolved window.

A tracked file untouched during the window has churn 0. An untracked file
has churn and score `null`, and appears under files with no git history.

## Environment keys

`--env-keys` compares recognized reads with Wrangler `vars`,
`secrets.required`, and `.dev.vars`. It lists unused declarations, undeclared
reads, and withheld findings. Unparsed configs are reported; reads owned by
them are withheld as `read-site-owner-unparsed`.

## Comments

`--comments` counts comment lines, with each line assigned to one bucket.

| Class | Buckets |
|---|---|
| `mechanical` | Banner, commented-out code |
| `protected` | Pragma, license, marker |
| `prose` | File header, docblock, block, inline |

Matching uses precedence: a docblock containing `TODO` is a marker.
Commented-out code requires a clean parse. Counts alone do not decide whether
prose is useful.

`--comments --ci` reads `comment-ceilings.json`. Ratios above a ceiling fail;
recorded scopes more than `slackPoints` below it also fail because the ceiling
is stale. Scopes inheriting `default` are checked only for increases.
`--write-ceilings` rounds measured ratios up to one decimal place and preserves
the existing default and slack settings.
