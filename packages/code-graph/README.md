# @demlik/code-graph

Agent-native TypeScript code-graph + smell tool. Point it at a folder; it parses
every `.ts`/`.tsx` (via `ts-morph`), measures each function (loc, complexity,
nesting depth, comment lines), groups them into modules and directories, flags
smells against the thresholds in `schema.ts`, and ranks refactor targets. Output
is deterministic JSON (sorted object keys, sorted arrays — same input, same
bytes) so an agent reads a graph instead of re-reading files.

The default run is **cheap** (no tsconfig, syntactic getters only — fast). Call
edges (`calls`/`calledBy`/`importedBy`/`callChainDepth` + their smells) are an
**opt-in** pass triggered by `--edges`, `--deep`, or `--blast`.

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
| Imports crossing a declared feature boundary | `code-graph X --boundaries` |
| Gate feature-boundary crossings against `boundary-ceilings.json` | `code-graph . --boundaries --ci` |
| Ranked collapse candidates + partial twins | `code-graph X --collapse` |
| Gate the partial twins against their recorded ceiling | `code-graph . --collapse --ci` |
| Re-record one scope's partial-twin ceiling | `code-graph X --collapse --write-ceilings` |
| Where the directory layout disagrees with how the code clusters | `code-graph X --clusters` |
| Churn × complexity hotspots (where defects concentrate) | `code-graph X --hotspots` |
| Packages ranked by export count, zero-external-consumer exports called out | `code-graph X --interface-width` |
| Module-import cycles, as their participating files | `code-graph X --cycles` |
| Env-var keys declared but never read, and read but never declared | `code-graph X --env-keys` |
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
| `--layers` | Layer gate: every import edge pointing UP the declared layer stack, plus the census and the allowlist verdict. **Exits 1** on any disagreement. No stack ships, so with no `--layer-rules` file declaring one it refuses: exit code 2, one-line message naming `--layer-rules`. Runs on the cheap pass — no tsconfig, no Graph |
| `--layer-rules <file>` | JSON file declaring the layer stack (`layers`, at least two) and its allowlist (`allowed`), same boundary discipline as `--thresholds`. Both default to empty; see [Declaring the stack](#declaring-the-stack---layer-rules) |
| `--boundaries` | Feature boundaries over each scope declared in the boundary rules at or under the analyzed path, on its `modules[].importEdges`: **B1** a feature importing another feature anywhere but its `src/<feature>/index.ts`; **B2** a feature's `rules/` importing anything but its own `rules/` and the declared `contracts`; **B3** a `lib` folder importing a feature; **B4** a file in no declared feature and no `lib` folder (the rest of `src/`, and loaded files outside it) importing a feature anywhere but its `src/<feature>/index.ts`. `lib` importers are judged by B3, not B4. A report, exit 0; nothing declared means nothing reported. Implies the edge pass |
| `--boundaries --ci` | Boundary ratchet: each declared scope's violation count against `boundary-ceilings.json`. Fails both ways, like `--collapse --ci`. `--write-ceilings` records the counts |
| `--boundary-rules <file>` | JSON file of boundary-declaration overrides: `{ features: { "<scope>": ["<folder under src/>", …] }, lib: ["lib"], contracts: ["<package>", …] }`. An override REPLACES each key wholesale |
| `--collapse` | Ranked collapse candidates: pairs of functions that may be one function, grouped into cliques, each carrying its evidence — plus **partial twins**, pairs sharing one decision block over the same named constants and then calling different things. Implies `--kinds`. `--json` emits the full report (clusters + every scored pair + the skipped blocking keys + the partial twins) |
| `--collapse --ci` | Partial-twin ratchet over the scopes recorded in `collapse-ceilings.json`. Fails both ways: above a ceiling (a new twin) and below one (a fixed twin the file still counts). Does not gate the whole-function candidates |
| `--collapse --write-ceilings` | Record the analyzed path's partial-twin count in `collapse-ceilings.json`, leaving the other scopes as they are |
| `--collapse-config <file>` | JSON file of collapse-setting overrides, same boundary discipline as `--thresholds` |
| `--cycles` | Module-import cycles reported as their participating FILE GROUPS (the same Tarjan SCC the `dependency-cycle` smell scores, printed as groups rather than a per-file severity). Report, never a gate. Implies the edge pass — `importEdges` is `[]` on the cheap pass |
| `--comments` | Comment CENSUS: every comment line lands in exactly one of nine buckets, and each bucket in exactly one CLASS — **`mechanical`** (`banner`, `commented-out-code`: removable with no judgment), **`protected`** (`pragma`, `license`, `marker`: never touch), **`prose`** (`file-header`, `docblock`, `block`, `inline`: the volume, judgment required). Rolled up by bucket, by package scope, and by file, ranked by comment lines. Human view caps files and scopes at 20; `--json` emits every row. A count, not a verdict. Standalone: no Graph, no edge pass |
| `--comments --ci` | Comment RATCHET: gate each scope's ratio against `comment-ceilings.json` at the repo root. **Exits 1** on any violation, 2 on a malformed ceilings file |
| `--comments --write-ceilings` | Rewrite `comment-ceilings.json` from the current measurement (ceilings rounded UP to 1 dp; `default`/`slackPoints` carried forward) |
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

## Node kinds and the two path queries

A **type cannot express a path property**. No TypeScript type says "this write is
only reachable after an authorization check" — that is a property of paths, which is
why this repo accumulated fitness functions, ledgers and gates-on-gates to enforce
things a graph can simply answer.

`--kinds` labels every function with exactly one `NodeKind` — a discriminated union,
so an added kind fails to compile at every consumer:

| Kind | Meaning |
|---|---|
| `entry` | A place a real run starts: a `fetch`/`email` handler, a `scheduled`/`queue`/`tail` handler, a GraphQL resolver, a registered CLI command, any method of a class a wrangler config declares as a **Durable Object**, any public instance method of a class extending `WorkerEntrypoint` or `DurableObject` (`worker-entrypoint-method`), or an RPC method with at least one **real** cross-service caller (Feature A establishes that as a fact, not a guess). A Workflow's `run` is not an entry: only its own worker starts it, so it is reached through the `create` call-site's edge |
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

The most SPECIFIC pattern wins, so `services/*/src/domain` claims a file
`services` would otherwise take, and a prefix ends at a path separator —
`packages/core` never claims `packages/core-contract`.

Paths not named are **outside the lattice**. Their edges are counted `unlayered`
and never judged — the coverage gap is a number in every report, not a silence. A
package consumed from two non-adjacent layers, like a shared UI kit, is often
better left undeclared than declared into findings it cannot fix.

### The edge set, and why it is imports

`--layers` reads **module specifiers** — static imports, `export … from`, and
dynamic `import()` — from the parser's own import list, on the **cheap pass**. No
tsconfig, no type-checker, no Graph. That is deliberate: the type-aware `--deep`
pass does not finish on this repo in a usable time, and a gate that cannot be run
over the whole architecture is not a gate on the architecture. An import is also
what the rule is about ("apps/web must not reach into the engine") and it carries
an exact line, which a resolved call does not.

A `.d.ts`, `.json` or `.css` target is still an edge and is still judged; a
relative specifier that names no file on disk is reported as **UNRESOLVED**, by
name, so a systematic resolver bug shows up as a pattern rather than as
acceptable noise.

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
