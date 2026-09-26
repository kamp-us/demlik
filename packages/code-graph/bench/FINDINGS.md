# Engine benchmark findings (#384)

What the ts-morph loaders cost next to oxc (syntax and module resolution) and tsgo (the native type
checker), measured on targets in this repo that anyone can re-run. #397 moved code-graph onto oxc
and tsgo on these numbers.

## Since #397

`engines.mjs` now measures the production passes, which run on oxc and tsgo, and checks them
against the ts-morph engine instead of racing prototypes. ts-morph is no longer a dependency, so the
baseline is a graph the ts-morph engine printed, taken from a checkout before #397:

```sh
# on a pre-#397 checkout, once per target
node --import tsx packages/code-graph/src/index.ts <target> --graph --edges > baseline.json
# on this checkout
node packages/code-graph/bench/engines.mjs <target> --baseline baseline.json
node packages/code-graph/bench/engines.mjs <target> --codegraph --runs 3 --json out.json
```

The parity rows compare resolved module edges, functions (id, lines, kind) and callee edges
(caller, call line, callee, declaration) exactly. The script is not part of `pnpm test` or CI.
`--codegraph` adds the #381 row, which fetches `@colbymchenry/codegraph` through `npx` on its first
run.

### Measured at #397

Median of 3 runs each, on the machine below with other agent lanes running (load average 24 to 29
at start). Baselines were printed by the ts-morph engine over the same trees.

| Target | Cheap pass | Edge pass (+ clusters) | Module edges | Functions | Callee edges |
|---|---|---|---|---|---|
| `packages/code-graph` (201 files) | 3.01 s, 200 MB | 6.27 s, 292 MB | 508 / 0 / 0 | 1189 / 0 / 0 | 4410 / 0 / 0 |
| `packages/tea` (387 files) | 1.57 s, 378 MB | 4.19 s, 653 MB | 972 / 0 / 0 | 4071 / 0 / 0 | 6225 / 15 / 15 |

