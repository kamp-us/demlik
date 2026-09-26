# `@demlik/code-graph` — Specification

> **Status:** locked design (v2, post-review). This file is the contract. Read it before writing or changing any code in this package. If the code and this spec disagree, the spec wins until this file is changed first.

## 1. Purpose

An **agent-native** tool that walks a TypeScript folder and emits a structured graph an agent reads *before* a refactor — so the agent orients, finds the rot, gets exact coordinates, and knows blast radius without reading every file into context.

The primary user is a coding agent (Claude), not a human. Output is therefore: machine-parseable JSON, **token-efficient by default** (the bare command never dumps the full graph — see §10), and every node addressable by `file:line` so the agent can `Edit` precisely.

It does **not** rewrite code. It reads and reports.

## 2. Usage contract (how the agent uses it)

When sent to refactor folder `X`, the agent's first moves are Bash calls, not Reads:

| Goal | Call |
|---|---|
| Orient — health + worst offenders (first call) | `code-graph X` |
| Ranked refactor targets, re-rankable | `code-graph X --plan [--by rot\|impact\|complexity\|size]` |
| One file's functions + line ranges | `code-graph X --file <f>` |
| Blast radius before changing a signature (intra-package) | `code-graph X --blast <id>` |
| **Cross-package** blast radius (before changing a shared export) | `code-graph X --blast <id> --deep` |
| Full graph (rarely — large) | `code-graph X --graph` |
| Comment census — how much comment, of what kind, where | `code-graph X --comments` |
| Comment ratio ratchet (a gate) | `code-graph . --comments --ci` |

`--blast` requires an unambiguous target; pass the `id` (`file:name`), not a bare name. In default (`package`) scope, blast output is flagged incomplete for cross-package callers (§10).

## 3. Architecture

- **Two engines behind one seam (`src/engine/`).** oxc (`oxc-parser` + `oxc-resolver`) reads syntax and resolves module specifiers; tsgo (`@typescript/native-preview`, its `unstable/sync` API, pinned to one exact build) answers symbol questions. `src/engine/tsgo.ts` is the only module that imports tsgo, and oxc is imported only under `src/engine/` (`seam.test.ts` holds both). No hand-rolled parsing, ever; comment ranges follow TypeScript's leading/trailing rules (`src/syntax/trivia.ts`).
- **Two-pass loading:**
  1. **Cheap pass** — every visible source file parsed by oxc, **no tsconfig**, syntax only. Fills `name, file, lines, loc, commentLines, nestingDepth, complexity, imports`. No checker is started, so this is fast. `provenance.pass = "cheap"`.
  2. **Edge pass** — the target's nearest tsconfig drives module resolution (oxc-resolver) and a tsgo program over that tsconfig's files plus every loaded file. Resolves `calls[]`; `calledBy[]` is derived by **inverting** `calls[]` (never `findReferences`, which forces the whole monorepo into RAM). `provenance.pass = "edges"`. `--boundaries` reads only the import edges, so it never starts tsgo.

**The edge pass is opt-in.** Only `calls`/`calledBy`/`importedBy`/`callChainDepth` and the smells `high-fan-in` + `deep-call-chain` require it. It runs when **any** of these is passed: `--blast <id>` (required — blast radius is a callers query), `--deep` (implies edges + monorepo scope), or `--edges` (opt-in; makes summary/plan/smells/graph include edge data + edge smells). With no flag the run stays cheap/fast (cheap-pass smells only, plus `directory-sprawl` which needs no type info — see §8-C4).
- **Node→id map.** Function enumeration (A1) runs on oxc's tree; the edge pass joins each function to its node in tsgo's tree by TypeScript start position and node kind, once, and every rule that reads a symbol resolves through that `tsgo Node → FunctionNode.id` map (C1).
- **Determinism:** **every** array in the output is sorted by a total order and deduped; JSON is serialized with sorted object keys. No `Date`, no random. Same input → same bytes. (Sort keys per array type in §6/§8.)

## 4. Module layout

