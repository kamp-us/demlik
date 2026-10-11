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
| Where a name is declared, whether it is exported, who uses it (any kind) | `code-graph X --find <name>` |
| Full graph (rarely — large) | `code-graph X --graph` |
| Comment census — how much comment, of what kind, where | `code-graph X --comments` |
| Comment ratio ratchet (a gate) | `code-graph . --comments --ci` |
| What a package publishes, per export subpath (§13) | `code-graph <pkg> --api <map>` |
| What a branch did to it, and does it owe a changeset (§13) | `code-graph <pkg> --api <map> --api-base <rev> [--api-policy <file>]` |

`--blast` requires an unambiguous target; pass the `id` (`file:name`), not a bare name. In default (`package`) scope, blast output is flagged incomplete for cross-package callers (§10).

## 3. Architecture

- **Two engines behind one seam (`src/engine/`).** oxc (`oxc-parser` + `oxc-resolver`) reads syntax and resolves module specifiers; tsgo (`@typescript/native-preview`, its `unstable/sync` API, pinned to one exact build) answers symbol questions. `src/engine/tsgo.ts` is the only module that imports tsgo, and oxc is imported only under `src/engine/` (`seam.test.ts` holds both). No hand-rolled parsing, ever; comment ranges follow TypeScript's leading/trailing rules (`src/syntax/trivia.ts`).
- **Two-pass loading:**
  1. **Cheap pass** — every visible source file parsed by oxc, **no tsconfig**, syntax only. Fills `name, file, lines, loc, commentLines, nestingDepth, complexity, imports`. No checker is started, so this is fast. `provenance.pass = "cheap"`.
  2. **Edge pass** — the target's nearest tsconfig drives module resolution (oxc-resolver) and a tsgo program over that tsconfig's files plus every loaded file. Resolves `calls[]`; `calledBy[]` is derived by **inverting** `calls[]` (never `findReferences`, which forces the whole monorepo into RAM). `provenance.pass = "edges"`. `--boundaries` reads only the import edges and each file's syntax tree (for the world doors it uses by name, the modules it runs, when a deployable kind is listed the worker bindings it references, when B15 is listed the first form of an entry file that is not a named re-export, and when a read allowance is declared the first data write of each driven file it lists) and, for a deployable kind or a read allowance, the wrangler configs, read once, so it never starts tsgo.