Parity cells read match / missing / extra. The ts-morph edge pass needed 9.53 s and 1099 MB on tea
(the #384 table below). The 15 tea callee edges that differ all keep their caller, line and callee
id; only the `declaration` string moved, and no node kind changed:

- **A global a lib and a package both declare as values** (13 edges, plus 1 ts-morph left without a
  declaration). `lib.dom` and `@cloudflare/workers-types` each declare `AbortController`, `crypto`,
  `TextEncoder` and `AbortSignal`; the checker keeps whichever it merges first, and tsgo merges the
  lib first. Example: `crypto.randomUUID()` in `src/agent/define-agent.ts:begin` names
  `typescript:Crypto.randomUUID`, where ts-morph named `@cloudflare/workers-types:Crypto.randomUUID`.
- **A call on a union-typed receiver** (1 edge). The declaration names whichever constituent the
  checker lists first. Example: `data.toString()` on a `RawData` in
  `src/node/index.ts:nodeWsRunner` names `typescript:Array.toString`, where ts-morph named
  `typescript:Object.toString`.

The rest of this document is the #384 record: the ts-morph rows below can only be re-run from a
pre-#397 checkout.

## How the numbers were taken

- Each engine runs in its own child process under `/usr/bin/time` (`-l` on macOS, `-v` on GNU).
  **Wall** is the child process's wall time as the parent saw it. **work** is the timed section
  inside the child, after its modules loaded. **Peak RSS** is the OS maximum resident set size
  of the child and the processes it waited for. For tsgo that covers the Go binary, and for the
  callee row it covers the tsgo API server.
- Node children load `src/` through the `tsx` loader, so ts-morph is measured through its real
  entry points: `loadCheapProject` + `assembleGraph`, and `loadEdgeProject` +
  `assembleGraphWithEdges` (the `--edges` CLI path) + `buildClusterReport`. None of that logic is
  copied. The **harness floor** row is node + tsx + the `src` modules the oxc child imports,
  doing no work. Treat it as the fixed cost under every node row's peak memory.
- Each row is the median of 3 runs, taken in interleaved rounds so that a load spike hits every
  engine alike. The machine was shared with other agent lanes. The load average at the start of
  each target's run is in its caption, and a single run can be 2 to 4 times slower than its
  median. Read ratios between rows, not absolute seconds.
- Machine: Apple M4 (10 cores), 32 GB RAM, macOS 15.5 (Darwin 24.5.0 arm64). Node v23.7.0.
- Engines: ts-morph 28.0.0 (bundles TypeScript 6.0.2), oxc-parser 0.151.0, oxc-resolver 11.24.2,
  `@typescript/native-preview` 7.0.0-dev.20260707.2 (tsgo), TypeScript 5.8.3 (the `tsc` row),
  `@colbymchenry/codegraph` 1.6.0.

## Medium: `packages/code-graph` (114 files)

Load average at start: 16.4 14.7 18.5.

| Engine | Wall (work) | Peak RSS | Parity |
|---|---|---|---|
| harness floor (node + tsx + imports, no work) | 0.34 s | 224 MB | — |
| ts-morph cheap | 2.09 s (1.66 s) | 530 MB | baseline (syntax) |
| ts-morph edge (+ clusters) | 2.97 s (2.44 s) | 638 MB | baseline: 332 distinct resolved module edges |
| oxc (import graph + clusters + name tokens) | 0.56 s (0.11 s) | 263 MB | edges 332 match / 0 missing / 0 extra; clusters identical (8 = 8, same modularity); name tokens 649 / 649 match |
| tsgo full check (`tsgo --noEmit`) | 0.23 s | 282 MB | cost proxy; 0 diagnostics |
| tsc full check (TypeScript 5.8.3, for scale) | 1.26 s | 392 MB | 0 diagnostics |
| tsgo callee resolution (`unstable/sync` API) | 0.83 s (0.38 s) | 267 MB | callee edges vs `resolveCallees`: 773 match / 56 missing / 23 extra |
| colbymchenry/codegraph `init` (#381) | 1.68 s | 311 MB | index only (2,096 nodes, 5,674 edges); no parity mapping |

## Large: the repo root (556 files)

Load average at start: 13.7 13.7 17.6. The root has no `tsconfig.json`, so the two checker rows
ran against a tsconfig the script synthesized over the root's source files. The edge loader has
no such seam.

| Engine | Wall (work) | Peak RSS | Parity |
|---|---|---|---|
| harness floor | 0.96 s | 227 MB | — |
| ts-morph cheap | 7.73 s (6.50 s) | 1127 MB | baseline (syntax) |
| ts-morph edge | not measured | not measured | not measured: `loadEdgeProject` throws "no tsconfig.json found at or above" the root, which is the same refusal the CLI prints as "edges unavailable". The edge pass cannot open this repo whole. |
| oxc | 1.04 s (0.59 s) | 350 MB | not measured: no ts-morph edge baseline on this target |
| tsgo full check | 1.28 s | 1055 MB | cost proxy; 754 diagnostics (synthesized config) |
| tsc full check (for scale) | 9.57 s | 1120 MB | 751 diagnostics (synthesized config) |
| tsgo callee resolution | 3.59 s (2.90 s) | 852 MB | 38,789 call sites resolved; parity not measured (no baseline) |
| colbymchenry/codegraph `init` (#381) | 3.69 s | 660 MB | index only (9,037 nodes, 35,651 edges) |

## Supplementary: `packages/tea` (387 files)

This is the largest target in the repo that the edge loader can open, so it carries the
large-scale parity numbers the root cannot. Load average at start: 12.6 14.0 18.1.

| Engine | Wall (work) | Peak RSS | Parity |
|---|---|---|---|
| harness floor | 0.49 s | 233 MB | — |
| ts-morph cheap | 7.92 s (6.90 s) | 922 MB | baseline (syntax) |
| ts-morph edge (+ clusters) | 9.53 s (7.21 s) | 1099 MB | baseline: 931 distinct resolved module edges |
| oxc | 0.91 s (0.53 s) | 344 MB | edges 931 match / 0 missing / 0 extra; clusters identical (14 = 14); name tokens 4,071 / 4,071 match |
| tsgo full check | 0.50 s | 382 MB | cost proxy; 2 diagnostics |
| tsc full check (for scale) | 2.84 s | 572 MB | 0 diagnostics |
| tsgo callee resolution | 1.13 s (0.55 s) | 346 MB | 1,109 match / 462 missing / 239 extra over the files in tea's tsconfig; 999 more ts-morph callee edges are in files that tsconfig excludes |
| colbymchenry/codegraph `init` (#381) | 3.22 s | 673 MB | index only (6,267 nodes, 27,257 edges) |

## What the parity columns mean

- **Module edges.** Each edge is a distinct `(from file, resolved target file)` pair, with the
  target inside the target's own file set. oxc resolves under the same single tsconfig
  `loadEdgeProject` picks. On both targets it reproduced ts-morph's edge set exactly. One thing
  to carry into the follow-up: with per-file tsconfig discovery (`tsconfig: "auto"`), oxc
  honoured `packages/tea/examples/tsconfig.json`'s `paths` and found 61 more edges that ts-morph
  misses. That is the editor's view, not a parse difference.
- **Clusters.** oxc's module list goes into the unchanged `buildClusterReport`. Without a
  checker there are no call edges, so the fair baseline is ts-morph's report with its calls
  removed (`buildClusterReport([], modules)`). Against that baseline the reports are
  byte-identical on both targets. What the checker adds to clusters is the call edges, and those
  move 78 of 85 files on medium and 156 of 189 on tea. "Files moved" is counted label-free over
  the files a report names, which are the files of scattered clusters and split directories.
- **Collapse tokens.** oxc discovers functions on its ESTree AST in the same shape as
  `src/extract/functions.ts`, and names go through the unchanged `nameTokens`
  (`src/collapse/tokens.ts`). Every function matched, keyed by file, start line and name. That
  is 649 on medium and 4,071 on tea, with 0 missing and 0 extra.
- **Callees.** tsgo does expose a usable programmatic surface:
  `@typescript/native-preview/unstable/sync` (`API`, `Snapshot`, `Checker.getSymbolAtLocation`
  batched per file, `getAliasedSymbol`, declaration handles). The row walks each file's
  `CallExpression`s on tsgo's own AST and resolves every callee through the checker. The
  comparison key is caller file, call line, and declaring file plus name, over calls that sit
  inside a ts-morph-discovered function. The misses are semantic, not a failed surface:
  - ts-morph's `resolveCallees` follows factories (`createFactoryResolver`).
  - ts-morph charges a `const f = () => …` declared inside a function to the enclosing
    function (`enclosingId`).
  - ts-morph leaves property-bound callbacks (`onopen`, `push`) external, where tsgo names
    their declaration.
  - On tea, `loadEdgeProject` adds files the tsconfig excludes (tests, examples), and tsgo's
    project does not open those files.

  A tsgo port of `resolveCallees` would have to reproduce those rules. The resolver itself is
  there and cheap.
- **tsgo diagnostics.** These are a cost proxy, not a parity check. TypeScript 7 defaults
  `types` to `[]`, so the script passes the `@types` packages that TypeScript 5 would have picked
  up for a tsconfig that sets none. Without that, tsgo checks a different program.

## Which of collapse and boundaries reads the type checker

Both load the full edge program today (`loadEdgeProject` + `assembleGraphWithEdges`). Only
collapse reads what the checker produces.

- **Collapse reads the checker.** `collapse/gate.ts` assembles with `crossRuntime` and `kinds`
  on. The partial-twin count it gates on (`collapse/partial.ts`) reads each function's
  `edges.calls`, meaning callee ids, call lines and const args. The candidate scoring
  (`collapse/signals.ts`) reads the callee and caller sets. Those come from
  `extract/callee/resolve.ts` and `extract/callee/factory.ts`, which call `getSymbol()`,
  `getAliasedSymbol()` and `getDeclarations()`. The effect-reach cost (`collapse/cost.ts`) reads
  `nodeKind`, and `kinds/declarations.ts` classifies it through the same symbol calls. Collapse
  needs declaration resolution.
- **Boundaries does not.** `boundaries/gate.ts` hands `analyzeBoundaries` only `graph.modules`,
  and the analysis reads each module's `importEdges`: specifier, type-only flag and resolved
  target. The target comes from `extract/edges.ts`
  (`literal.getSymbol()?.getDeclarations()?.[0]?.getSourceFile()`). That is a checker call, but
  what it computes is module resolution. The gate also pays for callee resolution on every
  function (`resolveEdges` → `resolveCalls`) and then discards it. oxc reproduced the resolved
  edge set exactly on both targets, which is the input boundaries reads. So the triage note's
  gap is real: boundaries needs module resolution, not the checker.

## The #381 column

Filled. `npx -y @colbymchenry/codegraph@1.6.0 init -y <copy>` installs and indexes in one
command. It writes a `.codegraph/` directory into what it indexes, so it runs on a scratch copy
of the target's `.ts`/`.tsx` files with `CODEGRAPH_NO_DAEMON=1` and `CODEGRAPH_TELEMETRY=0`. Its
wall time includes `npx` resolving the cached package. The field-coverage mapping and the naming
question stay on #381.

## What this means for the two-tier engine idea

- **The syntax tier has headroom and parity.** On tea, oxc does in about 0.5 s of work and
  about 340 MB (roughly 110 MB above the harness floor) the import graph, the cluster input and
  the collapse name tokens. The ts-morph edge pass needs about 7 s and about 1.1 GB for that,
  and ts-morph cheap needs about 7 s and about 0.9 GB. Parity was exact on every syntax output
  measured here.
- **ts-morph's cost is not mostly the checker.** The cheap loader never builds a checked program,
  yet its time on tea and on the root is about the same as the full edge pass. Most of it goes
  to `assembleGraph`'s walk over ts-morph's wrapped AST. A syntax tier helps every pass, not only
  the ones that load the edge program.
- **The type tier is affordable where it is needed.** A full tsgo check costs about 5 to 8 times
  less wall than `tsc` at similar or lower memory. Batched symbol resolution through the tsgo
  API covered all 38,789 call sites on the root in under 3 s of work. The API is
  `unstable/*`-namespaced and pinned to a dev build.
- **The whole repo is out of the edge loader's reach today.** Every other engine ran on the root.
  The root has no tsconfig, so `loadEdgeProject` refuses it. A per-file tsconfig engine does not
  share that limit.
- **The open questions are for the follow-up, not this spike:**
  - Whether the collapse and callee rules (factory following, `enclosingId`, what counts as an
    implementation) get ported onto tsgo's symbols.
  - Whether boundaries moves to the syntax tier.
  - How much the `unstable` API surface is worth depending on.