```
packages/code-graph/
  SPEC.md                 ← this file
  package.json            @demlik/code-graph, type:module, bin:{code-graph}; deps incl. oxc and an exact tsgo pin
  tsconfig.json           standalone strict ESM config
  tsup.config.ts          ESM build
  src/
    index.ts              the RUN: which passes fire, which view answers
    cli.ts                the VOCABULARY: the flag set + the `Opts` commander parses into
    schema.ts             barrel over schema/ — the import path every consumer writes
    schema/
      core.ts             the cross-referencing contract (§5). OWNS threshold defaults + SmellKind.
      cross-runtime.ts    Feature A       reachability.ts     Feature B queries
      clusters.ts         Feature D       interface-width.ts  Feature G
      data.ts             --data: DataEdge + DataReport
      graph.ts            the ONE composition of all of them into `Graph`
    extract/
      project.ts          load folder (cheap vs tsconfig pass), file filters (A3), parse-failure detection (§11)
      functions.ts        enumerate named callables (A1), stable names (A2), build node→id map
      metrics.ts          ONE AST walk per function: loc, commentLines, nestingDepth, complexity (B)
      edges.ts            calls[] resolve (C1) → invert to calledBy (C2); imports/importedBy; call-chain (C5)
      directories.ts      group files by directory (C4)
    engine/     the seam: oxc.ts (oxc-parser + oxc-resolver), tsgo.ts (the one tsgo import), seam.test.ts
    syntax/     file.ts (oxc's tree, parents, TypeScript-shaped children, lines), trivia.ts (TypeScript's
                comment ranges), imports.ts (import literals and their resolution)
    checker/    context.ts: the tsgo program and the join from oxc's functions to tsgo's nodes
    smells/
      rules.ts            the keyed rule table RULES: Record<SmellKind, Rule> — SSOT for kinds + thresholds
      plan.ts             ranking score + --by axes (§7)
      health.ts           summary health band (§5 summary)
    render/
      summary.ts (default)  graph.ts  tree.ts  smells.ts  plan.ts  file.ts  blast.ts  ci.ts
      html.ts (--html entry)  html-model.ts (pure Graph→HtmlModel)  html-template.ts (page scaffold)
      analysis.ts           the opt-in views: --cross-runtime/--kinds/--unreachable/--unguarded/--clusters/--interface-width/--cycles/--env-keys
    layers/     Feature E — the --layers gate          collapse/   Feature C — --collapse
    hotspots/   Feature F — churn.ts + render.ts       env-keys/   Feature H2 — extract.ts + query.ts
    data/       --data — access.ts (read/write per binding method) + extract.ts (call sites) + render.ts
    comments/   Feature I — classify.ts + census.ts + render.ts + ceilings.ts + ratchet.ts + gate.ts
```

