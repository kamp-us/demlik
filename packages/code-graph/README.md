# @demlik/code-graph

Agent-native TypeScript code-graph + smell tool. Point it at a folder; it parses
every `.ts`/`.tsx` (with oxc), measures each function (loc, complexity,
nesting depth, comment lines), groups them into modules and directories, flags
smells against the thresholds in `schema.ts`, and ranks refactor targets. Output
is deterministic JSON (sorted object keys, sorted arrays — same input, same
bytes) so an agent reads a graph instead of re-reading files.

The default run is **cheap** (no tsconfig, syntax only — fast). Call
edges (`calls`/`calledBy`/`importedBy`/`callChainDepth` + their smells) are an
**opt-in** pass triggered by `--edges`, `--deep`, or `--blast`; it resolves
modules with oxc-resolver and callees with tsgo's checker.

Three further passes are opt-in on top of that, and each implies the ones below it:
**cross-runtime edges** (`--cross-runtime`), **node kinds** (`--kinds`), and the
**path queries** (`--unreachable`, `--unguarded`). **Cluster analysis** (`--clusters`)
is opt-in too and needs cross-runtime edges, but not kinds — it labels no vertex.
Nothing in this paragraph runs on a default invocation.

## Invocation

```sh
pnpm add -D @demlik/code-graph
pnpm exec code-graph <path> [flags]
```

`<path>` is relative to the cwd (absolute paths also work), so run it from the repo root and
pass root-relative paths (e.g. `code-graph services/audit-agents --plan`). Inside a repo that
wires a root `code-graph` script, `pnpm code-graph X` is the same call. The tables below write
`code-graph X` for brevity.

## Usage contract

When sent to refactor folder `X`, the first moves are Bash calls, not Reads:

| Goal | Call |
|---|---|
| Orient — health + worst offenders (first call) | `code-graph X` |
| Ranked refactor targets, re-rankable | `code-graph X --plan [--by rot\|impact\|complexity\|size]` |
| Indented file → function tree with inline smell markers | `code-graph X --tree` |
| One file's functions + line ranges | `code-graph X --file <f>` |
| Blast radius before changing a signature (intra-package) | `code-graph X --blast <id>` |
| **Cross-package** blast radius (before changing a shared export) | `code-graph X --blast <id> --deep` |
| Full graph (rarely — large) | `code-graph X --graph` |
| CI gate (fail on smells) | `code-graph X --ci [--fail-on high\|warn] [--max <n>]` |
| Which workers call which, over service bindings / DOs | `code-graph services --cross-runtime` |
| Classify nodes `entry`/`auth`/`effect`/`plain` | `code-graph X --kinds` |
| Exported symbols nothing reaches | `code-graph X --unreachable` |
| Writes reachable from an entry with no auth on the path | `code-graph X --unguarded` |
| Imports pointing UP the declared layer stack (a gate) | `code-graph . --layers` |
| Imports crossing a declared feature boundary, world doors (`process.env`, `fetch`, the clock, `node:fs`) opened outside their owner, libraries of declared types importing upward or using the world, and, across deployables, worker bindings used outside a driven adapter, workers that call each other in a loop and relative imports between workspaces | `code-graph X --boundaries` |
| Gate feature-boundary, world-door, library and deployable crossings against `boundary-ledger.json` | `code-graph . --boundaries --ci` |
| Record the current crossings, with why they stay | `code-graph . --boundaries --accept-crossings --reason "<why>"` |
| Move off a `boundary-ceilings.json` once | `code-graph . --boundaries --migrate-ceilings` |
| Ranked collapse candidates + partial twins | `code-graph X --collapse` |
| Gate the partial twins against their recorded ceiling | `code-graph . --collapse --ci` |
| Re-record one scope's partial-twin ceiling | `code-graph X --collapse --write-ceilings` |
| Where the directory layout disagrees with how the code clusters | `code-graph X --clusters` |
| Churn × complexity hotspots (where defects concentrate) | `code-graph X --hotspots` |
| Packages ranked by export count, zero-external-consumer exports called out | `code-graph X --interface-width` |
| Module-import cycles, as their participating files | `code-graph X --cycles` |
| Env-var keys declared but never read, and read but never declared | `code-graph X --env-keys` |
| Which functions read or write which D1 / DO / KV / R2 / queue binding | `code-graph X --data` |
| How much of the tree is comment, of what kind, and where | `code-graph X --comments` |
| Comment ratio ratchet — gate the tree against `comment-ceilings.json` | `code-graph . --comments --ci` |
| Re-record every ceiling after a comment cleanup | `code-graph . --comments --write-ceilings` |

`--blast` requires an unambiguous target — pass the `id` (`file:name`), not a
bare name. In default (`package`) scope, blast output is flagged incomplete for
cross-package callers; re-run with `--deep`.

## Flags

