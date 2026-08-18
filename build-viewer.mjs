// Build the drop-in page: one HTML file plus its assets, for a host that wants
// the dashboard and does not want a bundler.
//
// MERMAID IS THE WHOLE SIZE STORY. It lazy-imports 36 diagram renderers and we
// draw exactly one kind — `stateDiagram-v2`. The imports are dynamic and keyed
// by a detector that only fires on a diagram of that type, so a renderer we
// never reach is dead weight the bundler cannot prove is dead. Stubbing the 34
// we cannot reach is safe by construction: nothing here ever parses a gantt.
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { build } from "vite";

const KEEP = /stateDiagram(-v2)?-[A-Z0-9]+\.mjs$/;
// ONLY a diagram entry chunk. `chunk-*.mjs` are mermaid's shared internals —
// the state renderer imports them, and stubbing those breaks the one diagram
// we are keeping.
const DIAGRAM_ENTRY = /\/(?:[a-zA-Z0-9]*[Dd]iagram|swimlanes|journey|sankey|timeline|mindmap|radar|treemap|kanban|packet|quadrant|xychart|pie|info|gantt|git[A-Za-z]*|er|architecture|block|c4|cynefin|ishikawa|requirement|usecase|flow[A-Za-z]*)-[A-Z0-9]{8}\.mjs$/;

const stubUnusedDiagrams = {
  name: "mermaid-one-diagram",
  enforce: "pre",
  load(id) {
    const clean = id.split("?")[0];
    // Two more that only other diagram types reach: a cytoscape layout engine
    // (architecture, mindmap) and a maths typesetter. A state diagram renders
    // boxes, arrows and plain labels.
    if (/cose-bilkent|cytoscape|\/katex/.test(clean)) {
      return "const noop = {}; export default noop;";
    }
    if (!clean.includes("mermaid/dist/chunks/")) return null;
    if (KEEP.test(clean) || !DIAGRAM_ENTRY.test(clean)) return null;
    // a detector that fires would find nothing here — none can, because the
    // only text this page ever renders is a state diagram.
    return "export const diagram = {}; export default { diagram };";
  },
};

/** The page reads its lanes from the host at runtime, not from disk at build. */
const runtimeLanes = {
  name: "lanes-at-runtime",
  resolveId: (id) => (id === "virtual:lanes" ? "\0virtual:lanes" : null),
  load: (id) =>
    id === "\0virtual:lanes"
      ? `const boot = globalThis.__LANE_VIEWER__ ?? {};
export const LANES = boot.lanes ?? [];
export const SOURCE = boot.source ?? "";`
      : null,
};

await build({
  root: "demo/lane-view",
  // NOT the demo's own config. That one reads lanes off disk at build time and
  // bakes the path in; this build is the page a HOST serves, and it must learn
  // both from the host at runtime.
  configFile: false,
  plugins: [react(), runtimeLanes, stubUnusedDiagrams],
  build: {
    outDir: resolve("dist/chart/lane/viewer"),
    emptyOutDir: true,
    assetsDir: "assets",
  },
});
