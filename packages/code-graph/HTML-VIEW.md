# `@demlik/code-graph` — `--html` visual report

> **Status:** implemented and shipped. `--html` (`renderHtml`) is CLI-wired and banner-safe via `--out` (#1761). This doc describes the actual output and its design rationale. The data contract is `SPEC.md` (the `Graph` shape); this doc describes the *human-facing renderer* over that data.

## 1. Why + the hard boundary

A human-facing visualization of a folder's health — the "very cool" view. It is **separate from the agent path**: the tool stays agent-native (JSON/text), and `--html` is a renderer for *people* (Can). It must never enter an agent's context — it writes a file you open in a browser, nothing more.

One self-contained HTML file: `code-graph <path> --html --out report.html`, then open it. No server, no build step, works offline-ish (see §5 on the CDN caveat). Write it with `--out <file>` — the banner-safe path (SPEC §10): the `pnpm code-graph` wrapper prints its run banner to stdout, so a bare `… > report.html` redirect prepends the banner to the file (#1761); `--out` writes the file directly and never touches stdout.

## 2. Install, don't build the renderer

We already have the data (`Graph` JSON). We do **not** hand-roll layout/zoom/pan:
- **Treemap** → `d3` (`d3-hierarchy` + `d3-selection`) via CDN `<script>`.
- **Call graph** → `cytoscape.js` (+ `fcose` layout) via CDN `<script>`.

Our code: serialize the `Graph` into the two view-models below, inline it as a `<script>const DATA = {...}</script>`, and write the static HTML/CSS scaffold. That's it — the libs do the visuals.

## 3. Report structure (one scrolling page)

```
┌────────────────────────────────────────────────────────┐
│  HEADER   audit-agents · health: ROTTEN                 │
│           85 files · 437 fns · 91 smells (23 high)      │
│           worst fn: createToolNode · worst file: index  │
├────────────────────────────────────────────────────────┤
│  § HOTSPOT TREEMAP  (the rot map — hero)                │
│     nested dir→file boxes, sized by LOC, colored by     │
│     worst smell severity in the file                    │
├────────────────────────────────────────────────────────┤
│  § HUB CALL GRAPH                                        │
│     nodes = hubs + smelly fns, edges = calls,           │
│     node size = fanIn, color = smell severity           │
├────────────────────────────────────────────────────────┤
│  § TOP TARGETS  (the --plan list, as an HTML table,     │
│     each row linking into the graph above)              │
└────────────────────────────────────────────────────────┘
```

### Header
Straight from `graph.summary`: `root`, `health` band (color the chip green/amber/red), `fileCount`, `functionCount`, `smellCount`, `highSeverityCount`, `worstFile`, `worstFunction`.

### § Hotspot treemap (hero — `d3.treemap`)
- **Hierarchy:** repo-relative directories → files. Leaf = a `ModuleNode`.
- **Box size:** `module.loc`.
- **Box color:** the file's worst smell severity — **green** = no smells, **amber** = only `warn`, **red** = any `high`. (Derive from `module.smells` + the smells of functions in that file.)
- **Label:** filename when the box is big enough; else on hover.
- **Hover tooltip:** `file`, `loc`, function count, smell count by kind.
- **Click:** scroll to / filter the Top Targets table to that file.
- **Why treemap:** the whole codebase's health in one frame — "this directory is all red" is instant.

### § Hub call graph (`cytoscape` + `fcose`)
Needs the edge pass, so **`--html` implies `--edges`** (load the call graph; `--deep` still optional for cross-package). To stay readable (437 fns is a hairball):
- **Node inclusion rule:** include a function only if it has ≥1 smell **OR** `calledBy.length >= 3` (a hub). Then add the **direct callers/callees** of included nodes (one hop) for context. Everything else is omitted; show an "N functions hidden" note (no silent truncation — SPEC discipline).
- **Node size:** scale by `fanIn` (`calledBy.length`).
- **Node color:** worst smell severity (same green/amber/red ladder).
- **Edge:** a call (`calls[]`), arrow caller→callee.
- **Click a node:** side panel with `id`, `file:startLine-endLine`, `loc/cx/nest/fanIn/callChainDepth`, and its smell list. (Coordinates make it a jump-off point even though this is a human view.)
- **Layout:** `fcose` (force-directed, handles the size well). Layout positions may differ run-to-run — acceptable for a human view (the *data* is deterministic; only pixel positions vary). Note this in the page footer.

### § Top targets table
The `--plan` rows (default `rot`) as a sortable HTML table: rank, id (links into the graph), `file:line`, loc, cx, fanIn (or `—` if cheap — but `--html` implies edges, so it'll be populated), smells. Re-sortable by column header = the `--by` axes, client-side.

## 4. View-model (what we serialize into the page)

Don't ship the whole `Graph` — project it to exactly what the two libs need:
```ts
type HtmlModel = {
  summary: Summary;                        // header
  treemap: {                               // d3 hierarchy
    name: string;                          // dir or file basename
    children?: HtmlModel["treemap"][];     // dirs
    loc?: number;                          // files (leaf)
    severity?: "none" | "warn" | "high";   // files (leaf) — box color
    file?: string;                         // files (leaf) — full path
    smellKinds?: string[];                 // files (leaf) — tooltip
  };
  graph: {                                 // cytoscape elements
    nodes: { id; label; file; startLine; endLine; loc; complexity;
             fanIn; callChainDepth; severity; smellKinds; hidden? }[];
    edges: { source; target }[];           // calls within the included set
    hiddenCount: number;                   // "N functions hidden" note
  };
  plan: PlanRow[];                          // top targets table
};
```
Build it in a new `src/render/html.ts`; the model builder is pure + testable (no DOM). The HTML/CSS/JS scaffold is a template string with `DATA` inlined via `stableStringify`.

## 5. Decisions / caveats to honor

- **CDN vs offline.** Default: CDN `<script>` tags (smallest file, simplest). This means the report needs network on first open. If true-offline is wanted later, add `--html-inline` that embeds the minified libs — a follow-up, not v1.
- **Severity ladder** is the one color rule everywhere (treemap boxes, graph nodes, header chip): none→green, warn→amber, high→red. Single source it in `html.ts`.
- **`--html` implies the edge pass** (the graph section needs calls). Document in the §10 CLI table when built. Cheap-only HTML (treemap + plan, no graph) could be a `--html --no-edges` later; not v1.
- **Determinism:** the serialized `DATA` is deterministic (sorted, per SPEC §3). Only `fcose` pixel layout is non-deterministic — fine for a human view; never used by an agent.
- **No new agent surface.** `--html` is invisible to the JSON/summary/plan paths; it's purely additive.

## 6. Acceptance (when built)

- `code-graph <path> --html --out report.html` opens in a browser showing header + treemap + call graph + table, against `services/audit-agents`.
- Treemap colors match smell severity; a known-red dir (e.g. the one holding `createToolNode`) reads red.
- Graph shows the hubs (`emit#0`, `getPage`, `isForThisRun`) as large nodes; hidden-count note present.
- `html.ts` model builder has unit tests (pure function: `Graph → HtmlModel`); the scaffold is smoke-tested for valid HTML.
- No `as any`/`@ts-ignore`; biome clean; `--html` documented in SPEC §10.
