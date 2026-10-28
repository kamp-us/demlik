import assert from "node:assert/strict";
import fs from "node:fs";
import { assembleGraph } from "../../packages/code-graph/src/extract/assemble.ts";
import { loadCheapProject } from "../../packages/code-graph/src/extract/project.ts";
import {
  churnFor,
  loadChurn,
  resolveHotspotsCliOptions,
} from "../../packages/code-graph/src/hotspots/churn.ts";
import {
  computeHotspots,
  renderHotspots,
} from "../../packages/code-graph/src/hotspots/render.ts";
import { ThresholdsSchema } from "../../packages/code-graph/src/schema.ts";

assert.equal(process.version, "v22.21.1");
assert.equal(process.versions.v8, "12.4.254.21-node.33");
assert.equal(process.versions.icu, "77.1");
const input = JSON.parse(fs.readFileSync(0, "utf8"));
const numeric = (value) =>
  value === "NaN"
    ? NaN
    : value === "Infinity"
      ? Infinity
      : value === "-Infinity"
        ? -Infinity
        : value === "-0"
          ? -0
          : value;
const encode = (value) =>
  typeof value === "number"
    ? Number.isNaN(value)
      ? "NaN"
      : value === Infinity
        ? "Infinity"
        : value === -Infinity
          ? "-Infinity"
          : Object.is(value, -0)
            ? "-0"
            : value
    : Array.isArray(value)
      ? value.map(encode)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value).map(([k, v]) => [k, encode(v)]),
          )
        : value;
const windowOf = (raw) => ({ ...raw, days: numeric(raw.days) });
const graphOf = (row) => ({
  root: "/supplied",
  provenance: { pass: "cheap" },
  thresholds: ThresholdsSchema.parse({}),
  summary: {
    health: "healthy",
    fileCount: row.files.length,
    functionCount: row.functions.length,
    smellCount: 0,
    highSeverityCount: 0,
    worstFile: null,
    worstFunction: null,
    topTargets: [],
    parseFailures: [],
  },
  crossRuntime: null,
  reachability: null,
  clusters: null,
  interfaceWidth: null,
  data: null,
  functions: row.functions.map((fn, i) => ({
    id: `f${i}`,
    name: `f${i}`,
    kind: "function",
    file: fn.file,
    startLine: 1,
    endLine: 1,
    loc: 1,
    commentLines: 0,
    nestingDepth: 0,
    complexity: numeric(fn.complexity),
    isExported: true,
    isTest: false,
    edges: null,
    nodeKind: null,
    smells: [],
  })),
  declarations: [],
  modules: row.files.map((file) => ({
    file,
    loc: 1,
    commentLines: 0,
    functionIds: [],
    imports: [],
    importedBy: [],
    importEdges: [],
    isTest: false,
    smells: [],
  })),
  directories: [],
  smells: [],
  stats: {
    fileCount: row.files.length,
    functionCount: row.functions.length,
    totalLoc: 0,
    totalCommentLines: 0,
    smellCount: 0,
    parseFailures: [],
  },
});
function report(graph, churn, rawWindow, limits) {
  const before = JSON.stringify(encode(graph));
  const modules = [...graph.modules],
    functions = [...graph.functions];
  const window = windowOf(rawWindow);
  const rows = computeHotspots(graph, churn);
  const renders = limits.map((raw) => ({
    limit: raw,
    human: renderHotspots(graph, churn, window, numeric(raw), false, false),
    compact: renderHotspots(graph, churn, window, numeric(raw), true, false),
    pretty: renderHotspots(graph, churn, window, numeric(raw), true, true),
  }));
  assert.equal(JSON.stringify(encode(graph)), before);
  assert.ok(modules.every((v, i) => graph.modules[i] === v));
  assert.ok(functions.every((v, i) => graph.functions[i] === v));
  assert.ok(
    renders.every(
      (r) => r.compact === renders[0].compact && r.pretty === renders[0].pretty,
    ),
    "JSON ignores every limit",
  );
  return {
    rows: encode(rows),
    renders,
    inputUnchanged: true,
    moduleOrderUnchanged: true,
    functionOrderUnchanged: true,
  };
}
let output;
if (input.mode === "options")
  output = input.pairs.map(([days, limit]) => {
    const reports = [];
    const value = resolveHotspotsCliOptions(days, limit, (message) =>
      reports.push(message),
    );
    return { value: encode(value), reports };
  });
else if (input.mode === "pure") {
  const graph = graphOf(input);
  const churn = {
    repoRoot: "/repo",
    headSha: "abcd",
    commitsByFile: new Map(input.commits.map(([k, v]) => [k, numeric(v)])),
    trackedFiles: new Set(input.tracked),
  };
  output = {
    profile: "authored-parts",
    ...report(graph, churn, input.window, input.limits),
  };
  if (input.id === "pure-order-owners")
    assert.deepEqual(
      output.rows.map((r) => r.file),
      ["equal.ts", "hot.ts", "zero.ts", "untracked.ts"],
    );
  if (input.id === "pure-duplicates-utf16")
    assert.equal(output.rows.filter((r) => r.file === "é.ts").length, 2);
} else {
  const graph = input.realGraph
    ? assembleGraph(loadCheapProject(input.root), ThresholdsSchema.parse({}))
    : null;
  const load = (raw) => {
    const data = loadChurn(input.root, windowOf(raw));
    if (data === null) return null;
    const view = {
      repoRoot: data.repoRoot,
      headSha: data.headSha,
      commitsByFile: [...data.commitsByFile],
      trackedFiles: [...data.trackedFiles],
      queries: input.queries.map((file) => [file, churnFor(data, file)]),
    };
    return {
      data: view,
      graph: graph
        ? {
            modules: graph.modules.map((m) => m.file),
            functions: graph.functions.map((f) => [f.file, f.complexity]),
          }
        : null,
      report: graph ? report(graph, data, raw, [0, 2, 99]) : null,
    };
  };
  output = {
    profile: input.realGraph ? "canonical-Graph" : "Git-only",
    loaded: load(input.window),
  };
  if (input.extraWindow) output.repeated = load(input.extraWindow);
  if (input.id === "repo-wide") {
    assert.notEqual(output.loaded, null);
    assert.equal(
      output.loaded.data.queries.find(([k]) => k === "src/hot.ts")[1],
      3,
    );
    assert.equal(
      output.loaded.data.queries.find(([k]) => k === "src/untracked.ts")[1],
      null,
    );
    assert.ok(output.loaded.graph.modules.length >= 3);
  }
  if (input.id === "repo-window-repeat") {
    assert.equal(
      output.loaded.data.queries.find(([k]) => k === "src/cold.ts")[1],
      0,
    );
    assert.equal(output.repeated.data.commitsByFile.length, 0);
  }
  if (
    input.id.startsWith("git-fail-") ||
    ["missing-root", "nonrepo-root", "no-head", "git-buffer-65mib"].includes(
      input.id,
    )
  )
    assert.equal(output.loaded, null);
  if (input.id === "git-buffer-2mib") assert.notEqual(output.loaded, null);
  if (input.id === "git-duplicates-raw-paths") {
    assert.equal(
      output.loaded.data.queries.find(([k]) => k === "alpha.ts")[1],
      2,
    );
    assert.equal(
      output.loaded.data.queries.find(([k]) => k === "zero.ts")[1],
      0,
    );
    assert.equal(
      output.loaded.data.queries.find(([k]) => k === "untracked.ts")[1],
      null,
    );
  }
}
console.log(JSON.stringify({ id: input.id, ok: true, output: encode(output) }));