**The edge pass is opt-in.** Only `calls`/`calledBy`/`importedBy`/`callChainDepth`, declaration `uses` (C6) and the smells `high-fan-in` + `deep-call-chain` require it. It runs when **any** of these is passed: `--blast <id>` (required — blast radius is a callers query), `--find <name>` (its answer carries uses), `--deep` (implies edges + monorepo scope), or `--edges` (opt-in; makes summary/plan/smells/graph include edge data + edge smells). With no flag the run stays cheap/fast (cheap-pass smells only, plus `directory-sprawl` which needs no type info — see §8-C4).
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
    declarations/
      discover.ts         enumerate top-level declarations (A1's second set) on oxc's tree
      uses.ts             join them to tsgo's tree and resolve their uses (C6)
      find.ts             --find: every function and declaration node of one bare name
    engine/     the seam: oxc.ts (oxc-parser + oxc-resolver), tsgo.ts (the one tsgo import), seam.test.ts
    syntax/     file.ts (oxc's tree, parents, TypeScript-shaped children, lines), trivia.ts (TypeScript's
                comment ranges), imports.ts (import literals and their resolution), headers.ts
                (a function node's declaration header and overload signatures, §6 A5)
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
    api.ts      barrel for the `./api` library subpath (§13.7)
    api/        the published-API mode (§13) — map.ts + emit.ts + read.ts + text.ts + view.ts +
                base.ts + diff.ts + cli.ts, and ratchet/ (§13.5): policy.ts + changesets.ts +
                verdict.ts + text.ts
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
  // Present ONLY on a `--headers` run (A5) and ABSENT otherwise — not `null`, unlike
  // `edges`: the field is opt-in output, not an uncomputed measurement, and a run
  // without the flag prints byte-for-byte what it printed before the field existed.
  header?: {
    text: string;           // the declaration header, a verbatim slice of the file (A5)
    overloads: { startLine: number; text: string }[];  // source order; [] when none
  };
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

type DeclarationKind = "type-alias" | "interface" | "enum" | "class" | "constant";
//  ^ never a FunctionKind, so a kind alone says which node set a node belongs to.

type UseSite = { file: string; line: number };

type DeclarationNode = {
  id: string;            // `${file}:${kind}:${name}`; a same-kind, same-name repeat in one file (a merged
                         //   interface or enum) appends `#${ordinal}` in source order. The `kind:` segment
                         //   keeps it apart from every FunctionNode id and from a merged partner of
                         //   another kind (`interface Foo` + `const Foo`).
  name: string;          // `default` for an anonymous `export default class`
  kind: DeclarationKind;
  file: string;          // relative to the analyzed root
  line: number;          // the line of the declaration's first token (`export` included; for a
                         //   constant past its statement's first declarator, its own name)
  isExported: boolean;
  isTest: boolean;
  uses: UseSite[] | null; // C6; edge pass only. `null` = the edge pass did not run (or the node did
                          //   not join tsgo's tree), never `[]`, which reads as measured-unused
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
  // D1 / Durable Object / KV / R2 / queue binding (docs/reference/analyses.md#storage-access).
  data: DataReport | null;
  functions: FunctionNode[];
  declarations: DeclarationNode[]; // A1's second set; sorted by (file, line, kind, id). In every
                                   //   graph, cheap or edge; no summary, plan or smell reads it
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

### A1 — what gets a node
Two node sets, widened from "named callables only" on the founder's ruling (https://github.com/kamp-us/demlik/issues/599#issuecomment-6102379297): function nodes exactly as below, and declaration nodes for the top-level declarations that are not functions.

**Declaration nodes (`DeclarationNode`, §5).** One per **top-level** statement of a loaded file (a direct child of the file, or of its `export` / `export default` wrapper) of kind: type alias (`type-alias`), interface (`interface`), enum and `const enum` (`enum`), class and abstract class (`class`), and each `const` declarator whose binding is a plain identifier (`constant`). A `declare` form counts as its plain form (`declare class`, `declare const`). Not a node: a `const` bound directly to an arrow or function expression (it is already a function node, so no name gets two), a destructured `const`, `let` / `var` / `using`, anything inside a function, class, `namespace` / `module` or `declare global` block, `export default <expression>`, and a function or overload signature (functions are the other set). Merged declarations stay one node each (`interface Foo` twice; `interface Foo` + `const Foo`). `isExported` is true when the statement carries `export` / `export default` or the file exports the name from its own top level (`export { Foo }`, `export default Foo`, `export = Foo`). Discovery is syntax only and runs in the cheap pass; uses are C6's. No metrics, smells, or header text.

**Function nodes.** Include: function declarations, class methods, constructors, get/set accessors, and arrow / function-expressions **assigned to a name** (variable, property, default export). **Exclude** anonymous inline callbacks (`arr.map(x => …)`) from the function list — but still count their nodes toward the **enclosing** function's `nestingDepth` and `complexity`. **Also exclude overload signatures and ambient/bodyless declarations** (`node.isOverload()` or `!node.hasBody()` on a `FunctionDeclaration`/`MethodDeclaration`): only the **implementation** (the one with a body) is enumerated, so a caller resolves to the real function — not to a phantom `loc:1` first signature — and calls to ambient stubs become honest `external:*`. The rule covers every class member, not only methods: a bodiless **constructor** (an overload signature, or one in a `declare class`) and a bodiless class **get/set accessor** (`abstract`, or in a `declare class`) are not nodes either. **One exception, kept on purpose:** an interface's `get` / `set` signature is a node although it has no body, because it is the only declaration of that accessor. (An overload's text is still reachable, as the implementation's `header.overloads` on a `--headers` run — A5 — never as a node.) One `forEachDescendant` pass switching on `node.getKind()`. Record each node in the node→id map (§3).

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

### A5 — function headers (`--headers` only; `syntax/headers.ts`)
One rule for every function kind (declaration, method, constructor, getter, setter, arrow, function expression, default-export function):
- **The text is a verbatim slice of the file** — never reformatted or normalized.
- **It starts where `startLine` places the node.** An exported declaration's `export` / `export default` is included, as are a member's modifiers (`static`, `async`, accessibility, `get` / `set`). An arrow or function expression starts at its own first token (`async`, `<T>`, `(` or `function`), not at the binding that names it — the binding's name is the node's `name`.
- **It ends at the last token before the body**, so it holds the name, type parameters, parameters and return type as written and no part of the body. An arrow's header therefore ends on its `=>`, whether the body is a block or an expression. Whitespace and comments between that token and the body are not part of it.
- **No leading comment or JSDoc** — a comment above the function sits before the node's start and is never part of the header. Comments *inside* the header (between parameters, say) stay, because the text is verbatim.
- **A node with no body** (an interface `get`/`set`, a bodiless member) runs to its end, less the closing `;` or `,`.
- **Overloads** — on a bodied function declaration, method or constructor, `overloads` lists the unbroken run of same-named bodiless signatures directly above it (for a method: same name, same `static`-ness, same kind), in source order. Each carries its own `startLine` (its `export` included) and its text by the same rule, less the closing `;`. The comments between overloads are not part of any. Every other node lists `[]`. A1 still holds: an overload signature is **never** a node — this field is the only place one appears.

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
| **C6 declaration uses** | Edge pass only (`DeclarationNode.uses` is `null` in the cheap pass). Each declaration node joins tsgo's tree by `(kind, name, ordinal of that pair in source order)` over the file's top-level statements, read the same way on both sides; one that does not join keeps `uses: null` and is named in a stderr warning. A **use** is any identifier in a loaded file whose symbol — after following import and export aliases to the end (`getAliasedSymbol`), and for a `{ X }` shorthand property the value it reads — has the declaration among its declarations, except the declaration's own name. So import and re-export specifiers count (`import { X as Y }` and `export { X } from`), as do type positions, value positions, `new X()`, `extends` / `implements`, `typeof X`; a same-named local in another scope resolves to its own symbol and does not. A merged symbol's use counts for each of its declaration nodes. Only identifiers spelled like a declaration name or like a local an import binds are sent to the checker (only those can resolve to a top-level declaration), so the cost stays one batched symbol query per file. One `UseSite` per (file, line); sorted by (file, line). Only loaded files are walked, so in either scope a use outside the analyzed directory is not seen. |

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
| `--find <name>` | Name lookup over both node sets (§6 A1): every `FunctionNode` and `DeclarationNode` whose `name` is exactly `<name>`, printed as JSON `{ name, scope, matches }` (`--pretty` indents it). Each match is `{ id, name, kind, file, line, isExported, uses }`, sorted by (file, line, id); `line` is a function's `startLine` or a declaration's `line`. A declaration's `uses` are C6's; a function's are its `calledBy` sites as `{ file, line }` (the caller's file), one per (file, line). **Several matches are data, not an error:** exit 0 whatever the count, and no match prints `matches: []` with a stderr warning. Runs the edge pass (like `--blast`) |
| `--edges` | Opt-in edge pass at `package` scope (§3): summary/plan/smells/graph include `calls`/`calledBy`/`importedBy`/`callChainDepth` and the edge smells (`high-fan-in`, `deep-call-chain`). Without it (and without `--blast`/`--deep`) the run stays cheap. |
| `--deep` | Edge pass loads the whole monorepo (C3); implies `--edges` at `deep` scope |
| `--headers` | Every `FunctionNode` in the JSON (`--graph`, `--file <f> --json`, `--tree --json`) carries `header`: its declaration header as written and its overload signatures with their start lines, by the §6-A5 rule (starts where `startLine` places the node, ends at the last token before the body, an arrow's on `=>`, no leading comment). Overloads appear only through this field; they are never nodes (§6-A1). Rides either pass. Without the flag `header` is absent and every output is unchanged |
| `--html` | Emit a self-contained HTML report (human view — header + hotspot treemap + hub call-graph + sortable top-targets table; see `HTML-VIEW.md`). **Implies the edge pass** (the call-graph section needs `calls`). Pair with `--out <file>` to write the report directly (banner-safe); never an agent surface |
| `--out <file>` | Write the view payload straight to `<file>` via `fs.writeFileSync` instead of stdout. The **banner-safe** artifact path (#1761): under the `pnpm code-graph` wrapper, pnpm's run banner lands on stdout, so `… --html > report.html` prepends the banner to the file — `--out` sidesteps stdout entirely, so the file carries only the document. Applies to every view (`--html`, `--graph`, `--smells`, `--plan`, `--tree`, `--file`, `--blast`, default summary). A one-line `wrote N bytes to <file>` confirmation goes to **stderr**, never the file |
| `--comments` | Comment CENSUS. Every comment range from `extract/metrics.ts`'s `collectModuleCommentRanges` (the SAME walk `ModuleNode.commentLines` counts — the census total and `stats.totalCommentLines` are one computation) gets exactly ONE bucket, first match wins: `pragma` → `license` → `marker` → `commented-out-code` → `banner` → `file-header` → `docblock` → `block` → `inline`. Each bucket rolls into exactly one CLASS via `classOf` (an exhaustive switch, so a tenth bucket cannot skip the question): **`mechanical`** = `banner` + `commented-out-code` (removable with no judgment), **`protected`** = `pragma` + `license` + `marker` (never touch), **`prose`** = the rest (the volume — a comment carrying rationale is not a defect, and the tool passes no verdict on it). The three classes partition `commentLines`. Lines are attributed to the FIRST range covering them, so per-bucket lines partition the file's comment lines exactly. Rolled up by bucket, by package scope (`discoverPackageRoots`, longest match), and by file, ranked by comment lines descending, tiebroken on path. Human view caps files and scopes at 20; `--json` emits the whole `CommentCensus`. Report only. Standalone (cheap pass, no Graph) |
| `--comments --ci` | Comment RATCHET over the SAME `CommentCensus` (`comments/gate.ts` owns the one load — no mode recomputes a ratio). Each scope's `ratio`, expressed in percentage points at 1 dp, is compared to `comment-ceilings.json` at the repo root (`{ default, slackPoints, scopes }`, parsed through `config.ts` — a typo'd key or wrong-typed value exits 2 with one line). Two failure directions: **EXCEEDED** (`measured > ceiling`) and **SLACK** (`ceiling − measured > slackPoints`), the latter being the ratchet — a ceiling far above reality is no longer a ceiling. A scope with no recorded entry inherits `default` and is checked for EXCEEDED only. Exit 1 on any violation, 0 otherwise; `--json` emits the `RatchetVerdict`. `--write-ceilings` rewrites the file from the current measurement, ceilings rounded UP to 1 dp, `default`/`slackPoints` carried forward, vanished scopes dropped |
| `--boundaries` | Boundary report over each scope the boundary rules declare at or under the analyzed path (`boundaries/analyze.ts`), exit 0. From each file's import edges: **B1** a feature importing another anywhere but its `index.ts`; **B2** a feature's `rules/` importing anything but its own `rules/` and the declared `contracts`; **B3** `lib` importing a feature; **B4** a file in no feature and no `lib` importing a feature anywhere but its `index.ts`. From each file's syntax tree, over one world-door catalog (`boundaries/doors.ts`, one row per door, and one row for the family `process.<member>`, every static member of `process` being its own door; `boundaries/door-uses.ts` reads a file once and returns its uses as plain data): **B2** also fires on any catalog door used by name inside `<feature>/rules/**`, once per file per door (`process.hrtime()` and `process.hrtime.bigint()` are one `process.hrtime`); **B5 `door-outside-owner`** fires on a use of a door the rules file's `doors` key declares (`{ "<scope>": { "<door>": ["<scope-relative owner file>", …] } }`) in a file that is not one of its owners, anywhere in the scope but `rules/`, where B2 alone reports it. A use belongs to the most specific declared door that is a path prefix of it. A module door (`node:fs`, `node:child_process`) is opened by a runtime import: the syntax tree says which specifiers a file runs (`runtimeSpecifiers` in `syntax/imports.ts`), the import edge only where one resolves. Not a use: a type position, a type-only import in any spelling (`import type`, `import { type Stats }`, `export { type Stats } from`, `import type x = require()`, a type-position `import()`), a bare `process`, `process[k]`, a name the file binds itself (per file, fails open), and anything that needs data flow. A bad `doors` declaration (a door outside the catalog, the bare `process`, a member the running `process` lacks, a scope with no `features`, an owner naming no loaded file, an owner under `rules/`) exits 2 and writes nothing. The members are read by name off the running `process` (own and inherited, no getter run) once where the rules file is read, and gate declarations only: detection, ledger entries and reports never consult them. Which members exist depends on the Node version, the platform and the launch mode (`getuid` is POSIX-only, `send` needs an IPC channel), so the refusal names the nearest member and the Node version and platform that judged it. The check ends at the member, because what lies below one is the runtime's. **Feature layout:** the rules file's `layout` key (`{ "<scope>": "rules" \| "hexagonal" }`, default `rules`) selects one row of one table keyed by layout name (`ZONINGS` in `boundaries/rules.ts`), which zones each feature file by its path. A `hexagonal` feature's zones are `index.ts`, `ports.ts`, `application/**`, `adapters/driving/**` and `adapters/driven/**`; any other entry is in no zone. It adds **B6 `application-imports-adapter`** (`application/` importing its own feature's `adapters/`), **B7 `impure-application`** (any catalog door used by name or module door opened in `application/`, declared or not, in place of B5), **B8 `driving-reaches-driven`** (`adapters/driving/` importing its own `application/` or `adapters/driven/`, except a driven file a read allowance licenses, below), **B9 `door-outside-driven-adapter`** (a declared door used in `index.ts`, `ports.ts` or `adapters/driving/`, in place of B5; every catalog door in a scope `strictDriving` names, below) and **B10 `unknown-zone`** (one entry per feature entry in no zone, `from` the entry's path, `specifier` the entry). A file in no feature and no `lib` may import any feature's `adapters/driving/` and `adapters/driven/` (the composition root). A `layout` for a scope with no `features`, an unknown value, or a door owner in a hexagonal `index.ts`, `ports.ts`, `application/` or `adapters/driving/` exits 2 and writes nothing. **Library types:** the rules file's `libraryTypes`, `libraries`, `libraryRoots` and `worldLibraries` keys (`boundaries/libraries/schema.ts`) declare libraries of named types as a table (`{ "<type>": { imports, pure, importedFrom? } }`, not `--layers`' total order, in which `adapter` and `ui` could not be siblings). The five-type example: `contract` imports `contract` and `util`; `kernel` imports `kernel`, `contract` and `util`; `util` imports `util`; `adapter` imports `contract`, `kernel` and `util`, is not pure and is `importedFrom` `["driven"]`; `ui` imports `ui`, `contract`, `kernel` and `util`; `contract`, `kernel`, `util` and `ui` are `pure`, with `"libraryRoots": ["packages"]` and `"libraries": { "packages/orders-contract": "contract", "packages/clock-adapter": "adapter" }`. A `worldLibraries` entry is a glob in which `*` stays within one segment of the name, and it matches the package and its subpaths (`@sentry/*` matches `@sentry/node` and `@sentry/node/integrations`, never `@sentryx/node`). Each declared library is a scope named by its directory, beside one scope per `libraryRoots` entry. A bare specifier, or a subpath of one, resolves to the workspace package of that name (`workspacePackages` and `matchPackage` of `layers/resolve-target.ts`, shared; never `exports`, never tsgo), and `boundaries/libraries/violations.ts` judges the edges and door uses already read: **B11 `library-undeclared`** (a package at any depth under a `libraryRoots` entry that `libraries` does not name, one entry per package: scope the root, `from` the package directory, `specifier` its path below the root), **B12 `library-imports-up`** (an import to a library whose type is not in the importer's `imports`, one entry per importer file and library however many specifiers or subpaths, `to` the library's directory, type-only imports judged; an import of an undeclared workspace package is counted, not judged), **B13 `impure-library`** (in a `pure: true` library any catalog door used by name or opened as a module, and any `worldLibraries` specifier imported in any spelling, one entry per file per door or per specifier as written; a call on an injected object names no door and is not seen) and **B14 `adapter-library-imported-outside-driven`** (an import of a library whose type lists `importedFrom` zones, from a file in none of them: `driven` is a hexagonal feature's `adapters/driven/`, `configurator` a file outside every feature, a library's own files included, and `any` no constraint; `to` the library's directory). A library's import is one verdict, B12 first. A type used in `libraries` and absent from `libraryTypes`, a type in an `imports` that is not declared, an `importedFrom` zone outside the three, a `libraries` path that is no package root, a `libraryRoots` entry that is no directory, a `worldLibraries` entry that is no glob or matches a catalog door (whose ledger entry it would share) exit 2 and write nothing. **Application shape:** six keys of the rules file (`boundaries/shape/schema.ts`) judge a hexagonal feature's own files. The example: `{ "applicationShape": ["index-not-exports-only", "application-import-outside-allowlist"], "applicationMayImport": ["contract", "kernel", "util"], "pureDependencies": ["zod"], "testFiles": ["**/*.test.ts"], "strictDriving": ["services/api"], "readAllowance": { "services/api": { "driven": ["src/orders/adapters/driven/order-reads.ts"], "decidedBy": ["kernel"] } } }`. `applicationShape` is the list of kind names that run (none by default; a kind outside the two exits 2), so a release that adds a kind never fails the gate of a repo that did not name it. **B15 `index-not-exports-only`**: the entry file of a declared library (`src/index.ts` of its own scope; an inner barrel such as `src/schema/index.ts` is not judged) or of a hexagonal feature (`src/<feature>/index.ts`, the `exportsOnly` column of the zone table, `true` for `index` alone; a `rules`-layout feature's is not judged) whose first statement that is not a named re-export (`firstOffendingForm` of `boundaries/shape/entry-file.ts`, read from the syntax tree where the file is loaded and only for a file named `index.ts` with B15 listed) is one of six forms: `export *` (also `export * as ns from` and `export type * from`), `export default`, `local export` (`export { a }` with no `from`), `import`, `declaration` (a `const`, `function`, `class`, `type`, `interface` or `enum`, exported or not) and `statement` (anything else, `export {} from` included, which names no member). A named re-export is any `export … from` that names its members, and an empty file is clean. One entry per file: scope the file's, `from` the file, `to` null, specifier the first offending form in source order, which is the whole identity, so a file that fixes its first form and keeps another is a new entry. **B16 `application-import-outside-allowlist`**: an import of an `application/` file of a hexagonal feature (the `importAllowlist` column of the zone table: the zones of its own feature it may import, `ports` and `application`) other than another feature's front door, a `lib` folder file, a workspace library whose type `applicationMayImport` lists (a list of `libraryTypes` names; no default, no built-in type name) and a package a `pureDependencies` glob matches (`inPackageGlobs` of `boundaries/libraries/libraries.ts`, the matcher `worldLibraries` uses, so a package and its subpaths with `*` inside one name segment). Type-only imports are judged. One verdict per import: an import another kind judges is that kind's alone (`boundaries/shape/application.ts` leaves B1 and B6 the edges `judged` for them, B14 a library whose type names an `importedFrom` that does not include the zone, and B7 a module door the file opens when it runs, `moduleDoorsOpened`; a type-only import of `node:fs` stays B16's). One entry per file and target: `to` the file when the import lands in one the scope loads (scope-qualified), null for a package or a path it does not load, specifier as written (the first of the file's edges), `typeOnly` only when every import of the target is. B16 never runs outside `application/` or in a `rules`-layout feature. `applicationMayImport` and `pureDependencies` while B16 is not listed, an `applicationMayImport` or `decidedBy` type `libraryTypes` lacks, a `pureDependencies` or `testFiles` entry that is no glob, a `strictDriving` or `readAllowance` scope with no `features` or whose layout is not `hexagonal`, an empty `driven`, a `decidedBy` that is present and empty, a `driven` file not under a feature's `adapters/driven/` (`shapeDeclarationIssue` of `boundaries/shape/declaration.ts`) or that the scope does not load, and, with `readAllowance` declared, a wrangler config the run cannot parse (`readShape` of `boundaries/shape/shape.ts`) exit 2 and write nothing. **Test role:** `testFiles` is a list of globs of `kinds/glob.ts`, each matched against a file's scope-relative path and against its repo-relative path (`isTestFile` of `boundaries/zones/test-role.ts`; at scope `.` the two are one string), in every scope the pass reads, so a glob that matched before still matches and one such as `services/*/test-support/**` reaches worker scopes alone; a matched file sits in no zone. Which kinds judge it is one table with a row per kind (`JUDGES_TEST_FILES` of `boundaries/zones/test-role.ts`, `satisfies Record<BoundaryKind, boolean>`, so a kind added later does not compile until it has a row): B1, B2, B3, B4, B5, B12, B14 and B19 do, B6, B7, B8, B9, B10, B13, B15, B16 and B17 do not (B11 and B18 hold no file). Every kind judges the file and the table then drops the rest, and a matched file is never a `unknown-zone` entry, so an entry holding only matched files is none. A rules file without `testFiles` judges every file as before. **Strict doors:** `strictDriving` names the scopes where the zones that judge declared doors (B9: `index.ts`, `ports.ts`, `adapters/driving/`) judge every catalog door a file uses or opens (`doorsUsed` of `boundaries/zones/door-violations.ts`): a use takes the most specific declared door that is a path prefix of it, else the catalog's name for it, so a declared door keeps the entry it had. **Read allowance:** `readAllowance` (`{ "<scope>": { driven: [...], decidedBy?: [...] } }`) is B8's declared exception (`boundaries/zones/reads.ts`): a driving file importing a listed driven file of its own feature is not B8 when it also imports, when it runs (`runtimeSpecifiers`), a library whose type is in `decidedBy`; it never licenses `application/` or an unlisted file. `decidedBy` is optional: a scope's entry that leaves it out says the reads of the scope decide nothing, so a listed read-only driven file is licensed for any driving file of its feature, whatever else that file imports (`ScopeAllowance.decidedBy` is then `null`, decided in `drivenReadsOf` after the write check, with no second key or flag). Omission is the only spelling: `decidedBy: []` exits 2 as an allowance that grants nothing. The tool does not check that such an adapter decides nothing; review holds it, as it holds an ORM write. A rules file judges each scope by its own entry. A listed file whose worker's data binding it writes through (`firstWrite`: the call-site finder `--data` runs, over `ServiceManifest.dataBindings`, and `accessOf` as `--data` computes it, so a D1 `prepare` or `exec` of a literal `INSERT`, `UPDATE`, `DELETE`, `REPLACE`, `CREATE`, `DROP` or `ALTER`, a KV or R2 `put` or `delete`, a queue `send`) is never licensed: every driving file that imports it is B8 as if undeclared, and the report names the first write in source order (`write: { file, line, binding }` on the `--json` row, a `[write: …]` note on the plain row and the `--ci` failure line, none of it in the ledger entry, whose shape and key are any B8's). What it cannot see: an ORM write, a site `accessOf` calls `unknown` (a non-literal SQL string, a Durable Object stub), and a binding read through an object not named `env`. **Across deployables:** the rules file's `acrossDeployables` and `bindingOwners` keys (`boundaries/deployables/schema.ts`) add three rules that run **only when listed**: `acrossDeployables` is the list of kind names to run (none by default; a kind outside the three exits 2), so a release that adds a kind never fails the gate of a repo that did not name it. A wrangler config the run cannot parse exits 2 and writes nothing when B17 or B18 is listed (`unreadableConfigsIssue` of `boundaries/deployables/deployables.ts`): one line naming each such file, so a worker is never dropped from the judgment silently. A `.json` or `.jsonc` config cannot be parsed when it has any syntax error, read as wrangler's `parseJSONC` reads it (`readConfigDocument` of `extract/wrangler-config.ts`: comments, trailing commas and a leading BOM are fine, an error anywhere in the file counts, none is repaired), and a `.toml` config when it has a syntax error; a config that is not an object is unread too. `--data`, `--cross-runtime` and `--env-keys` print the same files as `UNPARSED CONFIG` and read nothing from them (`--env-keys` withholds the reads under one as `read-site-owner-unparsed`, and a read is judged by the nearest wrangler config above its file, parsed or not); B19 reads no config and a rules file listing neither is not refused for one. **B17 `binding-outside-driven-adapter`**: a reference to a binding the owning worker's deploy config declares (a service binding, or a D1, Durable Object, KV, R2 or queue binding, one row per kind of `JUDGED` in `boundaries/deployables/deployables.ts`; a Workflow binding is `false`), in a file of a read scope (a feature scope's or a declared library's) that is not under a hexagonal feature's `adapters/driven/` (the `touchesBindings` column of the zone table, `true` for `driven` alone) and is not the `main` of the worker it is judged against (`isWorkerMain` of `boundaries/deployables/deployables.ts`: the file that worker's wrangler config names, `ServiceManifest.main` made repo-relative where the config is read, which wires the worker's own bindings to the adapters; a config with no `main`, or one naming no file the scope loads, cleans nothing), one entry per file per binding: scope the file's, `from` the file, `to` null, specifier the binding's name. A file's worker is the nearest wrangler config above it (`ownerOf` of `extract/cross-runtime.ts`), top-level environment only, as `--cross-runtime`; a `main` is clean only for that worker, so a file one worker names as `main` that sits under a nearer worker's directory is judged against the nearer worker, and the census still counts a `main`'s sites. The references are the call-site finder `--data` runs (`bindingSites` of `data/extract.ts`, generic over what a binding is, so `--data`'s `DataBindingKind` and output are unchanged): syntax only, `env.X`, `this.env.X`, `c.env.X`, `env["X"]`, one level of aliasing, a destructure off `env`, a binding handed on whole as an argument; a binding reached through an object not named `env`, more than one level of aliasing, an `env.<name>` block of the config and Hyperdrive are not seen. A test file is judged like source unless `testFiles` names it (the test role, above), and then B17 does not judge it while B19 still does. `bindingOwners` (`{ "<scope>": { "<binding>": ["<scope-relative owner file>", …] } }`) narrows a binding to exact files and never exempts a file from the driven adapters: with an owner list a binding is clean only in a listed file that is also under `adapters/driven/`, or in the worker's `main`, which the list does not narrow because wiring a narrowed binding to its adapter is `main`'s job. Listed without B17, for a scope with no `features`, with an owner that is no file the scope loads, that is not under a feature's `adapters/driven/`, that sits under no worker config, or for a binding the owning worker does not declare, it exits 2 and writes nothing. **B18 `worker-call-cycle`**: a strongly connected component of two or more workers (`stronglyConnectedComponents` of `extract/scc.ts`) over the declared service-binding graph of every wrangler config in the repo (`boundaries/deployables/cycles.ts`; `services[]` entries of the top-level environment only, a worker named by its config's `name`, else its directory's): one entry per component, scope `.`, `from` the workers sorted and joined with `, `, `to` null, specifier the edges inside the component, each `<worker>.<BINDING> -> <worker>`, sorted and joined with `; `. The declared graph is used on purpose: it is cheap, and a binding declared and never used is itself drift. A binding to a worker with no config in the repo is no edge and is counted; a Durable Object or Workflow binding with a `script_name` is no edge; a worker that binds itself is no cycle. A component that gains a worker or an edge is a new entry and the old one is pruned. Only a run whose analyzed path is the repo root measures it (`reconcile` leaves a scope outside the analyzed path alone); `--migrate-ceilings` measures it with every declared scope. **B19 `relative-import-crosses-workspace`**: a relative import (`isRelativeName` of `syntax/imports.ts`; static, `export … from`, dynamic and type-only) whose target path, the specifier joined onto the importer's directory, sits in another workspace than the importer's, each the nearest ancestor directory holding a `package.json` (the repo root only when it holds one); a file or target in no workspace is placed in the scope root. No resolution is done, so a path that does not exist is judged, and a bare specifier and a path alias are not. One entry per importer and other workspace: `from` the importer, `to` the target's workspace directory (`.` the repo root), specifier the first one written, `typeOnly` only when every import of that workspace is. A file under a library nested in a feature scope is judged in the library's own scope only, as for B12-B14. With a library key declared the report gains a census (`libraries`: the libraries per type, the undeclared packages, the imports left unjudged), and with a deployable kind listed another (`deployables`: per worker that holds a binding site, its sites as `{ file, line, binding }`, the files and the bindings with their site counts, and the service bindings in the repo to a worker with no config in it; the B18 scope's report lists its workers). `--cross-runtime` accepts any receiver of a binding call and resolves it with the type checker, the census only `env`, a `.env` member and one level of alias, and every service-binding call `--cross-runtime` reports has a census site on the same file, line and binding. A rules file that declares none of the library keys, lists no deployable kind and declares none of the six shape keys is exactly as before: no wrangler config is read, no further repo listing is made, the report, the ledger and the graph are unchanged, and `--json` gains no key; a rules file that declares a `readAllowance` lists the repo once and reads the wrangler configs once, shared with any deployable kind. The graph JSON and `ModuleNode` gain nothing; `ImportEdge.typeOnly` still means only `import type` / `export type … from` |
| `--boundaries --ci` | Boundary LEDGER gate (`boundaries/gate.ts`). `boundary-ledger.json` at the repo root holds one entry per crossing import (B1–B4, B6, B8, B12 and B14 between libraries, B16, an `application/` import outside its allowlist, and B19 between workspaces), per world-door use (B5, B7, B9, a door used by name in `rules/`, B13, and B17, a worker binding) and per entry no rule places (B10, a feature's, B11, a package's, B15, an entry file that holds more than named re-exports, and B18, a loop of workers), `{ scope, kind, from, to, specifier, global?, reason? }` with `to` null for a B2 bare import or a B16 import of a package or a path the scope does not load (where `specifier` is the target as written), for a door or world library (kind `door-outside-owner`, `impure-application`, `door-outside-driven-adapter`, `impure-library`, or `impure-rules` with `global: true`, where `specifier` is the door, or the library as written), for a `binding-outside-driven-adapter` entry (where `specifier` is the binding's name) and for an `unknown-zone`, `index-not-exports-only`, `library-undeclared` or `worker-call-cycle` entry (where `specifier` is the entry: for B15 the first offending form of the entry file `from` names, for the cycle, the edges between the workers `from` lists), and `to` a library's directory, not a file, for B12 and B14, and a workspace's directory for B19, keyed by `(scope, kind, from, to ?? specifier)` plus `global` (so a global `fetch` and a bare `import "fetch"` are two entries) and written sorted with sorted keys (`boundaries/ledger.ts`). An entry is one file per door however many sites use it. **Exits 1** when a measured crossing has no entry, listing each (scope, rule, importer, target, specifier). It never fails because an entry has no crossing: every run rewrites the ledger without the entries whose crossing is gone, among the scopes it measured, and prints them. Improvements are written back; only growth fails. Exits 2 on a malformed ledger, and when `boundary-ceilings.json` exists with no ledger (naming `--migrate-ceilings`). `--json` emits `{ passed, scopesChecked, unrecorded, pruned }` |
| `--boundaries --accept-crossings --reason "<text>"` | The only way the ledger grows: adds every unrecorded crossing, each carrying the reason, and prunes as `--ci` does. With no non-empty `--reason` it exits 2 and writes nothing. `--boundaries --write-ceilings` exits 2 naming `--accept-crossings`; `--comments` and `--collapse` keep `--write-ceilings` |
| `--boundaries --migrate-ceilings` | One-time move off the per-scope count file. Measures every declared scope; if any scope's import-edge crossing count (B1–B4, B6 and B8 imports, a B8 reported for a write included, not world-door, `unknown-zone`, library (B11–B14), shape (B15, B16) or deployable entries (B17–B19), which the count never measured) exceeds its `boundary-ceilings.json` ceiling it refuses (exit 2, nothing written), else it writes one ledger entry per current crossing, door, library, shape and deployable entries included, library scopes and the worker call graph's scope `.` measured like any other (reason `grandfathered from boundary-ceilings.json`), and deletes `boundary-ceilings.json`. Exit 2 with no count file, or with a ledger already present |
| `--data` | Data edges (`Graph.data`, a `DataReport`): one edge per call site on a D1 / Durable Object / KV / R2 / queue binding, kind from the owning worker's wrangler config, access `read` / `write` / `unknown`. Syntax only, so it rides the cheap pass or the edge pass. `--json` emits the report; `--graph --data` carries it on the graph |
| `--thresholds <file>` | Merge partial overrides parsed through `ThresholdsSchema.partial()` |
| `--pretty` | Pretty-print JSON output |
| `--json` | Force JSON output on a view command |
| `--ci [--fail-on high\|warn] [--max <n>]` | Exit non-zero per policy: `--fail-on high` (default) fails only on `high` severity; `--max <n>` fails if smell count exceeds `n` |
| `--api <map>` | Published-API view: per export subpath, every published name with its emitted declaration text (§13.3). Standalone; reads emitted declarations, never the graph |
| `--api-base <rev>` | With `--api`: the API diff against a base commit (§13.4) |
| `--api-policy <file>` | With `--api` and `--api-base`: the bump ratchet (§13.5). Exit 1 on a miss |

**Emitting output — one way, banner-safe.** With no `--out`, a view writes its document to stdout (unchanged). To capture it to a file, prefer `--out <file>`: because the `pnpm code-graph` wrapper prints its run banner to stdout, a bare `… > report.html` redirect interleaves that banner above the document (an invalid artifact, #1761), whereas `--out` writes the file directly and leaves the banner harmlessly on stdout. If you must redirect stdout instead, run banner-free — `pnpm --silent code-graph …` or `tsx tools/code-graph/src/index.ts …` directly.

## 11. Edge cases (nailed)

- **Name collisions** in a file → `id` gets `#ordinal` (source order), stable within a run.
- **Overloads** → only the **implementation** (the bodied declaration) is a node; overload signatures and bodyless/ambient declarations are excluded (§6-A1). A caller resolves to the real function, not a phantom `loc:1` first signature. Their text reaches the output only through the implementation's `header.overloads`, on a `--headers` run (§6-A5).
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

## 13. Published-API mode (`--api`)

An opt-in mode that answers two questions about one package: what does each export subpath publish, as a consumer's types see it, and what did a change do to that. It has three steps over one input. The **view** (§13.3) lists the published names. The **diff** (§13.4) compares the view at a base commit with the view now. The **ratchet** (§13.5) checks the diff against the package's changesets and a bump policy. Each step adds one flag, and each later step runs the earlier ones.

### 13.1 What it reads, and what it leaves alone

- **Emitted declarations, not the oxc graph.** The mode runs the pinned tsgo itself (`tsgoBinary()` in `src/engine/tsgo.ts`) with declaration-only emit into a temp folder, then reads those `.d.ts` files with a tsgo program. It runs neither the cheap pass nor the edge pass and never reads the `Graph` or its nodes, including the nodes #599 and #600 add. Source text misses what a consumer gets: an inferred return type, a private type folded into a public name. The emitted declarations carry both.
- **§6-A3 still holds.** The `**/*.d.ts` exclusion filters the source graph's files. This mode's `.d.ts` files are the ones it emitted into its own temp folder, and they never enter the source graph.
- **Existing output does not change.** With none of `--api`, `--api-base` and `--api-policy` on the command line, no emit runs, no temp folder is made, and every existing flag's output is byte-identical to before: the summary, `Graph`, every report and every gate. The mode adds no key to `Graph` and changes no existing type.
- **The checkout is never written.** The mode writes only inside temp folders outside the checkout. It changes no file, index entry or ref in the checkout (§13.4 says how the base commit is read).

### 13.2 Input: the API map

The caller says which subpaths exist, which source file each comes from, and its tier. code-graph reads no `package.json` `exports`, no build config (`tsup.config.ts` or any other) and no `MAINTAINING.md`.

`--api <file>` names a JSON file with this shape:

```json
{
  ".": { "entry": "src/index.ts", "tier": "stable" },
  "./testing": { "entry": "src/testing/index.ts", "tier": "stable" },
  "./labs": { "entry": "src/labs/index.ts", "tier": "experimental" }
}
```

- **Keys** are export subpaths, spelled as the caller spells them. **`entry`** (required) is the source file for that subpath, relative to the analyzed `<path>`. **`tier`** (optional) is any non-empty string.
- **The subpath-to-source map is the caller's.** code-graph holds no `dist/X` → `src/X` rule anywhere, in the CLI or the library. An export map points at build output, and only the package's own build config knows which source file each entry comes from, so any rule here would be a guess about one package's layout. This follows the ruling on #601 ([option (b)](https://github.com/kamp-us/demlik/issues/601#issuecomment-6102379089)), and the map has the same subpath → source shape as #601's `SubpathEntries`: an API map without its tiers is one.
- **A tier is an opaque string.** code-graph never interprets it. It copies the tier onto the view and the diff, and the ratchet uses it only as a key into the caller's policy (§13.5). `stable`, `battery` and `experimental` mean nothing to code-graph. A package that stamps its tiers in a `MAINTAINING.md` reads them with its own reader and writes them into the map.
- **Parse boundary.** The file is parsed through a zod schema (`ApiMapSchema`), as `--thresholds` is (§5). An unknown key, an empty map, an empty `entry` or an empty `tier` exits 2. So does an `entry` that is not a `.ts`, `.tsx`, `.mts` or `.cts` file, that lies outside `<path>`, or that does not exist.

### 13.3 The view

`code-graph <path> --api <map>`, where `<path>` is the package root.

**Emit.** The tsconfig is the one package scope picks for `<path>`: `resolveEdgeTsConfig(<path>, "package", repoRoot)` (§8-C3); none exits 2. code-graph runs tsgo on it with `--noEmit false --declaration --emitDeclarationOnly --declarationMap false --noEmitOnError false --incremental false --composite false --rootDir <path> --outDir <temp>/out`. Because code-graph sets `rootDir` and `outDir` itself, an entry's emitted file follows from the emit's own rule, not from any guess about the package: `src/testing/index.ts` emits to `<temp>/out/src/testing/index.d.ts` (`.tsx` → `.d.ts`, `.mts` → `.d.mts`, `.cts` → `.d.cts`). A type error does not stop the emit; tsgo's diagnostic count goes to stderr as one warning line. Exit 2 when tsgo fails to start, or when an entry has no emitted file (for example, the tsconfig does not include it).

**Program.** A tsgo program opens over the emitted entry files with the tsconfig's compiler options. Bare specifiers resolve against the package's installed dependencies through a `node_modules` symlink at `<temp>/node_modules` → `<path>/node_modules`, made in the temp folder, never in the checkout.

**Names.** For each subpath, the entry's module symbol comes from the module step #601 adds to `src/resolve.ts` (the step behind `resolveModuleExport`). The view enumerates that symbol's exports with `exportsOf` and follows each through aliases, renames and `export *` with `aliasTarget`. It imports #601's step and never writes a second one. Every exported name is listed, types and values alike. A default export is the name `default`, and `export =` is the name `export=`. A name re-exported from a dependency is listed with its declaration text from the dependency's own `.d.ts`.

**Text.** A name's `text` is the emitted text of each of its declarations, from the first token to the end of the statement (a variable's whole variable statement), with every comment removed, trailing whitespace trimmed, blank lines dropped and indentation kept as emitted. A doc-comment edit therefore changes no text. Several declarations (overloads, an interface merged with a namespace) join with `\n`, in emitted file order, then position. A renamed export keeps the declared name in its text: `export { plain as increment }` lists `increment` with the text of `declare function plain…`.

**References.** A name also carries the text of every declaration it reaches that its subpath does not publish, so a change to a private type is a change to the published name that uses it. From each of the name's declarations, every type reference and `typeof` query resolves to a symbol. A declaration of that symbol is added, and walked in turn, when it sits in the emitted tree (`<temp>/out`) and is not the declaration of a name this subpath publishes. A published name the walk meets is not inlined, because its change shows on its own row. A declaration in a dependency is not followed. The key is `<emitted file, relative to <temp>/out>#<declared name>` (for example `src/core.d.ts#Options`), and the value is that declaration's text by the rule above.

**JSON.** Output is a `PublishedApi`:

```ts
type ApiEntryText = {
  text: string;
  references: Record<string, string>; // "<emitted file>#<declared name>" → text
};

type PublishedApi = {
  root: string;     // <path> relative to cwd, as Graph.root
  compiler: string; // the pinned tsgo version that emitted
  subpaths: Record<string, {
    entry: string;        // as the map gave it
    tier: string | null;  // as the map gave it; null when absent
    names: Record<string, ApiEntryText>;
  }>;
};
```

Every subpath in the map is a key, including one that publishes nothing (`names: {}`). The JSON is serialized with sorted keys, like every code-graph output (§3). No key or text holds an absolute path, and the temp folder is removed before exit, on success and on failure. The same commit and the same map give the same bytes. It goes to stdout, or to `--out <file>`; `--pretty` indents it.

**Example.** A package `packages/demo` with three subpaths:

```ts
// src/index.ts
export * from "./core";

// src/core.ts
type Options = { readonly retries: number };
/** Builds a runner. */
export function make(options: Options) {
  return { options, started: false };
}
export const VERSION = "1";

// src/testing/index.ts
export { expectEmitted } from "./expect";

// src/testing/expect.ts
export function expectEmitted<T>(actual: readonly T[], expected: NoInfer<T>): void {}

// src/labs/index.ts
export const flag = true;
```

With the map in §13.2, `code-graph packages/demo --api demo-api.json --pretty` run from the repo root prints:

```json
{
  "compiler": "7.0.0-dev.20260707.2",
  "root": "packages/demo",
  "subpaths": {
    ".": {
      "entry": "src/index.ts",
      "names": {
        "VERSION": {
          "references": {},
          "text": "export declare const VERSION = \"1\";"
        },
        "make": {
          "references": {
            "src/core.d.ts#Options": "type Options = {\n    readonly retries: number;\n};"
          },
          "text": "export declare function make(options: Options): {\n    options: Options;\n    started: boolean;\n};"
        }
      },
      "tier": "stable"
    },
    "./labs": {
      "entry": "src/labs/index.ts",
      "names": {
        "flag": {
          "references": {},
          "text": "export declare const flag = true;"
        }
      },
      "tier": "experimental"
    },
    "./testing": {
      "entry": "src/testing/index.ts",
      "names": {
        "expectEmitted": {
          "references": {},
          "text": "export declare function expectEmitted<T>(actual: readonly T[], expected: NoInfer<T>): void;"
        }
      },
      "tier": "stable"
    }
  }
}
```

`make`'s inferred return type shows in its text, and the private `Options` shows under its references. `compiler` is whatever version the package pins.

### 13.4 The diff

`code-graph <path> --api <map> --api-base <rev>`.

**Reading the base.** `<rev>` resolves with `git rev-parse --verify <rev>^{commit}` in the repository that holds `<path>`. A rev that does not resolve exits 2. (In CI, fetch the base commit first: `actions/checkout` fetches one commit by default.) The base commit's whole tree is written from the repository's objects into a second temp folder, with `git archive <sha>` piped into `tar -x -C <temp>/base`, so a tsconfig `extends` that points outside the package still resolves. `<temp>/base/<path>/node_modules` and `<temp>/base/node_modules` are symlinks to the checkout's installed `<path>/node_modules` and repo-root `node_modules`, so the base resolves its dependencies against what is installed now. The view (§13.3) then runs on `<temp>/base/<path>` with the same map. The only git commands the mode runs are `rev-parse`, `archive` and `ls-tree` (§13.5), all of which only read. It never runs `checkout`, `switch`, `stash`, `worktree`, `reset`, `read-tree`, `update-ref` or any other command that writes the checkout's files, index or refs. The diff child's test asserts that `git status --porcelain`, the index and `HEAD` are the same before and after a run.

A subpath whose entry does not exist at the base has every name `added`. An entry missing now exits 2, as in the view.

**Compare.** Per subpath, a name published now and not at the base is `added`. A name published at the base and not now is `removed`. A name in both whose `text` or `references` differ is `changed`. Equality is exact string equality on the text rules of §13.3.

**JSON.** Output is an `ApiDiff`:

```ts
type ApiDiff = {
  root: string;     // as PublishedApi.root
  base: string;     // the base commit's full sha
  compiler: string;
  subpaths: Record<string, {
    tier: string | null;
    added: Record<string, { after: ApiEntryText }>;
    removed: Record<string, { before: ApiEntryText }>;
    changed: Record<string, { before: ApiEntryText; after: ApiEntryText }>;
  }>;
};
```

Every subpath in the map is a key, including one with no change. The serialization and determinism rules of §13.3 apply. The diff reports and does not gate: it exits 0 whatever it finds.

**Example.** Against the §13.3 package as the base (commit `4b1c0de…`), a branch adds `readonly delayMs?: number` to the private `Options`, drops `NoInfer` from `expectEmitted`, and replaces `./labs`'s `flag` with `export const level = 2;`. `code-graph packages/demo --api demo-api.json --api-base origin/main --pretty` prints (the `4b1c0de…` sha in full in the real output):

```json
{
  "base": "4b1c0de…",
  "compiler": "7.0.0-dev.20260707.2",
  "root": "packages/demo",
  "subpaths": {
    ".": {
      "added": {},
      "changed": {
        "make": {
          "after": {
            "references": {
              "src/core.d.ts#Options": "type Options = {\n    readonly retries: number;\n    readonly delayMs?: number;\n};"
            },
            "text": "export declare function make(options: Options): {\n    options: Options;\n    started: boolean;\n};"
          },
          "before": {
            "references": {
              "src/core.d.ts#Options": "type Options = {\n    readonly retries: number;\n};"
            },
            "text": "export declare function make(options: Options): {\n    options: Options;\n    started: boolean;\n};"
          }
        }
      },
      "removed": {},
      "tier": "stable"
    },
    "./labs": {
      "added": {
        "level": { "after": { "references": {}, "text": "export declare const level = 2;" } }
      },
      "changed": {},
      "removed": {
        "flag": { "before": { "references": {}, "text": "export declare const flag = true;" } }
      },
      "tier": "experimental"
    },
    "./testing": {
      "added": {},
      "changed": {
        "expectEmitted": {
          "after": {
            "references": {},
            "text": "export declare function expectEmitted<T>(actual: readonly T[], expected: T): void;"
          },
          "before": {
            "references": {},
            "text": "export declare function expectEmitted<T>(actual: readonly T[], expected: NoInfer<T>): void;"
          }
        }
      },
      "removed": {},
      "tier": "stable"
    }
  }
}
```

`make`'s own text did not move, but its private `Options` did, so `make` is `changed`.

### 13.5 The ratchet

`code-graph <path> --api <map> --api-base <rev> --api-policy <file>`.

**The bump policy** is the caller's, a JSON file parsed through `BumpPolicySchema`:

```json
{
  "callout": "**Breaking",
  "tiers": {
    "stable": {
      "added": { "bump": "minor" },
      "changed": { "bump": "minor", "callout": true },
      "removed": { "bump": "minor", "callout": true }
    },
    "experimental": {
      "added": { "bump": "none" },
      "changed": { "bump": "none" },
      "removed": { "bump": "none" }
    }
  }
}
```

- **`tiers`** maps a tier string to one row per change kind. Every row names all three kinds, `added`, `changed` and `removed`. A kind's rule is `bump`, one of `none` < `patch` < `minor` < `major`, and `callout`, a boolean that defaults to `false`.
- **`callout`** is the marker text, non-empty. A rule with `callout: true` is met only when a counted changeset's body contains this text. The marker is policy, not a constant, because each package marks a breaking change its own way.
- **`default`** is optional and has the shape of one `tiers` row. It applies to a subpath whose tier the policy does not name, and to a subpath with no tier. Without `default`, a diff row whose subpath's tier the policy does not name, or whose tier is `null`, exits 2 naming the subpath and tier, so no change passes unpoliced.
- An unknown key exits 2. code-graph ships no policy and no default row: every rule is the caller's, and it adds none stricter.

**Which changesets count.** The changeset folder is `.changeset/` at the repo root (`findRepoRoot(<path>)`). A file counts when all four hold:

1. It is a `.md` file directly in `.changeset/` and is not `README.md`.
2. It exists in the checkout's working tree.
3. It does not exist in the base commit's tree (`git ls-tree --name-only <sha> -- .changeset/`).
4. Its frontmatter names the package, the `name` in `<path>/package.json`, with a bump of `major`, `minor` or `patch`.

The frontmatter is the changesets format: a block between two `---` lines whose lines read `"<package>": <bump>`. A file whose frontmatter does not parse exits 2 naming it. The body is everything after the closing `---`. A missing `<path>/package.json`, or one with no `name`, exits 2.

The **highest bump** is the largest bump the counted files give the package, or `none` when no file counts. The **callout is found** when any counted file's body contains the policy's `callout` text.

**Verdict.** Each diff row (subpath, kind, name) takes its rule from the policy by its subpath's tier. A row misses when its rule's `bump` is above the highest bump, or when its rule has `callout: true` and no callout is found. Exit 0 when nothing misses, 1 when anything does.

**Output.** The default is human text on stdout. A pass is one line:

```text
API RATCHET: pass — 4 changes against 4b1c0de, highest changeset bump minor, callout found
```

A miss is one block per missing row, then a summary line:

```text
API RATCHET: make in . (stable) changed — needs a minor changeset with a "**Breaking" callout; found none
  before:
    export declare function make(options: Options): {
        options: Options;
        started: boolean;
    };
    src/core.d.ts#Options: type Options = {
        readonly retries: number;
    };
  after:
    …the same, with the after text…
API RATCHET: 2 of 4 changes miss their bump against 4b1c0de
```

The block names the name, its subpath, its tier and its change kind, and prints the before and after text with references (an `added` row has no before, a `removed` row no after). `--json` prints an `ApiRatchetVerdict` instead:

```ts
type Bump = "none" | "patch" | "minor" | "major";

type ApiRatchetVerdict = {
  passed: boolean;
  base: string;          // full sha
  package: string;       // <path>/package.json name
  changesets: string[];  // counted files, repo-relative, sorted
  highestBump: Bump;
  calloutFound: boolean;
  misses: Array<{        // sorted by subpath, then name, then kind
    subpath: string;
    tier: string | null;
    name: string;
    kind: "added" | "removed" | "changed";
    needs: { bump: Bump; callout: boolean };
    before: ApiEntryText | null; // null for added
    after: ApiEntryText | null;  // null for removed
  }>;
};
```

**Example.** On the §13.4 diff with the policy above and no changeset, `--json` prints:

```json
{
  "base": "4b1c0de…",
  "calloutFound": false,
  "changesets": [],
  "highestBump": "none",
  "misses": [
    {
      "after": { "references": { "src/core.d.ts#Options": "type Options = {\n    readonly retries: number;\n    readonly delayMs?: number;\n};" }, "text": "export declare function make(options: Options): {\n    options: Options;\n    started: boolean;\n};" },
      "before": { "references": { "src/core.d.ts#Options": "type Options = {\n    readonly retries: number;\n};" }, "text": "export declare function make(options: Options): {\n    options: Options;\n    started: boolean;\n};" },
      "kind": "changed",
      "name": "make",
      "needs": { "bump": "minor", "callout": true },
      "subpath": ".",
      "tier": "stable"
    },
    {
      "after": { "references": {}, "text": "export declare function expectEmitted<T>(actual: readonly T[], expected: T): void;" },
      "before": { "references": {}, "text": "export declare function expectEmitted<T>(actual: readonly T[], expected: NoInfer<T>): void;" },
      "kind": "changed",
      "name": "expectEmitted",
      "needs": { "bump": "minor", "callout": true },
      "subpath": "./testing",
      "tier": "stable"
    }
  ],
  "package": "@demo/pkg",
  "passed": false
}
```

and exits 1. The `./labs` rows need `none`, so they never miss. With `.changeset/demo-options.md` added on the branch:

```md
---
"@demo/pkg": minor
---

**Breaking:** `expectEmitted` no longer pins `expected` to `actual`'s type, and `make` takes `delayMs`.
```

the same run prints `"changesets": [".changeset/demo-options.md"]`, `"highestBump": "minor"`, `"calloutFound": true`, `"misses": []`, `"passed": true`, and exits 0. A `patch` changeset with the callout, or a `minor` one without it, still misses both rows.

### 13.6 Flags and exit codes

| Flags | Runs | Prints | Exit |
|---|---|---|---|
| `--api <map>` | view | `PublishedApi` JSON | 0, 2, 3 |
| `--api <map> --api-base <rev>` | view at the base and now, then diff | `ApiDiff` JSON | 0, 2, 3 |
| `--api <map> --api-base <rev> --api-policy <file>` | the above, then ratchet | human verdict; `--json` gives `ApiRatchetVerdict` | 0 pass, 1 miss, 2, 3 |

`--json`, `--pretty` and `--out` apply as in §10; no other flag combines with `--api`. Exit 2, with one stderr line naming the cause and nothing written, for:

- `--api-base` without `--api`, `--api-policy` without `--api-base`, or `--api` with any view, analysis or gate flag other than `--json`, `--pretty` and `--out`;
- an invalid map (§13.2) or policy (§13.5);
- no tsconfig for `<path>`, tsgo failing to start, or an entry with no emitted file;
- a base rev that does not resolve, or a failed `git archive`;
- with `--api-policy`: no `name` in `<path>/package.json`, a changeset whose frontmatter does not parse, or a tier with no policy row and no `default`.

Exit 3 for any other error inside the run, on all three rows: one stderr line, `code-graph: unexpected error: <message>`, no stack trace and nothing on stdout. An `--out` file that cannot be written is one of these and exits 3, not 2. So exit 1 always means a ratchet miss, never a crash.

### 13.7 Library subpath `@demlik/code-graph/api`

The mode ships as the `./api` export (`src/api.ts`, a barrel over `src/api/`), built and verified like the other subpaths: `package.json` `exports`, the tsup entry, and a row in `scripts/verify-exports.mjs`.

| Export | Result |
|---|---|
| `readPublishedApi(root, map, options?)` | `Promise<PublishedApi>`: the view |
| `diffPublishedApi(root, map, base, options?)` | `Promise<ApiDiff>`: the diff; `base` is any rev |
| `readChangesetsSince(root, base, options?)` | `ChangesetsSince`: `{ package, changesets }`, where each `Changeset` is `{ file, bump, body }` and only counted files appear |
| `ratchetApiDiff(diff, policy, changesets)` | `ApiRatchetVerdict`; pure, no I/O |
| `ApiMapSchema`, `BumpPolicySchema` | the zod schemas the CLI parses through |

It also exports the types `ApiMap`, `ApiEntryText`, `PublishedApi`, `ApiDiff`, `BumpPolicy`, `Bump`, `Changeset`, `ChangesetsSince`, `ApiRatchetVerdict` and the error class `ApiInputError`. `root` is the package root and resolves against cwd when relative. `options` is `{ repoRoot?: string }`, defaulting to `findRepoRoot(root)`. Every input the CLI refuses with exit 2 makes the library throw `ApiInputError` with the same message, and the CLI maps that error to exit 2. The CLI is a thin caller of these five exports and holds no logic of its own.

### 13.8 Where it is documented

- `docs/reference/cli.md` gains a "Published API" section: the three flags, what each prints, and the exit codes of §13.6, pointing here for the JSON.
- `docs/reference/library.md` gains an "API" section for `@demlik/code-graph/api`: the exports of §13.7, the map and policy shapes, and one example.

Each child documents the part it builds: the view child `--api` and `readPublishedApi`, the diff child `--api-base` and `diffPublishedApi`, the ratchet child `--api-policy`, `readChangesetsSince` and `ratchetApiDiff`.