| Flag | Behavior |
|---|---|
| (none) | `Summary` JSON: health band, counts, worst file/function, top targets, parse failures |
| `--graph` | Full `Graph` JSON (the large dump, on demand) |
| `--plan [--by rot\|impact\|complexity\|size]` | Ranked `PlanRow[]` (human table, top 20). `--json` → full `PlanRow[]` |
| `--smells` | All smells grouped by kind (human). `--json` → `Smell[]` |
| `--tree` | Indented `file → function  L12-48  loc=36 cx=8 nest=3 [smell markers]`. Color when a TTY, plain when piped. `--json` falls back to the full graph |
| `--file <f>` | One module + its functions. Warns if `<f>` is in `parseFailures` |
| `--blast <id>` | Direct + transitive callers of `<id>`. Ambiguous bare name exits non-zero. `package` scope flags omitted cross-package callers |
| `--edges` | Opt-in edge pass at `package` scope: adds edge data + the `high-fan-in` / `deep-call-chain` smells |
| `--deep` | Edge pass over the whole monorepo; implies `--edges` at `deep` scope |
| `--ci [--fail-on high\|warn] [--max <n>]` | Gate: exit non-zero per policy. `--fail-on high` (default) fails on any high-severity smell; `--fail-on warn` fails on any smell; `--max <n>` fails if total smell count exceeds `n`. Cheap by default; add `--edges`/`--deep` to gate on edge smells too |
| `--thresholds <file>` | JSON file of partial threshold overrides, parsed through `ThresholdsSchema.partial()` and merged over the defaults. A typo'd key or wrong-typed value exits cleanly (exit code 2, one-line message) |
| `--cross-runtime` | Resolve `env.<BINDING>.<method>()` to the target worker's method (implies the edge pass). Prints the binding census + every resolved and unresolved edge |
| `--kinds` | Classify each function `entry`/`auth`/`effect`/`plain` and print the census. `plain` is reported as UNCLASSIFIED. Implies `--cross-runtime` |
| `--unreachable` | Exported symbols with no path from any entry, split `dead` vs `only-called-from-tests`, plus the count of candidates WITHHELD and why. Implies `--kinds` |
| `--unguarded` | `effect` nodes reachable from an `entry` without crossing an `auth` node, each with its shortest witness path and the `reach` of the entry that found it (`public`, `service-binding`, `platform`), listed per reach. Implies `--kinds` |
| `--clusters` | Community detection over the call + import graph, compared against the directory tree: directories spanning several clusters, and clusters scattered across directories. Report, never a gate. Implies `--cross-runtime` |
| `--interface-width` | Every exported symbol, grouped by its declaring package, ranked by export count; each export's consumer count OUTSIDE the package, and the zero-consumer ones called out as free deletions. Implies the edge pass (does NOT imply `--kinds`) |
| `--node-kinds <file>` | JSON file of node-kind rule overrides, same boundary discipline as `--thresholds`. An override REPLACES a whole pattern group |
| `--entry-preset <name>` | Turn on a built-in [entrypoint-export preset](#entrypoint-export-conventions) (`nextjs`) for every package, including one whose `package.json` does not depend on the framework. Repeatable; adds to any `entryExportPresets` the rules file names. An unknown name exits 2 |
| `--layers` | Layer gate: every import edge pointing UP the declared layer stack, plus the census and the allowlist verdict. **Exits 1** on any disagreement. No stack ships, so with no `--layer-rules` file declaring one it refuses: exit code 2, one-line message naming `--layer-rules`. Runs on the cheap pass — no type-checker, no Graph. A tsconfig `paths` alias resolves through the importing file's nearest tsconfig, an alias naming no file is UNRESOLVED, and any other unresolvable specifier stays `external` |
| `--layer-rules <file>` | JSON file declaring the layer stack (`layers`, at least two) and its allowlist (`allowed`), same boundary discipline as `--thresholds`. Both default to empty; see [Declaring the stack](#declaring-the-stack---layer-rules) |
| `--boundaries` | Feature boundaries over each scope declared in the boundary rules at or under the analyzed path, on its `modules[].importEdges` and the world doors each file opens: **B1** a feature importing another feature anywhere but its `src/<feature>/index.ts`; **B2** a feature's `rules/` importing anything but its own `rules/` and the declared `contracts`, or using a world door by name (any `process.<member>`, `fetch`, `Date.now()`, `console`, … see [World doors](#world-doors-doors)); **B3** a `lib` folder importing a feature; **B4** a file in no declared feature and no `lib` folder (the rest of `src/`, and loaded files outside it) importing a feature anywhere but its `src/<feature>/index.ts`; **B5** a file using a declared world door that is not one of the door's owners (a type-only import opens no door). `lib` importers are judged by B3, not B4. A scope whose `layout` is `hexagonal` lays its features out in Cockburn's zones instead of `rules/` and adds **B6** `application-imports-adapter`, **B7** `impure-application`, **B8** `driving-reaches-driven`, **B9** `door-outside-driven-adapter` and **B10** `unknown-zone`; see [Hexagonal features](#hexagonal-features-layout). A rules file that declares libraries judges the package level too, one scope per declared library, and adds **B11** `library-undeclared`, **B12** `library-imports-up`, **B13** `impure-library` and **B14** `adapter-library-imported-outside-driven`; see [Library types](#library-types-librarytypes). Across deployables, three more rules run only when `acrossDeployables` lists them: **B17** `binding-outside-driven-adapter` (a worker binding used outside a hexagonal feature's `adapters/driven/`), **B18** `worker-call-cycle` (workers that bind each other in a loop) and **B19** `relative-import-crosses-workspace` (a relative import into another workspace); see [Across deployables](#across-deployables-acrossdeployables). A report, exit 0, with a census of the libraries when a library key is declared and a census of the deployables when a kind is listed; nothing declared means nothing reported. Implies the edge pass |
| `--boundaries --ci` | Boundary ledger gate: **exits 1** on a crossing `boundary-ledger.json` does not name, listing each; entries whose crossing is gone are pruned from the file and printed, never failed on. Exits 2 when only a legacy `boundary-ceilings.json` exists. See [The boundary ledger](#the-boundary-ledger---boundaries---ci) |
| `--boundaries --accept-crossings --reason "<why>"` | Add every unrecorded crossing to the ledger with that reason. Exits 2 and writes nothing without a non-empty `--reason` |
| `--boundaries --migrate-ceilings` | Seed the ledger from today's crossings and delete `boundary-ceilings.json`; exits 2, writing nothing, if any scope's import crossings exceed its recorded count (world-door entries, B5, B7, B9 and a door used by name in `rules/`, `unknown-zone` entries, the library kinds B11-B14 and the deployable kinds B17-B19 are seeded too and are not counted against it; library scopes are measured like any other, and so is the repo's worker call graph, scope `.`) |
| `--boundary-rules <file>` | JSON file of boundary-declaration overrides: `{ features: { "<scope>": ["<folder under src/>", …] }, lib: ["lib"], contracts: ["<package>", …], doors: { "<scope>": { "<door>": ["<owner file>", …] } }, layout: { "<scope>": "rules" \| "hexagonal" }, libraryTypes: { "<type>": { imports: ["<type>", …], pure: true \| false, importedFrom: ["driven" \| "configurator" \| "any", …] } }, libraries: { "<package directory>": "<type>" }, libraryRoots: ["<directory>", …], worldLibraries: ["<package>", …], acrossDeployables: ["binding-outside-driven-adapter" \| "worker-call-cycle" \| "relative-import-crosses-workspace", …], bindingOwners: { "<scope>": { "<binding>": ["<owner file>", …] } } }`. An override REPLACES each key wholesale. `doors`, `layout` and `bindingOwners` ride a scope that declares `features`; the four library keys ride none; `acrossDeployables` lists the deployable rules that run, none by default; see [World doors](#world-doors-doors), [Hexagonal features](#hexagonal-features-layout), [Library types](#library-types-librarytypes) and [Across deployables](#across-deployables-acrossdeployables) |
| `--collapse` | Ranked collapse candidates: pairs of functions that may be one function, grouped into cliques, each carrying its evidence — plus **partial twins**, pairs sharing one decision block over the same named constants and then calling different things. Implies `--kinds`. `--json` emits the full report (clusters + every scored pair + the skipped blocking keys + the partial twins) |
| `--collapse --ci` | Partial-twin ratchet over the scopes recorded in `collapse-ceilings.json`. Fails both ways: above a ceiling (a new twin) and below one (a fixed twin the file still counts). Does not gate the whole-function candidates |
| `--collapse --write-ceilings` | Record the analyzed path's partial-twin count in `collapse-ceilings.json`, leaving the other scopes as they are |
| `--collapse-config <file>` | JSON file of collapse-setting overrides, same boundary discipline as `--thresholds` |
| `--cycles` | Module-import cycles reported as their participating FILE GROUPS (the same Tarjan SCC the `dependency-cycle` smell scores, printed as groups rather than a per-file severity). Report, never a gate. Implies the edge pass — `importEdges` is `[]` on the cheap pass |
| `--comments` | Comment CENSUS: every comment line lands in exactly one of nine buckets, and each bucket in exactly one CLASS — **`mechanical`** (`banner`, `commented-out-code`: removable with no judgment), **`protected`** (`pragma`, `license`, `marker`: never touch), **`prose`** (`file-header`, `docblock`, `block`, `inline`: the volume, judgment required). Rolled up by bucket, by package scope, and by file, ranked by comment lines. Human view caps files and scopes at 20; `--json` emits every row. A count, not a verdict. Standalone: no Graph, no edge pass |
| `--comments --ci` | Comment RATCHET: gate each scope's ratio against `comment-ceilings.json` at the repo root. **Exits 1** on any violation, 2 on a malformed ceilings file |
| `--comments --write-ceilings` | Rewrite `comment-ceilings.json` from the current measurement (ceilings rounded UP to 1 dp; `default`/`slackPoints` carried forward) |
| `--data` | Data edges: every call site on a D1 / Durable Object / KV / R2 / queue binding, per function, with the binding kind, name and access (`read` / `write` / `unknown`). `--json` emits the `DataReport`; `--graph --data` puts it on the graph as `data`. Runs on either pass — syntax only, no edge pass needed. See [Data edges](#data-edges---data) |
| `--env-keys` | Env-var keys declared in wrangler `vars`/`secrets.required`/`.dev.vars` with no recognized read, and reads with no declaration, plus the withheld count. Standalone: no Graph, no edge pass |
| `--hotspots [--hotspots-days <n>] [--hotspots-since <iso>] [--hotspots-limit <n>]` | Churn (git commits touching a file) × complexity (sum of its functions' complexity), ranked by the product. `--hotspots-days` sets the window in days ending now (default 90); `--hotspots-since` pins an explicit ISO start instead (reproducible across runs); `--hotspots-limit` caps the human view (default 20; `--json` emits every row) |
| `--html` | Self-contained HTML report (human view; implies the edge pass). Pair with `--out` to write it banner-safe |
| `--out <file>` | Write the view payload straight to `<file>` instead of stdout — the banner-safe artifact path (the `pnpm code-graph` wrapper prints its run banner to stdout, so a bare `… > file.html` redirect corrupts the file; `--out` sidesteps stdout entirely). The `wrote N bytes` confirmation goes to stderr |
| `--pretty` | Pretty-print JSON output |
| `--json` | Force JSON output on a view command |

Capturing output to a file: prefer `--out <file>` (banner-safe). A bare `> file` redirect only stays clean when the wrapper is silent — `pnpm --silent code-graph …` or `tsx tools/code-graph/src/index.ts …` directly.

## Cross-runtime edges (`--cross-runtime`)

`env.AUDITER.getProject()` used to resolve to `external:getProject` — a leaf. In a
six-worker system that is where the real coupling lives, so the graph reported the
core as decoupled precisely where it is not. This pass resolves a service-binding
call or a Durable Object dispatch to the **target worker's method**, and a
Workflow binding's `create`/`createBatch` to the workflow class's `run`, and the
resolved id replaces the external one at the call site, so `--deep`, `--blast` and
`callChainDepth` span workers with no parallel structure to keep in sync.

The binding → service map is **derived** from the committed
`wrangler.{json,jsonc,toml}` files (`services[]`, `durable_objects.bindings[]` and `workflows[]`,
top-level environment only — `env.staging` re-declares the same binding names
against `-staging` deployments of the same code). There is no table to maintain:
delete a binding from the config and the edge leaves the graph.

A binding that cannot be resolved is **stated, not dropped**. Its edge carries
`calleeId: null` plus a reason — `target-service-unknown`, `target-not-loaded`,
`ambiguous-target` — and the call site gets the id
`unresolved:<service>.<class>.<method>`, a namespace distinct from `external:*`.
The census additionally lists every declared binding with **zero** call sites.

**Scope matters.** A target resolves only when the target worker's files are in the
loaded set, so run the pass at a root that contains both sides —
`pnpm code-graph services --cross-runtime` resolves 205 of 207 call sites in ~80s.
A single-service root reports every edge as `target-not-loaded` (still naming the
target service, class and method). `--deep` over the whole monorepo does not finish
in a usable time on this repo; `services` is the working root.

## Data edges (`--data`)

Two functions reading the same D1 database are strong evidence that they serve the same
responsibility, and a call graph cannot see it: they may never call each other. This pass records
which **storage** each function touches. Every call site on an env binding whose wrangler kind is
D1, Durable Object, KV, R2 or a queue producer becomes one edge:

```ts
type DataSite = {
  line: number;
  column: number;                // 1-based; two calls on one line are two sites
  ownerService: string;          // the worker whose wrangler config declares the binding
  binding: string;               // "DB"
  bindingKind: "d1" | "durable-object" | "kv" | "queue" | "r2";
  method: string | null;         // "prepare"; null when the binding is handed on whole
  access: "read" | "write" | "unknown";
};
type DataEdge = DataSite & { functionId: string };        // the FunctionNode that holds the site
type UnattributedDataSite = DataSite & { file: string };  // no named function holds the site
type DataReport = {
  configFiles: string[];
  unparsedConfigs: string[];
  edges: DataEdge[];
  unattributed: UnattributedDataSite[];
};
```

**Where it lives: a top-level table, `Graph.data`.** It is `null` unless `--data` ran, the same
shape as `crossRuntime`, so no existing field changes and a consumer that ignores it reads the
graph exactly as before. A per-function field was the alternative; the table keeps
`FunctionNode` untouched and puts every edge in one sorted array a consumer can group by binding.
There is no schema version to bump.

**Kinds come from the config, not the code.** `d1_databases[]`, `kv_namespaces[]`,
`r2_buckets[]`, `queues.producers[]` and `durable_objects.bindings[]` in each
`wrangler.{json,jsonc,toml}` (top-level environment only) type each binding name. A call site is
matched against the bindings of the worker that owns its file. The edge names the binding, not the
database, namespace or bucket behind it: `env.DB` in two workers is the same resource only if both
configs point `DB` at it.

**The call sites** are found on oxc's tree: `env.X`, `this.env.X` and `c.env.X`, plus one level
of aliasing (`const db = env.DB`, `const { DB } = env`). A site inside an anonymous callback
belongs to the named function around it; a nested named function owns its own sites. A site with
no named function around it at all — a module-scope Hono handler,
`app.get("/", (c) => c.env.DB.prepare(...))` — is not an edge, since there is no `FunctionNode`
to hang it on: it goes to `unattributed`, with its file, line and column, so the report never
reads complete when it is not.

**`unknown` is an answer.** The access is decided from the method, and only where the method
decides it:

| Kind | `read` | `write` | everything else |
|---|---|---|---|
| D1 | `prepare`/`exec` over a literal SQL that starts with `SELECT`; `dump` | `prepare`/`exec` over a literal starting `INSERT`/`UPDATE`/`DELETE`/`REPLACE`/`CREATE`/`DROP`/`ALTER` | `unknown` — non-literal SQL, `WITH`, `batch`, … |
| KV | `get`, `getWithMetadata`, `list` | `put`, `delete` | `unknown` |
| R2 | `get`, `head`, `list` | `put`, `delete`, `createMultipartUpload`, `resumeMultipartUpload` | `unknown` |
| Queue | — | `send`, `sendBatch` | `unknown` |
| Durable Object | — | — | always `unknown`: the namespace hands back a stub, and what the stub does is not at this site |

A binding passed on whole (`new Repository(env.DB)`) is an edge with `method: null` and
`unknown` access.

## Node kinds and the two path queries

A **type cannot express a path property**. No TypeScript type says "this write is
only reachable after an authorization check" — that is a property of paths, which is
why this repo accumulated fitness functions, ledgers and gates-on-gates to enforce
things a graph can simply answer.

`--kinds` labels every function with exactly one `NodeKind` — a discriminated union,
so an added kind fails to compile at every consumer:

| Kind | Meaning |
|---|---|
| `entry` | A place a real run starts: a `fetch`/`email` handler, a `scheduled`/`queue`/`tail` handler, a GraphQL resolver, a registered CLI command, any method of a class a wrangler config declares as a **Durable Object**, any public instance method of a class extending `WorkerEntrypoint` or `DurableObject` (`worker-entrypoint-method`), or an RPC method with at least one **real** cross-service caller (Feature A establishes that as a fact, not a guess). Also any export a framework calls by file convention, per the [entrypoint-export conventions](#entrypoint-export-conventions) in force. A Workflow's `run` is not an entry: only its own worker starts it, so it is reached through the `create` call-site's edge |
| `auth` | An authorization check |
| `effect` | A DB write, an object-store write, a network call, a queue send, a workflow spawn — matched on where the callee is **declared**, not on its name (see below); a repo function outside the scope gets a `workspace:<file>:<name>` id and is never an effect |
| `plain` | Nothing matched — reported as **unclassified**, never as a positive finding |

Every entry carries a `reach` — who can start it — read off its evidence by the
`entryReach` rule group, the most exposed evidence winning:

| Reach | Evidence | Who starts it |
|---|---|---|
| `public` | anything not below: a `fetch`/`email` handler, a resolver, a CLI command, a DO lifecycle hook | an outside caller |
| `service-binding` | `worker-entrypoint-method`, `cross-service-callee`, `durable-object-class` | another worker holding a binding: an RPC method is not an HTTP route, so a worker whose `fetch` exposes no route to it can only be called through the binding |
| `platform` | `platform-trigger` (`scheduled`, `queue`, `tail`, `trace`) | the runtime itself |

The attribute is static; the route is not. When a worker's `fetch` does call into an
RPC method, the walk from that `fetch` reaches the effect first and reports it
`public`.

Precedence is `entry > auth > effect > plain`, and `evidence` keeps **every** rule
that matched, so an entry handler that also writes is labelled `entry` while its
`db-write` evidence stays visible.

Detection is **declared, not clever**: `src/kinds/rules.ts` holds named regex groups,
overridable with `--node-kinds <file>`. Nothing infers, scores, or guesses.

The defaults are **framework-generic only**: platform handler names (Workers, Durable
Objects, GraphQL), library declarations (drizzle, pg, better-sqlite3, D1, R2/KV, Queue,
Workflow, `fetch`), Pothos `authScopes`, and conventional auth names
(`require(Auth|Session|SessionToken)`, `verify(ApiKey|AccessToken|SharedSecret)`,
`authorize*`). None of them names one codebase's own functions or SDKs, and a snapshot
test pins the whole set, so a new default is a reviewed diff. Your own auth helpers,
vendor SDKs and entry layouts go in the rules file. A top-level key in the file
**replaces** that whole group rather than extending it, so restate the defaults you want
to keep beside your own names; a key the file does not name keeps its default:

```json
{
  "authNames": {
    "auth-gate": ["^require(Auth|Session|SessionToken)$", "^assertProjectBelongsToOrg$"]
  },
  "authCallees": {
    "calls-auth-gate": ["^require(Auth|Session|SessionToken)$", "^getSessionFromHeaders$"]
  },
  "effectDeclarations": {
    "network-call": ["^[^:]+:([A-Za-z0-9]+\\.)?fetch$", "^stripe:"],
    "vm-spawn": ["^[^:]+:([A-Za-z0-9]+\\.)?(insertGceInstance|spawnCloudRunner)$"]
  },
  "entryFilePatterns": {
    "cli-command": ["(^|/)src/commands/", "(^|/)program/commands/"]
  }
}
```

```sh
code-graph services --kinds --node-kinds node-kinds.json
```

That file keeps only the `network-call` effect it restates, so its `effectDeclarations`
no longer holds `db-write`, `object-store-write`, `queue-send` or `workflow-spawn`; copy
those from `src/kinds/rules.ts` when you want them. `authNames` labels a function `auth`
by its own name, `authCallees` by a call it makes, `effectDeclarations` matches a call's
declaration (below), and `entryNames` / `entryFilePatterns` / `entryBaseClasses` add
entries by name, file path or base class.

An effect rule matches a call's **declaration**, which the edge pass records on every
call that leaves the repo's code as `<origin>:<Owner>.<member>`: the origin is the
ambient module (`declare module "crypto"`), else the package the declaring file sits in
(`@types/` dropped), else `workspace`; the owner is the class, interface or type alias
the member is declared on. An unresolved cross-runtime call records
`<service>:<class>.<method>`. So `db.update(t)` on a drizzle client is
`drizzle-orm:PgDatabase.update` and a `db-write`, while
`createHash("sha256").update(x)` is `crypto:Hash.update` and nothing, and a
`Map.delete` or `Object.create` stops posing as a write or a workflow spawn.
better-sqlite3 writes are `Statement.run`, `Database.exec` and `Database.transaction`;
its reads (`Statement.get`/`all`/`iterate`) and `pragma` are not effects. A call
whose receiver the checker cannot type has no declaration and is never an effect.
The Cloudflare rules (`R2Bucket`, `KVNamespace`, `Queue`, `Workflow`, `D1Database`,
`fetch`) match on the owner under any origin, because the runtime types arrive either
from `@cloudflare/workers-types` or from a wrangler-generated `worker-configuration.d.ts`.

### Entrypoint-export conventions

A file-convention framework calls some exports by where they live, not through any call
the graph can see: a Next.js page's default export, a route handler's `GET`. An
**entrypoint-export convention** declares that: a file glob plus the export names that
count as entries in files it matches. Only the listed names become entries, so a helper
exported beside them is still judged normally and an unreferenced one still reports
`dead`. Each matched export is `entry` under `--kinds`, with the convention's name as its
evidence, and is a root of the `--unreachable` walk.

| Field | Meaning |
|---|---|
| `files` | A glob over the file's path **relative to the package that owns it** (the nearest `package.json` at or above the file, no higher than the repo root; the analyzed root when there is none). `**/` is zero or more directories, `*` any run but `/`, `?` one character but `/`, `{a,b}` one alternative (`{,src/}` makes a prefix optional). Every other character is literal, so `[id]` and `(group)` path segments are matched by `**` |
| `exports` | The export names that are entries. `default` names the default export whatever its local name, so `export default function HomePage()`, `export default HomePage` and `export { handler as default }` all match it; `export { write as PUT }` matches `PUT` |

Only functions are judged: a non-function export such as `export const metadata = {…}`
or `export const dynamic = "force-dynamic"` is not a graph node, so it never reaches the
`--unreachable` output with or without a convention.

**The `nextjs` preset** ships built in, default `pageExtensions` only (`js`, `jsx`,
`ts`, `tsx`; code-graph reads the `ts`/`tsx` ones). It activates for a package whose
`package.json` lists `next` in `dependencies` or `devDependencies`, and anywhere on
opt-in: `--entry-preset nextjs`, or `"entryExportPresets": ["nextjs"]` in the rules file.
With neither, a `page.tsx` default export is judged like any other export. Its conventions,
each rooted at the package or under `src/`:

| Convention | Files | Exports |
|---|---|---|
| `nextjs/app-file` | `app/**/{page,layout,route,loading,error,global-error,not-found,template,default}` | `default` |
| `nextjs/app-metadata` | `app/**/{page,layout}` | `generateMetadata`, `metadata`, `generateViewport`, `viewport` |
| `nextjs/app-static-params` | `app/**/{page,layout,route}` | `generateStaticParams` |
| `nextjs/app-segment-config` | `app/**/{page,layout,route}` | `dynamic`, `dynamicParams`, `revalidate`, `fetchCache`, `runtime`, `preferredRegion`, `maxDuration` |
| `nextjs/app-route-handler` | `app/**/route` | `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`, `OPTIONS` |
| `nextjs/app-metadata-file` | `app/**/{opengraph-image,twitter-image,icon,apple-icon,sitemap,robots,manifest}` | `default`, `generateImageMetadata`, `generateSitemaps` |
| `nextjs/pages` | `pages/**/*` (API routes, `_app`, `_document` included) | `default`, `getServerSideProps`, `getStaticProps`, `getStaticPaths`, `config` |
| `nextjs/middleware` | `middleware`, `proxy` (Next.js 16) | `middleware`, `proxy`, `default`, `config` |
| `nextjs/instrumentation` | `instrumentation` | `register`, `onRequestError`, `default`, `config` |

Route groups, dynamic segments and parallel-route slots sit under `app/**`, so they are
covered. `pageExtensions` and `distDir` from `next.config` are not read.

**A custom convention** goes under `entryExportConventions` in the `--node-kinds` file,
keyed by the name its evidence will carry. Unlike every other group there, it **adds**:
your conventions apply beside every active preset, and on their own when none is active.

```json
{
  "entryExportConventions": {
    "job-runner": { "files": "{,src/}jobs/*.ts", "exports": ["run"] }
  },
  "entryExportPresets": ["nextjs"]
}
```

An unbalanced glob, an empty `exports` list or an unknown preset name exits 2 with a
one-line message.

### `--unreachable` fails toward silence

A measurement over the plain call graph found 133 zero-caller exports in this repo of
which hand-verification put ~6% genuinely unreachable — a 15-20× overcount. A
detector that cries wolf is worse than no detector, so this one reports a symbol only
when it can **affirmatively establish** that nothing reaches it, and every candidate
it declines to judge is counted with a reason (`referenced-in-non-test-file`,
`public-entry-surface`, `test-support-surface`).

Three gates, in order: unreachable over the **wide** edge set → not on a package's
declared export surface (read from its own `package.json` `exports`/`main`/`bin`,
because at package scope the consumers in `apps/*` were never loaded) → the name does
not occur in any non-test file other than its own. Survivors split by where the name
*does* occur: only in test files → `only-called-from-tests` (the "clean seam, wired
later" defect); nowhere → `dead`.

The wide edge set models seven dynamic-dispatch idioms the call graph cannot see, all
of which are live code here: argument-position references (`app.get(p, handler)`),
default-parameter fallbacks (`deps.del ?? deleteGceHands`), dynamic `import()`
fan-out (the CLI's whole command registration), inline handlers and factory options
(`defineRpc({ execute })`), module-top-level calls (`export const db =
createClient(env)`), object-literal members including method shorthand, and a class
named at module scope rooting its methods (`export const X = withObservabilityDO(Impl)`).

### `--unguarded` uses the tight edge set

An `effect` reachable from an `entry` with no `auth` on the path. An entry whose
config object declares its own guard — a Pothos field or mutation carrying
`authScopes` beside its `resolve`, or a field of a type whose definition carries
`authScopes` (wherever `objectField`/`objectFields` attaches it, unless it sets
`skipTypeScopes`) (`entryGuardProperties`, evidence in the entry's `guards`) — starts
the walk already guarded. It walks **calls +
cross-runtime edges only** — a reference edge means "this value was passed", not
"this ran", and admitting one here would manufacture findings rather than suppress
them. One multi-source BFS over `(node, guarded)` state, so every finding ships the
**shortest witness path** and a reader can confirm or dismiss it by eye.

The walk runs once per reach, most exposed first — `public`, then `service-binding`,
then `platform` — and an effect keeps the first reach that found it, so each finding
carries a `reach` and the human view lists the three separately: a write only another
worker can trigger is a different finding from one any caller can.

The call edges include one idiom the checker does not resolve on its own: a callable a
factory builds from a config object. `export const createProject = defineRpc({
parameters, result, execute })` makes `createProject` a value, not a function, so a
call to it used to end at `external:createProject`. The edge pass now reads the
factory's own body: a member of a parameter that the factory's **returned** function
calls (`spec.execute(...)`) is what runs when the value is called, so the call resolves
to that member of the config literal. A member the factory calls while building the
value is not followed, and nothing here names `defineRpc`.

## Layer violations (`--layers`)

**Does any edge go the wrong way through the architecture?** Layers are
**declared** in a `--layer-rules` file, never inferred — an inferred boundary moves
whenever the code moves, so it can never fail a build. Order is array order,
index 0 is the top, and an edge may point **down** a layer or **sideways** within
one. Never up.

A layer stack is specific to one repo, so **no stack and no allowlist ship**:
`layers` and `allowed` both default to empty. `--layers` without a file that
declares `layers` refuses with exit code 2 and one line naming `--layer-rules`
rather than passing green with nothing checked, the same way dependency-cruiser's
`--validate` refuses to run without a rules file.

### Declaring the stack (`--layer-rules`)

```json
{
  "layers": [
    { "name": "app", "paths": ["apps/web", "packages/cli"] },
    { "name": "service", "paths": ["services"] },
    { "name": "domain", "paths": ["services/*/src/domain", "packages/core"] },
    { "name": "contract", "paths": ["packages/core-contract"] }
  ],
  "allowed": [
    {
      "from": "services/billing/src/domain/invoice.ts",
      "to": "services/billing/src/config.ts",
      "sites": 1,
      "reason": "The domain reads a service setting. Fix: pass the setting in."
    }
  ]
}
```

```sh
code-graph . --layers --layer-rules layer-rules.json
```

`layers` needs at least two entries, and an explicit `"layers": []` is refused at
the schema boundary like any other malformed file. A layer name or a path pattern
declared twice is refused too. `allowed` may be omitted, which means no upward edge
is tolerated.

A pattern is a path prefix: it claims the file or folder it names and everything
under it, and a prefix ends at a path separator — `packages/core` never claims
`packages/core-contract`. Three wildcards widen it:

| Form | Matches | Example |
|---|---|---|
| `*` as a whole segment | one segment of one or more characters | `services/*/src/domain` |
| `*` inside a segment | zero or more characters, never `/` | `pkg/*-plumbing.ts` claims `pkg/billing-plumbing.ts`, not `pkg/a/billing-plumbing.ts` |
| `**` as a whole segment | zero or more whole segments | `apps/**/y` claims `apps/y` and `apps/p/q/y` |

Every other character is literal: `?`, `[...]`, `{a,b}` and a leading `!` match
themselves, so there is no negation and no alternation.

Together `**` and an in-segment `*` declare a layer by a file's **role** rather than
its folder, for a repo that names roles in file names wherever they sit:

```json
{
  "layers": [
    { "name": "api-surface", "paths": ["**/*-api-surface.ts"] },
    { "name": "plumbing", "paths": ["**/*-plumbing.ts"] },
    { "name": "business-rule", "paths": ["**/*-business-rule.ts"] }
  ]
}
```

When several patterns claim one file, the most SPECIFIC wins. Specificity compares
three keys in order, and the higher value wins at the first key that differs:

1. **depth** — the number of segments other than `**`;
2. **literal segments** — the number of segments with no `*` in them;
3. **literal characters** — the number of characters other than `*` and `/`.

So `services/*/src/domain` claims a file `services` would otherwise take (depth),
`apps/web/**/*-business-rule.ts` beats `**/*-business-rule.ts` (depth), and
`**/*-billing-plumbing.ts` beats `**/*-plumbing.ts` (literal characters). A
directory layer outranks every role layer no deeper than it: for
`services/x/billing-plumbing.ts`, `services` beats `**/*-plumbing.ts`, because both
have depth 1 and only `services` is a literal segment. A stack declared purely by
role never meets that case.

When the most specific patterns for one file tie on all three keys and belong to
different layers, `--layers` refuses rather than pick one: exit code 2, one line
naming the file and both patterns, and no census or violations. Make one of the
patterns more specific. A tie inside one layer cannot change the answer and is not
refused, and equally specific patterns that never claim a common file, like
`apps/web` and `apps/cli`, never tie.

Paths not named are **outside the lattice**. Their edges are counted `unlayered`
and never judged — the coverage gap is a number in every report, not a silence. A
package consumed from two non-adjacent layers, like a shared UI kit, is often
better left undeclared than declared into findings it cannot fix.

### The edge set, and why it is imports

`--layers` reads **module specifiers** — static imports, `export … from`, and
dynamic `import()` — from the parser's own import list, on the **cheap pass**. No
type-checker, no Graph. That is deliberate: the type-aware `--deep`
pass does not finish on this repo in a usable time, and a gate that cannot be run
over the whole architecture is not a gate on the architecture. An import is also
what the rule is about ("apps/web must not reach into the engine") and it carries
an exact line, which a resolved call does not.

A `.d.ts`, `.json` or `.css` target is still an edge and is still judged; a
relative specifier that names no file on disk is reported as **UNRESOLVED**, by
name, so a systematic resolver bug shows up as a pattern rather than as
acceptable noise.

A bare specifier that is neither relative nor a workspace package name goes
through the importing file's **nearest `tsconfig.json`**, `extends` followed, by
the same native resolver the edge pass uses. Reading a tsconfig this way starts no
type-checker, so the gate stays on the cheap pass. A tsconfig `paths` alias such
as `@app/*` that lands on a file inside the repo is judged exactly like a relative
import. An alias that matches a `paths` key but names no file on disk is
**UNRESOLVED**, listed like a broken relative import. Everything else that does
not resolve into the repo — an npm dependency, installed or not, a node builtin,
a `cloudflare:` scheme import — stays `external`.

### The allowlist is a ratchet, in both directions

The `allowed` array declares the upward edges that exist **today**, each with its
exact site count and the concrete move that closes it. `--layers` exits non-zero on
any of three disagreements:

- an **undeclared** violation — new drift cannot land;
- a **stale** entry that no longer violates — a closed violation cannot keep its
  excuse, which is the direction that stops this becoming a baseline file;
- a **miscounted** entry — a new import on a known-bad pair is still new drift,
  and a removed one is still progress.

It is therefore green on arrival and cannot silently tolerate. The same shape
`tools/fitness`'s `KNOWN_GAPS` lists use.

### Not wired into CI, and why

Nothing in `.github/` runs this. Whether it earns the merge path is a decision for
the founder, and this repo's alarm-rationalization rule is explicit that a check
needs a named failure that actually reached `main` or `prod` plus a response the
person who sees it red can take.

**Recommendation: `promote.yml`, not `pr.yml`.** The run is ~60s over 2114 files
at repo scale — 30× a day on the merge path buys ~30 minutes of runner time a day
to guard a boundary that moves a few times a month. On the promotion PR it costs
once per promotion, catches the same drift before it reaches `prod`, and the
response ("point the dependency down, or declare it") is one a promoting human can
actually take. It cannot live in a pre-commit hook: the gate needs the whole repo
loaded, and a hook that reads 2114 files is a hook people disable.

## The boundary ledger (`--boundaries --ci`)

`boundary-ledger.json` at the repo root names every boundary crossing a declared scope still
carries: one entry per crossing import (B1-B4, B6, B8, B12 and B14 between libraries, and B19
between workspaces), per world-door use (B5, B7, B9, a door used by name in `rules/`, B13, a pure
library's door or world library, and B17, a worker binding used outside a driven adapter), and per
entry no rule places (B10, a feature's entry in no zone, B11, a package under a library root that
no library names, and B18, a loop of workers that bind each other):

```json
{
  "entries": [
    {
      "scope": "apps/web",
      "kind": "cross-feature",
      "from": "apps/web/src/billing/flows/charge.ts",
      "to": "apps/web/src/users/store/db.ts",
      "specifier": "../../users/store/db.js",
      "reason": "until users exports a reader"
    }
  ]
}
```

`kind` is the rule (`cross-feature` B1, `impure-rules` B2, `lib-imports-feature` B3,
`outside-imports-feature-internal` B4, `door-outside-owner` B5, and for a
[hexagonal](#hexagonal-features-layout) scope `application-imports-adapter` B6,
`impure-application` B7, `driving-reaches-driven` B8, `door-outside-driven-adapter` B9,
`unknown-zone` B10, and for [libraries](#library-types-librarytypes) `library-undeclared` B11,
`library-imports-up` B12, `impure-library` B13, `adapter-library-imported-outside-driven` B14, and
for [deployables](#across-deployables-acrossdeployables) `binding-outside-driven-adapter` B17,
`worker-call-cycle` B18, `relative-import-crosses-workspace` B19),
`from` the importer and `to` the target, both repo-relative. `to` is `null` for a B2 bare import,
where the specifier is the target, for a world door (`door-outside-owner`, `impure-application`,
`door-outside-driven-adapter`, `impure-library`, or `impure-rules` with `"global": true`), where
the specifier is the door's name, for a world library (`impure-library`), where it is the library
as the import wrote it, for a worker binding (`binding-outside-driven-adapter`), where the
specifier is the binding's name in the worker's config, for `unknown-zone`, where `from` is the
entry's path and the specifier the entry below its feature, for `library-undeclared`, where `from`
is the package's directory and the specifier that directory below its library root, and for
`worker-call-cycle`, where `from` is the workers of the loop and the specifier the edges between
them. `to` is a library's directory, not a file, for B12 and B14: the import resolves to a
package; and it is a workspace's directory for B19. An entry's identity is `(scope, kind, from, to ??
specifier)`, plus `global`: the `specifier` as written is display only for a file target, so two
imports of one target from one file are one entry, and a move that rewrites a relative specifier
keeps its entry. `global` is what keeps a global `fetch` and a bare `import "fetch"` (the npm
package) from one rules file two entries, not one; it is only ever `true`, and only on an
`impure-rules` entry with a null `to`. `reason` is optional. The file is written sorted with
sorted keys, so a diff shows exactly which crossings came and went. A release before the library
kinds, or before the deployable kinds, refuses a ledger that holds them, so upgrade the tool before
committing one.

A count could not tell "one crossing fixed, a different one added" from "nothing changed". The
ledger can, and it moves one way on its own:

| Run | What it does |
|---|---|
| `--boundaries --ci` | **Exits 1** when a measured crossing has no entry, listing each one (scope, rule, importer, target, specifier). Never fails because an entry has no crossing: it rewrites the ledger without those entries and prints what it pruned. Entries for scopes outside the analyzed path are left alone |
| `--boundaries --accept-crossings --reason "<why>"` | Adds every crossing the ledger does not name yet, each carrying the reason. Without a non-empty `--reason` it exits 2 and writes nothing. This is the only way the ledger grows |
| `--boundaries --migrate-ceilings` | One-time move off `boundary-ceilings.json`, below |

Pruning is how the gate tightens, the way [Betterer](https://phenomnomnominal.github.io/betterer/)
writes improvements back to its results file and fails only on regressions: commit the rewritten
ledger with the fix that removed the crossing. `--boundaries --write-ceilings` exits 2 naming
`--accept-crossings`; `--comments` and `--collapse` keep their `--write-ceilings`.

### World doors (`doors`)

A fact read from the outside world (an env var, the terminal, the clock, a credentials file)
drifts once more than one file reads it. A **door** is one way a file reaches out, and one
catalog names them all. A boundary rules file declares, per scope that declares `features`, which
files may open each door:

```json
{
  "features": { "packages/app": ["billing", "users"] },
  "doors": {
    "packages/app": {
      "process.env": ["src/env.ts"],
      "process.stdin.isTTY": ["src/terminal.ts"],
      "node:fs": ["src/credentials.ts"]
    }
  }
}
```

Owners are exact scope-relative files, never a folder. The catalog, one row per door:

| Door | One use is |
|---|---|
| `process.<member>` | any runtime reference to a static member of `process`, and each member is its own door (`process.env`, `process.hrtime`, `process.platform`, `process.on`, `process.versions`, …): `process.env.X`, `process["env"].X`, `process.env[k]`, `const { env } = process`, `process?.on?.("exit", f)`, a spread, an argument. `process.hrtime()` and `process.hrtime.bigint()` are two reads of one door, `process.hrtime`. A bare `process`, `process[k]` and `const p = process` name no member, so they are no use |
| `Date.now`, `Math.random`, `crypto.randomUUID`, `crypto.getRandomValues`, `performance.now` | any runtime reference |
| `new Date()` | `new Date` with no argument (`new Date(x)` and `Date.parse` are pure) |
| `fetch`, `setTimeout`, `setInterval`, `globalThis` | any runtime reference |
| `console` | any `console.*` reference |
| `node:fs`, `node:child_process` | a runtime import of the module or a subpath, with or without `node:` (`fs`, `node:fs/promises`). A type-only import opens nothing, in every spelling: `import type`, `import { type Stats }`, `export type { … } from`, `export { type Stats } from`, `import type x = require()`, and `import("node:fs").Stats` or `typeof import("node:fs")` in a type. A file that names the types and also imports the module opens it once |

A declaration names one door: a member of `process` (`process.platform`), or a deeper static path
under a door (`process.stdin.isTTY` under `process.stdin`, `process.hrtime.bigint` under
`process.hrtime`); a use belongs to the most specific declared door that is a path prefix of it.
The bare `process` is the whole family, not a door, and is refused. A chain rooted at `globalThis`
is read without that root: `globalThis.process.env.CI` is a use of `process.env` and of
`globalThis`.

Not a use: a type position (`typeof process.env`), a type-only import (above), and a name the file
binds itself (an import, a declaration or a parameter), so an injected `fetch` parameter is the
pure pattern. That check is per file, not per scope, and fails open on a file that rebinds a name in
one function and uses the real one in another. Nothing follows data flow: `const p = process`,
`import process from "node:process"` and `require()` are not tracked.

Two checks read the one catalog, and in a [hexagonal](#hexagonal-features-layout) scope two more
(B7 and B9):

- **B5 `door-outside-owner`**: a use of a declared door in a file that is not one of its owners,
  anywhere in the scope (a feature, `lib/` or the rest of `src/`). A door nobody declared is not
  policed outside `rules/`.
- **B2 `impure-rules`** on globals: inside `src/<feature>/rules/**` every use of any catalog door,
  declared or not, is one entry. A `rules/` zone is where no door has an owner, so a use there is
  reported once, as B2, never also as B5; a door module imported there is the edge B2 already
  reports, a type-only import of it included, tagged `[type-only]` for `import type`.

Adopting a door is declare, seed, shrink, empty: declare it, record today's uses with
`--accept-crossings --reason "<why>"`, remove them PR by PR (the next `--ci` prunes each), until the
ledger holds none. An entry is one file per door: a file already ledgered for `process.env` stays
one entry however many reads it holds, so a new `process.env.NEW` in it passes `--ci`, and
`process.hrtime()` beside `process.hrtime.bigint()` is one entry, `process.hrtime`. The ledger
names which files still depend on a door, not how often, so an edit to a ledgered file never churns
it. A bad declaration exits 2 naming the problem and writing nothing: a door outside the catalog
(a typo like `Math.randm` would silently enforce nothing), the bare `process`, a member the
running `process` does not have, a scope that does not declare `features`, an owner that names no
file the scope loads, or an owner under `src/<feature>/rules/` (in a hexagonal scope, an owner in a
zone that reports every door, below).

A member of `process` is judged against the running `process`, so the family stays one catalog row
and no list of members is kept here. The names are read once, off the process that runs the CLI, by
name only (reading `process.stdin` would open a stream), and every one counts, inherited
EventEmitter methods such as `process.on` included. Which members that process has depends on the
Node version, the platform and how it was launched: `process.getuid` is POSIX-only, and
`process.send` exists only when the process has an IPC channel. A typo such as `process.envv` exits
2 naming the door, the Node version and platform that judged it and the nearest member that process
has (`process.env`), compared without case and tie-broken by name, and a member with nothing near is
refused without a guess. The same refusal tells a team on more than one host why a door passes on
one and fails on another: `door "process.getuid" in "packages/app" is not a member of process on
Node v22.1.0 (win32).` names the host that refused. The CLI does not read the launch mode, so a
`process.send` refused for want of an IPC channel reads the same way, as a member that host lacks.
The check ends at the member. What lies below one is the runtime's, not Node's static shape:
`process.stdin.isTTY` is not a property at all when stdin is a pipe, and `process.env` holds
whatever keys the shell gave it, so the segments after the member are checked only as identifiers.

### Hexagonal features (`layout`)

A scope lays its features out one of two ways, and the `layout` key picks which, one scope at a
time. A scope it does not name keeps the `rules/` layout above (`index.ts` the front door, `rules/`
the pure zone, everything else internal), so adopting the other layout moves one scope and leaves
the rest of the repo, its ledger entries included, as it was:

```json
{
  "features": { "services/api": ["billing", "orders"], "services/legacy": ["cart"] },
  "layout": { "services/api": "hexagonal" },
  "doors": { "services/api": { "fetch": ["src/billing/adapters/driven/stripe.ts"] } }
}
```

A `hexagonal` feature follows Alistair Cockburn's zones, read from each file's path below
`src/<feature>/`:

```
src/<feature>/
  index.ts             index: the feature's driving ports, the only file another feature imports
  ports.ts             ports: the driving and driven port types
  application/         application: the use cases
  adapters/driving/    driving: what calls in (HTTP, RPC, cron, tests)
  adapters/driven/     driven: what the feature calls out to, the only zone that opens a door
```

Any other entry is in no zone: a top-level entry other than these (`domain/`, `helpers.ts`,
`rules/`, a colocated `billing.test.ts`) and any entry under `adapters/` other than `driving/` and
`driven/` (`adapters/shared/`, `adapters/http.ts`). Only loaded source files count, so a folder
holding no `.ts`/`.tsx` file is invisible. B1 and B3 judge a hexagonal scope as they judge any
other. B2 never fires, because a hexagonal feature has no `rules/` zone. B4 has one exception, the
composition root below. B7 and B9 take B5's place in `application/`, `index.ts`, `ports.ts` and
`adapters/driving/`, so B5 judges only the rest of the scope (which rule claims a door, below).
Five kinds judge inside its features:

| Rule | Kind | Fires on | Allowed |
|---|---|---|---|
| B6 | `application-imports-adapter` | an `application/` file importing a file under its own feature's `adapters/` | its own `ports.ts`, `index.ts` and `application/`, another feature's `index.ts`, `lib`, bare packages. Another feature's `adapters/` is B1 alone |
| B7 | `impure-application` | an `application/` file using any catalog door by name or opening a module door (`node:fs`), declared or not, one entry per file per door | nothing: a use case reaches the world through a port |
| B8 | `driving-reaches-driven` | an `adapters/driving/` file importing its own feature's `application/` or `adapters/driven/` | its own `ports.ts` and `index.ts`, sibling driving files, `lib`, bare packages |
| B9 | `door-outside-driven-adapter` | a declared door used or opened in `index.ts`, `ports.ts` or `adapters/driving/`, one entry per file per door | an undeclared door (`console` in a driving adapter is clean) |
| B10 | `unknown-zone` | an entry of a feature in no zone, one entry per entry however many files sit under it: `from` is the entry's path (`services/api/src/billing/domain`) and the specifier the entry (`domain`) | the five zones. Files inside the entry are otherwise judged as `rules/`-layout internal files |

**The composition root.** A file outside every feature and outside `lib` (Cockburn's
configurator, the worker's wiring file) may import any feature's `adapters/driving/` and
`adapters/driven/`. Importing its `application/` or `ports.ts` stays B4, and `lib` importing any
of it stays B3.

**Which rule claims a door.** B7 claims every door used in `application/` and B9 every declared door
used in `index.ts`, `ports.ts` and `adapters/driving/`; B5 does not also fire there, as B2 replaces
it inside `rules/`. In `adapters/driven/`, in an entry in no zone, and outside every feature, a
declared door is B5's against its owners as before, so the owner list still says which driven
adapter opens it.

A bad declaration exits 2 with one line and writes nothing: a `layout` for a scope that declares no
`features`, a value other than `rules` or `hexagonal`, and a door owner in a hexagonal feature's
`index.ts`, `ports.ts`, `application/` or `adapters/driving/`, where the door could only be
reported. An owner under `adapters/driven/` or outside every feature is accepted.

### Library types (`libraryTypes`)

Features are judged inside one scope. A repo whose packages are libraries of declared types
(contract, kernel, util, adapter, ui) has rules between its packages too: which type may import
which, which libraries stay pure, and where an adapter library may be imported from. The rules file
declares the types and the libraries, and four rules judge them. The type names are yours: nothing
here knows `contract` from `ui`.

```json
{
  "libraryTypes": {
    "contract": { "imports": ["contract", "util"], "pure": true },
    "kernel":   { "imports": ["kernel", "contract", "util"], "pure": true },
    "util":     { "imports": ["util"], "pure": true },
    "adapter":  { "imports": ["contract", "kernel", "util"], "pure": false, "importedFrom": ["driven"] },
    "ui":       { "imports": ["ui", "contract", "kernel", "util"], "pure": true }
  },
  "libraryRoots": ["packages"],
  "libraries": { "packages/orders-contract": "contract", "packages/clock-adapter": "adapter" },
  "worldLibraries": ["drizzle-orm", "hono", "@sentry/*"]
}
```

- `libraryTypes`: each type names the types it may import (`imports`: a type imports its own only
  when it lists itself), whether it is `pure`, and optionally where a library of it may be imported
  from (`importedFrom`: `driven`, a hexagonal feature's `adapters/driven/`; `configurator`, a file
  outside every feature; `any`, anywhere; a type that names none is imported from anywhere).
- `libraries`: a package's repo-relative directory, which must hold a `package.json`, to its type.
  A library is a scope named by its directory, so it takes a ledger scope, a place in the report
  and a run pointed at it like a feature scope does.
- `libraryRoots`: the directories whose packages must each appear in `libraries`.
- `worldLibraries`: the packages a pure library may not import, each a glob as in the
  [entrypoint-export conventions](#entrypoint-export-conventions), where `*` stays within one
  segment of the name. An entry names a package and matches it with its subpaths: `@sentry/*`
  matches `@sentry/node` and `@sentry/node/integrations`, never `@sentryx/node`.

A specifier names a library **by package name**: a bare specifier, or a subpath of one
(`@shop/pkg/sub`, `pkg/sub`), resolves to the workspace package of that name, from the `name` in its
`package.json`, never through the package's `exports` and never through tsgo. A relative import
that crosses into another package is not judged here: that is B19, once
[`acrossDeployables`](#across-deployables-acrossdeployables) lists it.

| Rule | Kind | Fires on | Allowed |
|---|---|---|---|
| B11 | `library-undeclared` | a package at any depth under a `libraryRoots` entry that `libraries` does not name, one entry per package: the scope is the root, `from` the package's directory, the specifier that directory below the root (the nearest root, when roots nest) | a declared library, and a package outside every root. A library declared but outside every root is judged by B12-B14 and never by B11 |
| B12 | `library-imports-up` | an import from a library to another declared library whose type is not in the importer's `imports`, one entry per importer file and library however many specifiers or subpaths it writes; `to` is the target library's directory | an allowed type, the importer's own package name, an undeclared workspace package (counted, not judged), a package that is no workspace, a relative import. Type-only imports are judged and print `[type-only]`, when every import of that library is |
| B13 | `impure-library` | in a library of a `pure: true` type, any catalog door used by name or opened as a module (`node:fs`), one entry per file per door, and any import of a `worldLibraries` specifier in any spelling (value, type-only, `export from`, dynamic), one entry per file per specifier as written | a type-only import of a module door, a name the file binds itself, and every use in a library whose type is not pure |
| B14 | `adapter-library-imported-outside-driven` | an import of a library whose type declares `importedFrom`, from a file outside those zones, one entry per importer file and library; `to` is the target library's directory | the listed zones. A hexagonal feature's `application/`, `adapters/driving/`, `index.ts` and `ports.ts`, and any feature file of a scope with the `rules/` layout, are in none of them |

A library's import of another library is **one verdict**: B12 when its type's `imports` forbids the
target, and only otherwise B14 when the target names where it may be imported from. A library's own
files sit outside every feature, so for B14 they are `configurator` files: a type that imports an
adapter library lists `configurator` in that library's `importedFrom` to allow it. B14 judges every
file of every scope the pass reads, a feature scope's and a library's; a package that is neither a
library nor a feature scope is not read. Where libraries nest, a file belongs to the nearest
declared library and is judged in its scope alone.

**Not `--layers`.** `--layers` takes a stack, one total order in which a layer may import what is
below it. Library types are a table of allowed imports per type: `adapter` and `ui` are siblings
that import neither each other nor `kernel` upward, which no total order can say.

**What B13 cannot see.** A pure library is judged by the doors it names: `Date.now()`,
`process.env`, `import "node:fs"`. A call on an object it was handed (`deps.clock.now()`) names no
door, so it is clean, which is the pattern a pure library should use. B13 also judges test files,
as the pass loads and judges every file.

A bad declaration exits 2 with one line and writes nothing: a type used in `libraries` that
`libraryTypes` lacks, a type listed in an `imports` that it lacks, an `importedFrom` zone outside
`driven`, `configurator` and `any` (or an empty list), a `libraries` path that is no package root, a
`libraryRoots` entry that is no directory (written as a clean repo-relative path), a `worldLibraries`
entry that is not a glob or that matches a catalog door (`fetch`, `console`, `node:fs`: a package and
a door of one name would share one ledger entry), and any other key: `pureDependencies` is not
accepted.

`--boundaries` over a rules file that declares libraries ends its report with a census: the
libraries per type (a declared type nobody uses is listed with none), the undeclared packages, and
the count of imports left unjudged (an import from a library of a workspace package no library
names, once per importing file and package), over the scopes the run measured: pointed at one
library, it lists that library. `--json` carries it as `libraries`:
`{ "types": { "<type>": ["<directory>", …] }, "undeclared": ["<directory>", …],
"unjudgedImports": <n> }`. A rules file with none of the four keys prints no census and no key,
and is judged exactly as before.

Adopting the layout is declare, seed, shrink, empty, as for doors: declare the types and the
libraries, record today's crossings with `--accept-crossings --reason "<why>"`, fix them PR by PR
(each `--ci` prunes one), until the ledger holds none. A run pointed at one library measures that
library; at a library root or the repo root, every library under it. A rules file that declares
libraries and no `features` is judged all the same. The run lists the repo's files once and each
scope reads its own from that list, so a repo of dozens of libraries costs one listing, not one per
library. It is the cheap pass: oxc for imports and syntax, never tsgo.

### Across deployables (`acrossDeployables`)

A repo of several workers and shared packages has three rules left that a review holds alone: a
worker binding (another worker, a database, a bucket, a queue) used from a use case, two workers
that call each other in a loop, and a relative import that walks out of one package into another.
`acrossDeployables` turns each on, by name. **A kind the rules file does not list does not run**, so
a release that adds a kind never fails the merge gate of a repo that did not ask for it, and a rules
file that lists none is judged, reported and written exactly as before: no wrangler config is read,
and `--json` gains no key.

```json
{
  "features": { "services/api": ["orders", "billing"] },
  "layout": { "services/api": "hexagonal" },
  "acrossDeployables": [
    "binding-outside-driven-adapter",
    "worker-call-cycle",
    "relative-import-crosses-workspace"
  ],
  "bindingOwners": { "services/api": { "DB": ["src/orders/adapters/driven/orders-db.ts"] } }
}
```

- `acrossDeployables`: the kinds that run, any of the three names below, none by default.
- `bindingOwners`: optional, B17 only. Per scope, a binding narrowed to exact scope-relative files,
  as `doors` does. It narrows within the driven adapters and never exempts a file from them: with an
  owner list, a binding is clean only in a listed file that is also under a feature's
  `adapters/driven/`.

| Rule | Kind | Fires on | Allowed |
|---|---|---|---|
| B17 | `binding-outside-driven-adapter` | a reference to a binding the owning worker's deploy config declares (a service binding, or a D1, Durable Object, KV, R2 or queue binding), in a file of a judged scope that is not under a hexagonal feature's `adapters/driven/`, one entry per file per binding: `from` is the file and the specifier the binding's name in the config (`DB`) | a driven adapter, and with `bindingOwners` a listed one. A Workflow binding, a var, a name the config does not declare and a binding of another worker are not judged |
| B18 | `worker-call-cycle` | a strongly connected component of two or more workers over the service-binding graph the wrangler configs declare, one entry per component: the scope is `.`, `from` the workers sorted and joined with `, `, and the specifier the edges inside the component, each written `<worker>.<BINDING> -> <worker>`, sorted and joined with `; ` | a one-way chain, a worker that binds itself, a service binding to a worker with no config in the repo (counted, not an edge), a Durable Object or Workflow binding with a `script_name` (not an edge) |
| B19 | `relative-import-crosses-workspace` | a relative import (`./x`, `../x`, `.`, `..`; static, `export … from`, dynamic and type-only) whose target path sits in another workspace than the importer's, one entry per importer and other workspace: `from` is the importer, `to` the target's workspace directory, the specifier the first one written, `[type-only]` only when every import of that workspace is | an import inside one workspace through `../`, a bare specifier and a path alias (B12 and B14 judge a bare specifier that names a declared library) |

**B17 reads syntax, not types.** It runs the call-site finder `--data` runs, on the cheap pass: a
binding read off `env`, `this.env` or `c.env` (`env.DB`, `env["DB"]`), through one level of alias
(`const db = env.DB`), through a destructure off `env` (`const { DB } = env`), or handed on whole as
an argument (`register(env.DB)`). A file is judged against the bindings of the worker that owns it,
the nearest `wrangler.json`, `wrangler.jsonc` or `wrangler.toml` above it, top-level environment
only: an `env.<name>` block of the config is not read, as `--cross-runtime` does not read it. Every
scope the pass reads is judged, a feature scope's and a declared library's; a file outside every
feature is judged too, because the rule is that only a driven adapter touches a binding, and a test
file is judged like source. **What B17 cannot see:** a binding reached through an object not named
`env` (`bindings.DB`, a context handed in), more than one level of aliasing, an `env.<name>` block
of the config, and Hyperdrive and connection use, which is not a call on a binding. A feature of a
scope laid out as `rules/` has no driven adapter, so every use in it is B17.

**B18 reads the declared graph, on purpose.** It is cheap (no type checker, where observed calls
through `--cross-runtime` take about 80 s on a services root), and a binding declared and never used is
itself drift the rule should surface. The nodes are every worker config in the repo, named by the
config's `name`, else its directory's, so a worker no scope names is still a node. A component of
two overlapping cycles (a ring with a chord, two pairs sharing a worker) is one component and so one
entry; a cycle that gains a worker or an edge is a new entry, and the old one is pruned. A cycle
belongs to no one worker, so its scope is `.`, and only a run whose analyzed path is the repo root
measures it: a run pointed at one scope leaves B18 entries as they are.

**B19 reads paths, not files.** It joins the specifier onto the importer's directory and takes the
nearest ancestor directory that holds a `package.json`, for the importer and for the target, so an
import of a path that does not exist is judged too. The repo root is a workspace only when it holds
a `package.json`; a file, or a target, in no workspace is placed in the scope root. B19 leaves a
bare specifier to the rules for libraries (B12 and B14 judge one that names a declared library), and
a path alias that lands in another workspace is out of scope: no rule judges it. Only `.ts` and `.tsx`
files are loaded, so a `.js` importer is not judged. A file under a library nested in a feature
scope is judged in the library's own scope only, as for B12-B14.

**The census.** With a kind listed, `--boundaries` ends its report with what the finder read, per
worker that holds a binding site: the sites (clean or not), the files holding them and the bindings
referenced with their site counts, and the service bindings in the repo that point at a worker with
no config in it. `--json` carries it as `deployables`:
`{ "workers": [{ "worker": "api", "files": […], "bindings": { "DB": 2, … },
"sites": [{ "file": "…", "line": 3, "binding": "DB" }, …] }], "unresolvedServiceBindings": <n> }`.
`--cross-runtime` accepts any receiver (`<receiver>.<BINDING>.<method>(...)`) and resolves it with
the type checker; the census reads only `env`, a `.env` member and one level of alias, and counts
every reference, so an alias, a destructure and a binding handed on whole are sites and not calls.
Every service-binding call `--cross-runtime` reports has a census site on the same file, line and
binding, and the census may hold more. The B18 scope lists the workers it read.

A bad declaration exits 2 with one line and writes nothing: a kind outside the three, `bindingOwners`
while `binding-outside-driven-adapter` is not listed, a `bindingOwners` scope that declares no
`features`, an owner file the scope does not load, an owner file that is not under a feature's
`adapters/driven/`, and a binding the worker owning that file does not declare (or a file under no
worker).

A wrangler config the run cannot parse exits 2 the same way, never a silent skip: with
`binding-outside-driven-adapter` or `worker-call-cycle` listed, the report, `--ci`,
`--accept-crossings` and `--migrate-ceilings` refuse with one line naming each such file and write
nothing, because a worker whose config is not read would have its bindings unjudged and be missing
from the call graph. (`--data` and `--cross-runtime` print the same files as `UNPARSED CONFIG`.) A
rules file that lists neither kind, or only `relative-import-crosses-workspace`, is not refused for
one.

Adopting a kind is declare, seed, shrink, empty, as for doors: list it, record today's crossings
with `--accept-crossings --reason "<why>"`, fix them PR by PR (each `--ci` prunes one), until the
ledger holds none. Dropping a kind from the list stops measuring it, so the next `--ci` prunes its
entries. The run lists the repo's files once for the wrangler configs, the package roots and every
scope. It is the cheap pass: oxc for imports and syntax, a JSON parser for the configs, never tsgo.
`bench/worker-boundaries.mjs` times it on a generated repo of 14 workers and 2,000 source files.

### Migrating from `boundary-ceilings.json`

The count file this replaced stored one number per scope and no edges, so it cannot be
converted. `code-graph . --boundaries --migrate-ceilings` measures every declared scope and seeds
`boundary-ledger.json` with one entry per crossing measured now (reason
`grandfathered from boundary-ceilings.json`), then deletes `boundary-ceilings.json`. It refuses,
exit 2 and nothing written, when any scope's import crossings exceed its recorded count, because
seeding from that would loosen the gate. The legacy count measured imports only, so the migration
holds only the import crossings measured now (B1–B4, B6 and B8) against it. The world-door entries
(B5, B7, B9, and a global in `rules/`), the `unknown-zone` entries (B10) and the library entries
(B11-B14, which the count never measured: it knew no library scope) and the deployable entries
(B17-B19, which it never measured either) are seeded with the same reason and are not held against
it: a repo that predates the doors, the libraries and the deployables still migrates, and its first
`--ci` is green. Library scopes are measured like any other, so a library holding a B12 migrates
where a ceiling of 0 would refuse a B1, and so is the repo's worker call graph, scope `.`, when
`worker-call-cycle` is listed, whatever path the run is pointed at. Until it runs, `--boundaries --ci` with a
`boundary-ceilings.json` and no ledger exits 2 naming `--migrate-ceilings` rather than gate against
an empty ledger.

### Moving files: `@demlik/code-graph/boundaries`

A tool that moves files updates the ledger in the same commit, so an entry follows its importer
or target instead of reading as one crossing gone and another new:

```ts
import { rekeyBoundaryLedgerFile } from "@demlik/code-graph/boundaries";

rekeyBoundaryLedgerFile(path.join(repoRoot, "boundary-ledger.json"), [
  { from: "apps/web/src/billing/flows/charge.ts", to: "apps/web/src/billing/charge.ts" },
]);
// { kind: "rekeyed", entries: 1 }, or { kind: "absent" } / { kind: "invalid", message }
```

Moves are repo-relative file paths. Every entry whose `from` or `to` names a moved file is
re-keyed; the scope stays. That follows the importer of a B17 and a B19 entry, and leaves a B18
entry, which names workers and no file, and the workspace directory a B19 entry reaches, as they
are. Whether a moved import still crosses is the next gate run's call, and one that no longer does
is pruned there. The subpath also exports the pieces:
`BoundaryLedgerSchema`, `parseBoundaryLedger` / `readBoundaryLedger` (answering `absent`, `read`
or `invalid`), `writeBoundaryLedger` / `serializeBoundaryLedger`, `rekeyBoundaryLedger` over a
parsed ledger, `boundaryLedgerOf` (sort and dedupe), `ledgerKey`, `ledgerTargetOf` and
`LEDGER_FILENAME`.

## Collapse candidates (`--collapse`)

A candidate **generator**, not a detector, and the division of labour is the whole
design: the graph narrows thousands of functions to a ranked shortlist and is
allowed to **over-produce**; a human or a model judges what survives. Getting that
backwards is the usual way this fails — a precise cheap filter misses the real
duplicates, and precision is not this stage's job.

**The whole-function half is a report, never a gate.** Reachability is a fact and
belongs in CI; similarity is a judgment and belongs in a document read once.
`createProject` in kontrol and `createProject` in auditer are legitimately different
layers, and name similarity will pair them every single run. Mixing the two
lifecycles is how a check becomes one people skip, so `--ci` gates none of it.

**Partial twins are the half that gates** — see below. They are a different kind of
claim: not "these look alike" but "these two share one decision and disagree about
its outcome", which is either intended and stated in the PR body, or a defect.

### Four signals, N-of-4

| Signal | Fires when |
|---|---|
| `shape` | near-identical loc, complexity and nesting depth (loc tolerance is proportional) |
| `callees` | Jaccard over what each calls clears `calleeJaccard` — same downstream set, different words |
| `callers` | Jaccard over who calls each clears `callerJaccard` — two alternatives that should be one |
| `name` | overlap coefficient over stemmed, stopworded name tokens clears `nameOverlap` |

No single signal is sufficient; `minSignals` of the four must fire (default 2).
`minSignals` is schema-floored at **2**, and that is load-bearing rather than taste.
The generator does not compare every pair — it blocks on the callee, caller and
name-token inverted indexes and scores only pairs sharing an entry. That search is
**exhaustive exactly while a qualifying pair must fire at least one non-shape
signal**, i.e. while `minSignals >= 2`. Allowing 1 would turn a complete search into
a silently partial one, so the schema refuses it.

The one recall loss is a blocking key with more than `maxBlockSize` members
(`get`-shaped tokens, a callee everything calls). Those are **reported by kind, key
and size** — the blind spot is a number on the screen, like every other view here.

### The ranking is the point

    rank = confidence / collapse_cost

`confidence` is the fired signals' strengths summed over the four possible signals.
`collapse_cost` is read off the graph and is `>= 1` always:

| Cost input | Why |
|---|---|
| union of both call sites (log2) | how many places a merge must re-point |
| packages those call sites span | a merge that touches five packages is five reviews |
| the two definitions cross a package boundary | at a `services` root that makes it a **contract** change, not a refactor |
| either side is on a path that reaches an `effect` node | a DB write / network call / VM spawn downstream is riskier to touch |

Sorted by similarity alone, the two 400-line cross-service handlers sit at the top
and nobody finishes the first item. Sorted by ratio, someone works down the list and
quits whenever, and what they did was the highest-value subset available. **Stopping
early still captures the best ratio** — that anti-paralysis property is the entire
value, and it is why the cost half exists.

### Cliques, not chains

`smells/rules.ts` holds ten structurally identical `evaluate` closures. As pairs that
is one observation repeated 33 times, and it filled 9 of the top 10 rows on the first
real run. Findings are therefore grouped, and the grouping is **complete linkage**: a
cluster is a clique — every member pairs with every other member. Single linkage (a
union-find over the pairs) was tried first and chained 44 unrelated small functions
into one blob, because `a~b` and `b~c` says nothing about `a~c`. The representative
is the clique's best-ranked pair, so the stop-early property survives the grouping.

Every finding ships its evidence: which signals fired with their strengths and
details, both `file:line`s, the computed cost and each input that produced it. A
ranking nobody can audit is a ranking nobody trusts.

### Partial twins — a shared decision, two outcomes

The four signals above compare functions **as wholes**, and that is blind exactly
where duplication costs the most. #5279 was two functions in `audit-agents` that
shared a resume decision — the same counter, the same three tuning constants — and
then diverged: one finalized the run `failed` with no result, the other salvaged the
checkpoint. Which report a customer received depended on which path spent the last
retry. As whole functions they are nothing alike (27 loc / cx 2 against 74 loc /
cx 16), so `shape` was near zero, the callee Jaccard washed out, and the pair never
cleared `minSignals`. A full twin is redundant code, usually harmless. A partial twin
is a shared decision with divergent outcomes, and the divergence is where the defect
lives.

So the ordered call sequence is scored as well, and a pair is reported when all three
hold:

| Requirement | Setting |
|---|---|
| a contiguous run of identically-ordered callees, anywhere in either function | `partialMinPrefix` (3) |
| the run's call sites pass the same **named constant** in both | `partialMinSharedConstants` (1) |
| the next call after the run exists in both and differs | — |

The run is found by shingling every window of `partialMinPrefix` callees into an
inverted index and extending each hit both ways, so it is the longest common
contiguous run, not just a common opening — #5279's shared block sits in the middle
of the longer function, and a prefix-only rule misses it.

The named-constant requirement is what keeps this quiet, and it is narrow on purpose:
a **named constant** is a module-scope binding in the calling file whose name is also
declared, somewhere in the loaded set, as a `const` with a literal initializer. A
helper arrow passed to `.map()` is not one; a namespace import is not one. Without
that filter `services/auditer` reported 1319 pairs (every drizzle query shares a long
call block); with it, 1.

Containment is not divergence: when one function's run reaches its end, nothing is
reported — that is one function inlined in another, which is the whole-function
scorer's business.

### The ratchet (`--collapse --ci`)

`collapse-ceilings.json` records a partial-twin count per scope and is the **only**
place the governed scopes are named — `scripts/gate.sh` runs one command at the repo
root and the file decides what it checks. It fails both ways, like the comment
ratchet: above a ceiling a new twin arrived, below one a twin was fixed and the
ceiling stopped being a ceiling. `code-graph <scope> --collapse --write-ceilings`
re-records one scope without touching the others.

It runs **warn-only** in the gate today.

### Same architecture, second target (not built)

Fields, not functions: similar names + same type across related tables, ranked by
read sites. That is the duplicate-representation detector the schema-level work
needs, and it reuses this file's shape — signals, N-of-N, cost-weighted ranking —
against columns instead of functions.

## Cluster vs directory mismatch (`--clusters`)

**Does the file layout match how the code actually clusters?** Community detection runs
over the file-level call + import graph — cross-runtime edges included, which is why the
flag implies them: without those the graph stops at each worker boundary and the
partition splits along it, confirming the layout by construction. The resulting
communities are then compared against the directory tree, from both sides:

- **Directories spanning several clusters** — one name covering more than one thing.
- **Clusters scattered across directories** — one thing nobody has named yet.

Every row names the files and the cluster they actually belong to. Where the two
disagree, the layout is *lying about the architecture*; that is the mechanical cause of
"things are in surprising places," and it says where a split or a merge would follow the
grain instead of fighting it.

This is a **report, never a gate**. A cluster boundary is a heuristic, and no build
should go red because a greedy optimizer drew a line one file to the left.

### Louvain, made a pure function — no seed to pass, none to forget

The published Louvain algorithm contains **no randomness at all**: it is greedy
modularity optimization plus graph aggregation, repeated. Every implementation that is
nondeterministic is so for exactly two reasons, and both are implementation choices:
the order nodes are visited in the local-moving phase (igraph, networkx and the original
C++ all shuffle it from an RNG), and the tie-break when two candidate communities offer
the same gain. Both are pinned here:

| Source of nondeterminism | What this implementation does |
|---|---|
| Node visit order | Weighted degree **descending**, ties by node id ascending |
| Equal-gain tie-break | Stay put first, then lowest community id (candidates walked in sorted order, incumbent must be beaten strictly) |
| Float noise deciding a move | A gain must clear the incumbent by `1e-12` |
| Sum order in the modularity total | Communities summed in sorted id order |
| Termination | Bounded passes per level and levels per run |

Visit order is **not** id-ascending, and that is load-bearing: at file granularity the id
IS the path, so walking in path order visits each directory contiguously and biases the
partition toward agreeing with the directory tree — precisely the hypothesis this
instrument exists to test. Degree order is independent of the layout, and is the standard
heuristic for stabilising Louvain besides.

**Label propagation was the alternative and is rejected.** Its asynchronous update rule
is order-dependent *by design* — that is where its quality comes from — so pinning the
order changes what it computes rather than merely how it computes it; and on a graph as
sparse as this repo's it degenerates into one giant label plus a dust of singletons.

`src/query/clusters.test.ts` asserts the partition serializes byte-identically when run
twice on the same input, through the real tool on real code, and separately that the
result does not depend on the caller's input array order — a regression the re-run test
alone cannot see.

### What is excluded, and counted

- **Test files** are not nodes. A test clusters with its subject by construction, so
  leaving them in adds one predictable edge per source file and dilutes every finding.
  `excludedTestFileCount` says how many.
- **Files with no modelled edge** are held out of the partition rather than becoming
  singleton clusters — otherwise a directory of ten unconnected files reports as
  "spans ten clusters", the degenerate row that would make the report unreadable on a
  graph with no fat middle. `isolatedFileCount` says how many, and each split directory
  lists its own under `isolatedFiles`.
- **Type-only imports** are already excluded upstream by `valueEdges`: erased at runtime,
  so they couple nothing.

The human view truncates on both axes (rows per table, files per group) and says what it
hid; `--json` always carries the full lists.

## Churn × complexity hotspots (`--hotspots`)

"Where should effort go" answered from evidence: join `git log` (how often a file
changed) with the graph's own complexity metric (how gnarly it is), rank by the
product. This is standard hotspot analysis — where those two numbers are both high,
defects concentrate; the graph already computes complexity per function, so churn
is the one thing this pass leaves the source tree to ask `git` for.

Complexity is the **sum** of `FunctionNode.complexity` over every function in the
file (a cheap-pass value — `--hotspots` never forces the edge pass). Churn is the
count of commits that touched the file inside the stated window. Both raw numbers
stay on every row; the ranking score is their product, never shown alone.

**The window is always stated and pinnable.** `--hotspots-days <n>` (default 90)
sets `[now − n days, now]`; `--hotspots-since <iso>` pins an explicit ISO start
instead — the reproducibility path, since git history (and "now") drifts between
runs even when nothing in the repo does. The resolved window plus the repo's
current `HEAD` sha are echoed in every report so a reader knows exactly what was
measured. `--hotspots-limit <n>` caps the human view (default 20); `--json` emits
every row.

Two git calls, both scoped with `-- <pathspec>` to the analyzed root so a
package-scoped run doesn't pay for the whole monorepo's history: `git ls-files`
(what git tracks right now) and `git log --since --until --name-only` (commits per
file in the window). A file the graph loaded that `git ls-files` never named is
new/untracked — its churn (and therefore its score) is `null`, not a measured
zero, and it is still reported, split out under "no git history" rather than
silently dropped. A tracked file simply absent from the window's commits is a real
`0`.

Generated/vendored paths need no separate exclusion here: `--hotspots` only ranks
files already in the graph's module set, which the cheap-pass loader (`project.ts`)
already excludes from (`node_modules`, `dist`, `.next`, `__generated__`, `*.gen.ts`,
`*.d.ts`) — lockfiles and snapshot JSON never enter the graph at all, since it only
parses `.ts`/`.tsx`.

## Interface width (`--interface-width`) — NOT `--unreachable`

Two different questions look similar and are not:

- **`--unreachable`** asks "can any entry point reach this **at all**", over the
  wide edge set (calls + references + dynamic dispatch). An export with plenty
  of callers **inside its own package** is never a finding there — reachability
  doesn't care who is calling.
- **`--interface-width`** asks "is this export part of the package's **contract
  with the outside world**". It counts consumers **outside the declaring
  package** for every exported symbol. An export can be called from ten sites in
  its own package and still have zero external consumers — that export is a
  free deletion here, and `--unreachable` will never flag it, because it *is*
  reached (from inside).

Run `--unreachable` to ask "is this code dead". Run `--interface-width` to ask
"does this package's public surface match what it actually needs to expose" —
narrowing exports is the cheapest coupling reduction available, because every
export is a promise to callers that do not exist yet.

The declaring package is the same package.json boundary `--edges`' coupling
smells use (`discoverPackageRoots`, over the analyzed root) — **not** the
package's `exports`/`bin`-declared surface `--unreachable` reads from
`package.json` (`publicExportPatterns`). Those answer different questions: one
is "what directory owns this file", the other is "what did this package's
manifest promise to publish". `--interface-width` counts every function-level
export, whether or not it is re-exported through a package's declared surface —
narrowing what a package publishes starts from every export, not only the ones
already on the manifest.

Consumer detection reuses `identifierFiles` — the same textual occurrence index
`--unreachable` uses as its last, most conservative veto. A name collision
between two same-named exports in different packages can credit a false
consumer to an export; that is the SAFE direction here, since it can only
shrink the zero-consumer "free deletion" list, never grow it with a false
positive.

## Determinism

Unchanged and non-negotiable: every array sorted by a total order and deduped, JSON
keys sorted, same input → same bytes. The two parsers added for the wrangler catalog
(`jsonc-parser`, `smol-toml`) are pure and deterministic; nothing here is randomized —
including the community detection behind `--clusters`, which is pinned rather than
seeded (see above). `--hotspots` is the one exception worth naming explicitly: its output is
byte-identical for the SAME repo state and the SAME window (pin `--hotspots-since`
for that), but `git log` itself is not a pure function of the source tree — history
changes as commits land, so an un-pinned `--hotspots-days` run legitimately differs
from one taken later even against unchanged code.

`--boundaries` gives the same ledger and report on every host. Only the verdict on a declared
`process` member can differ by host, because the member set is the running process's, so it depends
on the Node version (`process.loadEnvFile` before Node 20.12), the platform (`process.getuid` is
POSIX-only) and the launch mode (`process.send` needs an IPC channel). A host that lacks a declared
member refuses it with a message naming its Node version and platform.

## Self-gate

`@demlik/code-graph` gates itself. `src/selfcheck.test.ts` runs the tool's cheap-pass
analysis on its own `src/` against `selfcheck.thresholds.json` and fails the build
if any non-test function trips a structural smell — so the tool meets the standard
it enforces. Test files are excluded because their fixtures are intentionally gnarly.
The failure message names the offending `kind`, `target`, and `value` vs `threshold`,
so a regression is obvious without re-running the CLI.

`selfcheck.thresholds.json` carries exactly ONE override — `directorySprawl: 16`,
because `render/` and `extract/` are cohesive by design (SPEC §4) — and it has not
moved. Everything else runs at the shipped defaults. When a feature does not fit,
the FILE moves, not the number: `schema.ts` is a barrel over `schema/`, `index.ts`
split its flag surface into `cli.ts`, and features C, E, F and H each own a
directory (`collapse/`, `layers/`, `hotspots/`, `env-keys/`, `comments/`). Six features arrived
in parallel and four of them independently reached for the threshold instead; that
is the failure mode this note exists to name (#4846).

## Comment census (`--comments`)

Three numbers, never one:

| Class | Buckets | What it means |
|---|---|---|
| `mechanical` | `banner`, `commented-out-code` | Removable with ZERO judgment — a script could do it. Small by design |
| `protected` | `pragma`, `license`, `marker` | A pragma changes what the build does, a license is a legal obligation, a marker is somebody's open loop |
| `prose` | `file-header`, `docblock`, `block`, `inline` | The volume. This repo's CLAUDE.md sanctions the comment as the home for rationale, so prose is not a defect — whether a paragraph earns its lines is a judgment a reader makes with the code in front of them |

A single "how much could go" axis was tried and deleted: on this repo it reads
~100% of comment lines on nearly every file, which ranks nothing and implies a
verdict the tool has no standing to pass. `commented-out-code` requires a CLEAN
parse of the comment body, so it stays small on purpose — a false "this is dead
code" costs far more than a miss, and the confirm step is not to be loosened.

Buckets are decided first-match-wins in precedence order, so a docblock carrying
a `TODO` is a `marker` (protected), not a docblock. Per-bucket LINE counts
partition each file's comment lines exactly: ranges are walked in position order
and each physical line is attributed to the first range covering it, so
`sum(buckets) === commentLines` with no reconciling term. The census enumerates
comments with `extract/metrics.ts`'s `collectModuleCommentRanges` — the same walk
`ModuleNode.commentLines` counts — so `totals.commentLines` and the graph's
`stats.totalCommentLines` are one computation, not two that agree by luck.

### The ratchet (`--comments --ci`)

Nothing counted comments before this, so the ratio only ever grew. `--ci` turns
the same census into a gate over `comment-ceilings.json` at the repo root:

```json
{ "default": 40.0, "slackPoints": 2.0, "scopes": { "packages/a11y": 47.0 } }
```

It fails in BOTH directions, and the second is the ratchet:

| Direction | Condition | Fix |
|---|---|---|
| `EXCEEDED` | the scope's ratio is above its ceiling | cut the volume back, or raise the entry and say why |
| `SLACK` | the ratio sits more than `slackPoints` BELOW the ceiling | `--write-ceilings` — a ceiling that drifts above reality has stopped being one, and leaving it there is headroom for the volume to grow straight back |

A scope with no `scopes` entry inherits `default` and is checked for `EXCEEDED`
only: the default is a floor for arrivals, not a claim about that scope, so it
cannot be stale. Recording it is what puts it under the ratchet. The file is
parsed through the same boundary as `--thresholds` and `--layer-rules`
(`config.ts`), so a typo'd key exits 2 with one line.

The gate and the view read ONE `CommentCensus` — `comments/gate.ts` owns the
load, so a ratio can never be measured two ways. `pnpm gate` runs it as phase 5.

Read [`SPEC.md`](./SPEC.md) for the contract.