> **`render/` and `extract/` directory-sprawl gate:** `render/` holds one renderer per CLI output mode, and `extract/` holds one parser/scanner per extraction concern (cohesion, not sprawl) — both exceed the default `directorySprawl` (10). `selfcheck.thresholds.json` bumps `directorySprawl` to 16 for the self-gate ONLY — the shipped default is unchanged, and the number has not moved since. A feature that would push `render/` or `extract/` past it owns a DIRECTORY instead (`layers/`, `collapse/`, `hotspots/`, `env-keys/`, `schema/`): the fix for a full drawer is another drawer, never a bigger number (#4846). The `--html` feature is the pure model (`html-model.ts`), the inert page scaffold (`html-template.ts`), and a thin entry (`html.ts`); splitting it three ways keeps each file under the per-file `big-file`/`long-function` bars without relaxing those. `env-keys/extract.ts` (Feature H2) is the AST scan for `env.<KEY>` reads, kept separate from `references.ts` (the call-graph reference walk) and `wrangler-config.ts` (the declared-key source) because the three answer different questions over different inputs — merging them would trade one cohesive file for one bloated one.

## 5. Data schema (the contract)

Defined once in `schema/` with zod, re-exported by the `schema.ts` barrel so every consumer still writes `./schema.js` (#4846). **Single sources of truth:**
- Every node `file`/`dir` key is **relative to the analyzed root** (the folder passed to `code-graph`), NOT the repo root. `graph.root` is that analyzed root expressed relative to cwd; join a key with the analyzed root to recover its absolute path.
- Threshold **defaults** live only on the zod schema via `.default(n)`. `thresholds.ts` does not exist as a second copy — the default object is `ThresholdsSchema.parse({})`.
- `SmellKind` is **derived** from the rule table: `type SmellKind = keyof typeof RULES`. The schema's kind enum and `rules.ts` cannot drift.

```ts
type SmellKind =
  | "long-function" | "deep-nesting" | "high-complexity" | "dense-undocumented"
  | "big-file" | "high-fan-in" | "deep-call-chain" | "directory-sprawl";
//  ^ derived as keyof typeof RULES; listed here for reference only.

// target is tagged AND directly addressable — no consumer re-derives the kind.
type SmellTarget =
  | { type: "function"; id: string; file: string; startLine: number }
  | { type: "module"; file: string }
  | { type: "directory"; dir: string };

type Smell = {
  kind: SmellKind;
  target: SmellTarget;
  value: number;             // measured value
  threshold: number;         // threshold it exceeded
  severity: "warn" | "high"; // "high" when value >= 2 * threshold, else "warn"
};

type FunctionKind =
  | "function" | "method" | "constructor"
  | "getter" | "setter" | "arrow" | "function-expression";

type CallSite = { calleeId: string; line: number; constArgs: string[] };  // calleeId may be `external:${name}`
type CallerSite = { callerId: string; line: number };  // line = where the caller calls this fn

type FunctionNode = {
  id: string;            // `${file}:${name}`; on within-file name collision, `${file}:${name}#${ordinal}`. Stable WITHIN a run.
  name: string;          // A2
  kind: FunctionKind;
  file: string;          // relative to the analyzed root (join with graph.root for absolute)
  startLine: number;
  endLine: number;
  loc: number;           // B1
  commentLines: number;  // A4 (the function's own leading + inner comment lines)
  nestingDepth: number;  // B2
  complexity: number;    // B3
  isExported: boolean;
  isTest: boolean;       // A3
  // The three call-graph fields are computed TOGETHER (one edge pass), so they
  // live or die together: ONE block, `null` in the cheap pass (edges not
  // computed), a populated object in the edge pass. There is no `calls: []` /
  // `callChainDepth: 0` that reads as "measured leaf, isolated" when edges were
  // never run — `edges: null` is the honest "unknown" (Nullable Is Two Functions).
  edges: {
    calls: CallSite[];      // edge pass; calleeId may be `external:${name}`
    calledBy: CallerSite[]; // edge pass; inverted from calls — ONE entry per call SITE
                            //   (self-recursion lists the fn itself N times; see fanIn below)
    callChainDepth: number; // C5; a real measured number (a genuine leaf = 0)
  } | null;                 // null = cheap pass (edge pass did not run)
  smells: Smell[];
};

type ModuleNode = {
  file: string;          // relative to the analyzed root (join with graph.root for absolute)
  loc: number;
  commentLines: number;  // ALL comment lines in the file (functions' counts are subsets of this)
  functionIds: string[];
  imports: string[];     // raw module specifiers
  importedBy: string[];  // analyzed-root-relative files importing this one; edge pass only
  isTest: boolean;
  smells: Smell[];
};

type DirectoryNode = {
  dir: string;           // directory relative to the analyzed root
  fileCount: number;
  functionCount: number;
  files: string[];
  smells: Smell[];
};

type Thresholds = {      // every field `.default(n)` in the schema — see SSOT note above
  longFunctionLoc: number;  // 60
  deepNesting: number;      // 4
  highComplexity: number;   // 10
  bigFileLoc: number;       // 400
  highFanIn: number;        // 10
  deepCallChain: number;    // 5
  directorySprawl: number;  // 10
};

type PlanRow = {
  id: string; file: string; startLine: number; endLine: number;
  score: number;
  // fanIn / calledByCount are `null` (UNKNOWN) when the edge pass did not run
  // (provenance.pass === "cheap") — never 0, which would read as measured-uncalled.
  // fanIn = count of DISTINCT caller functions, EXCLUDING the fn's own self-recursion
  //   (NOT calledBy.length — that's call SITES; a self-recursive fn would inflate).
  components: { smells: number; complexity: number; fanIn: number | null }; // why it ranked
  loc: number; complexity: number; calledByCount: number | null;
  smells: Smell[];
};

type Provenance =
  | { pass: "cheap" }
  | { pass: "edges"; tsConfig: string; scope: "package" | "deep" };

type Summary = {
  health: "healthy" | "rough" | "rotten"; // §5 health band
  fileCount: number;
  functionCount: number;
  smellCount: number;
  highSeverityCount: number;
  worstFile: string | null;        // highest module smell weight
  worstFunction: string | null;    // top PlanRow id
  topTargets: PlanRow[];           // top 10 by current ranking
  parseFailures: string[];         // surfaced here, not buried
};

type Graph = {
  root: string;                    // folder analyzed, relative to cwd; all node `file`/`dir` keys are relative to THIS root
  provenance: Provenance;
  thresholds: Thresholds;
  summary: Summary;
  // The opt-in reports (crossRuntime, reachability, clusters, interfaceWidth, data) sit here too,
  // each `null` unless its pass ran. `data` is the --data table: one DataEdge per call site on a
  // D1 / Durable Object / KV / R2 / queue binding (README "Data edges").
  data: DataReport | null;
  functions: FunctionNode[];
  modules: ModuleNode[];
  directories: DirectoryNode[];
  smells: Smell[];                 // flattened, all smells
  stats: {
    fileCount: number;
    functionCount: number;
    totalLoc: number;
    totalCommentLines: number;     // = sum of ModuleNode.commentLines (no double-count)
    smellCount: number;
    parseFailures: string[];
  };
};
```

**Health band (`health.ts`):** `rotten` if `highSeverityCount > 5` OR `smellCount / max(fileCount,1) >= 1.0`; `healthy` if `highSeverityCount === 0` AND `smellCount / max(fileCount,1) < 0.3`; else `rough`.

**`--thresholds <file>` is a parse boundary (Parse-Don't-Validate):** the override file is parsed through `ThresholdsSchema.partial()` and the parsed result merged over defaults. A typo'd key or wrong-typed value is a parse error, not silent corruption. No `as`, no raw `JSON.parse` into `Thresholds`.

## 6. Extraction semantics

### A1 — what counts as a "function" (LOCKED: named callables only)
Include: function declarations, class methods, constructors, get/set accessors, and arrow / function-expressions **assigned to a name** (variable, property, default export). **Exclude** anonymous inline callbacks (`arr.map(x => …)`) from the function list — but still count their nodes toward the **enclosing** function's `nestingDepth` and `complexity`. **Also exclude overload signatures and ambient/bodyless declarations** (`node.isOverload()` or `!node.hasBody()` on a `FunctionDeclaration`/`MethodDeclaration`): only the **implementation** (the one with a body) is enumerated, so a caller resolves to the real function — not to a phantom `loc:1` first signature — and calls to ambient stubs become honest `external:*`. One `forEachDescendant` pass switching on `node.getKind()`. Record each node in the node→id map (§3).

### A2 — name resolution
- Named node → its name.
- Arrow/fn-expression → parent `VariableDeclaration.getName()` or `PropertyAssignment` name.
- `id` collisions within a file resolved by a stable **within-file occurrence ordinal** (`#0`, `#1`, … in source order), not by start line (so ids don't churn when lines shift).

### A3 — file filters
Include `**/*.{ts,tsx}`. Exclude `**/*.d.ts`, `node_modules`, `dist`, `.next`, `**/__generated__/**`, `*.gen.ts`. Files matching `*.test.ts(x)` / `*.spec.ts(x)` are **included** but tagged `isTest: true`.

### A4 — comment-line counting (no double-count)
Source of truth: **`Node.getLeadingCommentRanges()`** (already includes JSDoc, so JSDoc is NOT added separately) **PLUS `Node.getTrailingCommentRanges()`** for comments inside the span. A trailing `// x` after code on the same line (e.g. on a branch) is invisible to the leading ranges, so it MUST be gathered too — otherwise a fully-commented complex function reports `commentLines: 0` and fires a false `dense-undocumented`. Both leading and trailing ranges fold into the SAME dedup-by-physical-line set. Count distinct physical lines spanned by those ranges plus inline `//` / `/* */` ranges inside the node span; dedup overlapping/consecutive line ranges so `// a\n// b` = 2 and a 5-line block = 5, never more.
- `FunctionNode.commentLines` = comment lines attributable to that function (its leading ranges + leading-and-trailing ranges inside its span).
- `ModuleNode.commentLines` = **all** comment lines in the file (the file total; function counts are subsets).
- `stats.totalCommentLines` = sum of `ModuleNode.commentLines` (never sum of functions — avoids double counting).

## 7. Metrics

| Field | Rule |
|---|---|
| **B1 LOC** | `endLine − startLine + 1`. JSDoc is already excluded from a declaration's start position (verified), so no flag is needed; leading `//` comments do **not** count toward LOC. |
| **B2 nestingDepth** | Max block-nesting depth **within this function's own lexical body only**. Depth accounting **stops at a named-callable boundary**: a nested *named* function is its own `FunctionNode` and does not inflate the parent. Only anonymous inline callbacks contribute to the enclosing function. Depth-increasing nodes: `Block` under `IfStatement`, `For/ForIn/ForOf/While/Do`, `SwitchStatement`, `CatchClause`, anonymous-callback bodies. |
| **B3 complexity** | `1 + ` count of: `IfStatement`, ternary (`ConditionalExpression`), `For/ForIn/ForOf/While/Do`, each `CaseClause` (not `default`), `CatchClause`, and each `&&` / `\|\|` / `??` token. (Counts `??`; this is *not* identical to ESLint's `complexity` rule — exact token list is the contract.) Anonymous callbacks inside the body count toward this function. |

`nestingDepth` and `complexity` are computed in the **same** AST walk.

### Plan ranking (`plan.ts`, `--plan`)
Deterministic. Default axis `--by rot`: sort descending by `(1) smells.length, (2) complexity, (3) fanIn`, tiebreak `(file, startLine, id)` — the `id` final tiebreak makes the order total (two functions sharing a `(file, startLine)` are impossible in practice, but `id` guarantees a single deterministic ordering regardless). Other axes: `--by impact` = `fanIn` first; `--by complexity`; `--by size` = `loc`. `fanIn` = distinct caller functions excluding the fn's own self-recursion (**not** `calledBy.length`, which counts call sites — a self-recursive fn would otherwise rank as a phantom hub). Every `PlanRow` carries `components` so the agent can re-rank itself, and `file`/`startLine`/`endLine` so it can act without a second call. `--plan` answers **"where's the rot,"** `--by impact` answers **"what's risky to change."**

**fanIn is unknown without the edge pass.** In the cheap pass `calledBy` is not computed, so `fanIn`/`calledByCount` render as `null` (JSON) / `—` (human), never `0` — `0` would read as "measured uncalled" (the *Nullable Is Two Functions* trap). The `rot`/`complexity` scores therefore DROP the fanIn term in cheap mode (it coalesces to 0). **`--by impact` requires the edge pass** — if requested without `--edges`/`--deep`/blast having run, the CLI refuses cleanly (one-line stderr, non-zero exit) rather than return a degenerate all-fanIn-null ranking.

## 8. Edges

| # | Rule |
|---|---|
| **C1 calls[]** | `funcNode.getDescendantsOfKind(CallExpression)` → `.getExpression().getSymbol().getDeclarations()`. From the resolved declaration, climb to the enclosing named callable per A1/A2, then look it up in the **node→id map** (§3). Record `{ calleeId, line, constArgs }`. Unresolved/external → `calleeId: "external:${name}"`. `constArgs` are the **named constants** this call site passes: identifiers bound at module scope in the calling file (import binding or top-level `const`) whose name is also declared somewhere in the loaded set as a `const` with a literal initializer. A bare callee identifier and an object-literal property NAME are not arguments and never count. High-confidence-but-incomplete (misses dynamic dispatch, `any`, higher-order). |
| **C2 calledBy[]** | Inverted from all `calls[]` within the loaded set: **one entry per call SITE** — each caller contributes `{ callerId, line }`, and a self-recursive function appears in its own `calledBy` once per recursive site (kept so `--blast` can point at every line). No `findReferences`. **`fanIn`/`calledByCount` derive from this as the count of DISTINCT `callerId`s excluding the fn's own id** — never `calledBy.length` (see §7, §8 `high-fan-in`). |
| **C3 scope** | **Default `package`:** load target folder's nearest `tsconfig.json`; `calledBy` complete within that package. **`--deep`:** load whole monorepo (root tsconfig) for cross-package `calledBy`. `--deep` parses + type-resolves every workspace file: expect tens of seconds and high RAM on this monorepo; it is the heavy path, used on demand only. |
| **C4 directory-sprawl** | Group source files by their **directory** (`dirname` of the analyzed-root-relative path). No naming convention. `DirectoryNode.fileCount`/`functionCount` per dir. (Replaces the unbuildable entity-based grouping.) **Cheap-pass:** this only needs the file list grouped by directory — no type info — so directories are built and the `directory-sprawl` smell is evaluated in the default (cheap) pass, not the edge pass. |
| **C5 callChainDepth** | Longest path in the call graph through this node, on the **callees** side. Cycles (recursion / mutual recursion) are collapsed via **strongly-connected-component condensation**, then longest path is computed on the resulting DAG in topological order, O(V+E). `external:*` nodes are excluded from the chain. A node inside a cycle inherits its SCC's collapsed depth. |

## 9. Smells (`rules.ts` — the SSOT keyed table)

`RULES: Record<SmellKind, { describe, threshold, evaluate }>`. `SmellKind = keyof typeof RULES`. Adding a smell = one entry; the schema enum and renderers derive from it.

| Smell kind | Rule | Default threshold key | Target |
|---|---|---|---|
| `long-function` | `loc > t.longFunctionLoc` | 60 | function |
| `deep-nesting` | `nestingDepth > t.deepNesting` | 4 | function |
| `high-complexity` | `complexity > t.highComplexity` | 10 | function |
| `dense-undocumented` | `complexity > t.highComplexity && commentLines === 0` | (reuses highComplexity) | function |
| `big-file` | module `loc > t.bigFileLoc` | 400 | module |
| `high-fan-in` | `fanIn > t.highFanIn` (fanIn = distinct callers excl. self-recursion, **not** `calledBy.length`) | 10 | function |
| `deep-call-chain` | `callChainDepth > t.deepCallChain` | 5 | function |
| `directory-sprawl` | `fileCount > t.directorySprawl` | 10 | directory |
| `dependency-cycle` | member of a VALUE-import SCC of size `> t.dependencyCycle` — a runtime `A→B→…→A` cycle; **`typeOnly` edges excluded** (a type-only cycle is runtime-erased, harmless) | 1 (flag size ≥ 2) | module |
| `cross-boundary-import` | value out-edges leaving the module's boundary `> t.crossBoundaryImports` (boundary = the module's **owning package** — its nearest `package.json` dir, discovered from the workspace layout, #2446) | 0 (any crossing) | module |

`severity`: `"high"` when `value >= 2 * threshold`, else `"warn"` — **except** the two coupling smells, whose thresholds (1 / 0) make `2 * t` a degenerate band: `dependency-cycle` is `high` for a tangle of ≥ 4 modules, `cross-boundary-import` `high` for ≥ 5 crossings, else `warn`.

**Pass split.** `high-fan-in`, `deep-call-chain`, **and the two coupling smells** (`dependency-cycle`, `cross-boundary-import`) are **edge-pass** smells — coupling reads the resolved+tagged `importEdges` (the module import graph, #2437/#2441), which only populate once the edge pass has run (§3); on a cheap run their facts are `null` (no data, no claim). Every other smell — including `directory-sprawl` (it needs only the directory file-count, no type info, §8-C4) — is a **cheap-pass** smell and fires on the default run. The coupling smells flag members/sources on the flat `Smell[]`; `--smells` (human) adds a **Coupling** section that lists each cycle's members, the cross-boundary edges grouped source→target, and the worst-coupled modules ranked (cycle membership + crossing count), so the import graph the audit found write-only (Discussion #2400) is finally read. The section respects the same thresholds (`dependencyCycle` / `crossBoundaryImports`) the flat smells use, so raising a threshold hides the below-threshold detail here too (#2446).

**Boundary = the owning package (#2446).** A module's boundary is the nearest `package.json` directory, discovered from the workspace layout (`discoverPackageRoots`) — not the top-level dir of its analyzed-root-relative path, and not a hardcoded `packages/apps/services/tools` container set. So a **cross-boundary edge crosses a PACKAGE**, the meaningful signal. Consequence to know: a **single-package scoped run** (e.g. `code-graph --edges services/foo/src`) has one boundary, so it reports **zero** cross-boundary edges even when subdirs import each other — that is correct, it is all one package. Real cross-**package** coupling surfaces at a **repo-root** run or `--deep`, where each package is its own boundary. (The v1 per-dir boundary inflated the count — 69 intra-package edges on `audit-agents/src` — by treating every top-level dir/file as a boundary.)

## 10. CLI surface

```
code-graph <path> [flags]
```

| Flag | Behavior |
|---|---|
| (none) | **`Summary`** as JSON: health band, counts, worst file/function, top-10 targets (with coordinates), parse failures. The orientation block — never the full graph. |
| `--graph` | Full `Graph` as compact JSON to stdout (the large dump, on demand) |
| `--plan [--by rot\|impact\|complexity\|size]` | Ranked `PlanRow[]` (human table, top 20). `--json` → full `PlanRow[]`. fanIn shows `—`/`null` unless the edge pass ran; **`--by impact` without edges is refused** (clean stderr, non-zero exit) — it needs the call graph |
| `--smells` | All smells grouped by kind (human). `--json` → `Smell[]` |
| `--tree` | Indented `file → function  L12-48  loc=36 cx=8 nest=3 [smell markers]` |
| `--file <f>` | One module + its functions only. Warns if `<f>` is in `parseFailures` |
| `--blast <id>` | Direct + transitive callers of `<id>`: list of `{ callerId, file, line, depth }` + `callChainDepth`. **Lists DISTINCT external callers only** — the target's own self-recursion is excluded from `callers` (so `callers.length` equals the target's `fanIn`) and surfaced separately as `recursiveSelfCalls` (count of self-call sites), shown as a `recursive: N self-calls` note in the human render. If a **bare name** matches >1 function, prints all candidate ids and exits non-zero. Output carries `scope`; in `package` scope sets `crossPackageCallersOmitted: true` and warns to re-run with `--deep` |
| `--edges` | Opt-in edge pass at `package` scope (§3): summary/plan/smells/graph include `calls`/`calledBy`/`importedBy`/`callChainDepth` and the edge smells (`high-fan-in`, `deep-call-chain`). Without it (and without `--blast`/`--deep`) the run stays cheap. |
| `--deep` | Edge pass loads the whole monorepo (C3); implies `--edges` at `deep` scope |
| `--html` | Emit a self-contained HTML report (human view — header + hotspot treemap + hub call-graph + sortable top-targets table; see `HTML-VIEW.md`). **Implies the edge pass** (the call-graph section needs `calls`). Pair with `--out <file>` to write the report directly (banner-safe); never an agent surface |
| `--out <file>` | Write the view payload straight to `<file>` via `fs.writeFileSync` instead of stdout. The **banner-safe** artifact path (#1761): under the `pnpm code-graph` wrapper, pnpm's run banner lands on stdout, so `… --html > report.html` prepends the banner to the file — `--out` sidesteps stdout entirely, so the file carries only the document. Applies to every view (`--html`, `--graph`, `--smells`, `--plan`, `--tree`, `--file`, `--blast`, default summary). A one-line `wrote N bytes to <file>` confirmation goes to **stderr**, never the file |
| `--comments` | Comment CENSUS. Every comment range from `extract/metrics.ts`'s `collectModuleCommentRanges` (the SAME walk `ModuleNode.commentLines` counts — the census total and `stats.totalCommentLines` are one computation) gets exactly ONE bucket, first match wins: `pragma` → `license` → `marker` → `commented-out-code` → `banner` → `file-header` → `docblock` → `block` → `inline`. Each bucket rolls into exactly one CLASS via `classOf` (an exhaustive switch, so a tenth bucket cannot skip the question): **`mechanical`** = `banner` + `commented-out-code` (removable with no judgment), **`protected`** = `pragma` + `license` + `marker` (never touch), **`prose`** = the rest (the volume — a comment carrying rationale is not a defect, and the tool passes no verdict on it). The three classes partition `commentLines`. Lines are attributed to the FIRST range covering them, so per-bucket lines partition the file's comment lines exactly. Rolled up by bucket, by package scope (`discoverPackageRoots`, longest match), and by file, ranked by comment lines descending, tiebroken on path. Human view caps files and scopes at 20; `--json` emits the whole `CommentCensus`. Report only. Standalone (cheap pass, no Graph) |
| `--comments --ci` | Comment RATCHET over the SAME `CommentCensus` (`comments/gate.ts` owns the one load — no mode recomputes a ratio). Each scope's `ratio`, expressed in percentage points at 1 dp, is compared to `comment-ceilings.json` at the repo root (`{ default, slackPoints, scopes }`, parsed through `config.ts` — a typo'd key or wrong-typed value exits 2 with one line). Two failure directions: **EXCEEDED** (`measured > ceiling`) and **SLACK** (`ceiling − measured > slackPoints`), the latter being the ratchet — a ceiling far above reality is no longer a ceiling. A scope with no recorded entry inherits `default` and is checked for EXCEEDED only. Exit 1 on any violation, 0 otherwise; `--json` emits the `RatchetVerdict`. `--write-ceilings` rewrites the file from the current measurement, ceilings rounded UP to 1 dp, `default`/`slackPoints` carried forward, vanished scopes dropped |
| `--boundaries --ci` | Boundary LEDGER gate (`boundaries/gate.ts`). `boundary-ledger.json` at the repo root holds one entry per crossing import, `{ scope, kind, from, to, specifier, reason? }` with `to` null only for a B2 bare import, keyed by `(scope, kind, from, to ?? specifier)` and written sorted with sorted keys (`boundaries/ledger.ts`). **Exits 1** when a measured crossing has no entry, listing each (scope, rule, importer, target, specifier). It never fails because an entry has no crossing: every run rewrites the ledger without the entries whose crossing is gone, among the scopes it measured, and prints them. Improvements are written back; only growth fails. Exits 2 on a malformed ledger, and when `boundary-ceilings.json` exists with no ledger (naming `--migrate-ceilings`). `--json` emits `{ passed, scopesChecked, unrecorded, pruned }` |
| `--boundaries --accept-crossings --reason "<text>"` | The only way the ledger grows: adds every unrecorded crossing, each carrying the reason, and prunes as `--ci` does. With no non-empty `--reason` it exits 2 and writes nothing. `--boundaries --write-ceilings` exits 2 naming `--accept-crossings`; `--comments` and `--collapse` keep `--write-ceilings` |
| `--boundaries --migrate-ceilings` | One-time move off the per-scope count file. Measures every declared scope; if any scope's crossing count exceeds its `boundary-ceilings.json` ceiling it refuses (exit 2, nothing written), else it writes one ledger entry per current crossing (reason `grandfathered from boundary-ceilings.json`) and deletes `boundary-ceilings.json`. Exit 2 with no count file, or with a ledger already present |
| `--data` | Data edges (`Graph.data`, a `DataReport`): one edge per call site on a D1 / Durable Object / KV / R2 / queue binding, kind from the owning worker's wrangler config, access `read` / `write` / `unknown`. Syntax only, so it rides the cheap pass or the edge pass. `--json` emits the report; `--graph --data` carries it on the graph |
| `--thresholds <file>` | Merge partial overrides parsed through `ThresholdsSchema.partial()` |
| `--pretty` | Pretty-print JSON output |
| `--json` | Force JSON output on a view command |
| `--ci [--fail-on high\|warn] [--max <n>]` | Exit non-zero per policy: `--fail-on high` (default) fails only on `high` severity; `--max <n>` fails if smell count exceeds `n` |

**Emitting output — one way, banner-safe.** With no `--out`, a view writes its document to stdout (unchanged). To capture it to a file, prefer `--out <file>`: because the `pnpm code-graph` wrapper prints its run banner to stdout, a bare `… > report.html` redirect interleaves that banner above the document (an invalid artifact, #1761), whereas `--out` writes the file directly and leaves the banner harmlessly on stdout. If you must redirect stdout instead, run banner-free — `pnpm --silent code-graph …` or `tsx tools/code-graph/src/index.ts …` directly.

## 11. Edge cases (nailed)

- **Name collisions** in a file → `id` gets `#ordinal` (source order), stable within a run.
- **Overloads** → only the **implementation** (the bodied declaration) is a node; overload signatures and bodyless/ambient declarations are excluded (§6-A1). A caller resolves to the real function, not a phantom `loc:1` first signature.
- **Parse failures** → the TS parser is error-tolerant and won't throw on syntax errors. A file is recorded in `stats.parseFailures` when the parser's own `parseDiagnostics` array (read off `sourceFile.compilerNode` through a typed module augmentation — it's `@internal`, no Program/language service built, so this is cheap) reports a syntax error, or `addSourceFileAtPath` throws. Absence of the field is treated as "no parse failure" (`Array.isArray` guard). Failed files are excluded from metrics; never crash the run; surfaced in `summary.parseFailures` and in `--file`/`--blast` warnings.
- **External calls** → `external:${name}`, kept (not dropped) so fan-out is visible; excluded from `callChainDepth` (C5).
- **Empty folder** → valid `Graph` with empty arrays, zeroed stats, `health: "healthy"`.
- **Tests** → included, `isTest:true`; renderers may dim them but never drop them.
- **`id` stability** → stable **within a single run**. A stored id from a prior run may not match after edits; the agent should re-run rather than cache ids across edits.

## 12. Build phases (each a runnable commit, verified before the next)

| Phase | Build | Verify |
|---|---|---|
| **0 — Scaffold + schema** | package (adds + pins `ts-morph`), tsup, `schema/` (zod, owns threshold defaults + derives `SmellKind` from `RULES`; `schema.ts` re-exports it) | `tsx` runs; emits empty `Graph` (`health: healthy`); typecheck passes; `ThresholdsSchema.parse({})` yields the defaults |
| **1 — Cheap graph + summary** | `project.ts` (no tsconfig, parse-failure detection), `functions.ts` (+node→id map), `metrics.ts`, `health.ts`; default summary + `--graph` + `--file` | Run on `services/audit-agents`; hand-check one function's line range, hand-count its complexity, confirm a documented function's `commentLines` is **not** double-counted |
| **2 — Smells + plan** | `rules.ts` (keyed table), `plan.ts` (+`--by`), `--smells` + `--plan` | Obviously-long functions rank first; `--by impact` reorders by fan-in; ranking + components pass the smell test |
| **3 — Edges** | **Opt-in** edge pass (triggered by `--edges`/`--blast`/`--deep`, §3): tsconfig-backed load, `calls[]` via node→id map → invert `calledBy` with call-site lines, imports/importedBy, `callChainDepth` (SCC condensation); the edge smells fan-in / deep-chain. `directories.ts` + the `directory-sprawl` smell run in the **cheap** pass (§8-C4). `--blast` + `--deep`. | Pick a known util, confirm `calledBy` call-sites match a grep; confirm recursion doesn't infinite-loop the chain; `--blast` in package scope warns about omitted cross-package callers; default run stays fast with only cheap-pass smells (+ directory-sprawl). |
| **4 — Agent ergonomics** | `--tree`, `--ci` (+`--fail-on`/`--max`); CLAUDE.md routing row so agents discover it | Dogfood on a real refactor |

**Order rationale:** schema first (no rework, SSOT locked); cheap pass + summary next (the default output, most value, zero perf risk); IP (smells/plan) third; the only perf-sensitive pass (edges) last, kept cheap via inversion. Phase 4 makes the tool *discoverable*.

**Verification discipline:** every phase validated against `services/audit-agents`, with ≥1 hand-checked number per phase before relying on the output in a real refactor.
