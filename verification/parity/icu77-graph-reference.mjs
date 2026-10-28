import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const load = (f) =>
  import(pathToFileURL(path.join(root, "packages/code-graph/src", `${f}.ts`)));
const project = await load("extract/project"),
  assembly = await load("extract/assemble"),
  functions = await load("extract/functions"),
  analysis = await load("extract/analysis"),
  directories = await load("extract/directories"),
  schema = await load("schema"),
  rules = await load("kinds/rules"),
  data = await load("data/extract"),
  catalog = await load("extract/wrangler-config");
export const sourceFiles = [
  "extract/project",
  "extract/assemble",
  "extract/directories",
  "extract/analysis",
  "extract/cross-runtime",
  "extract/functions",
  "extract/wrangler-config",
  "data/extract",
  "data/alias-scope",
  "data/access",
  "schema",
  "kinds/rules",
  "checker/context",
  "extract/edges",
];
export const sourcePins = () =>
  Object.fromEntries(
    sourceFiles.map((f) => [
      f,
      createHash("sha256")
        .update(
          fs.readFileSync(
            path.join(root, "packages/code-graph/src", `${f}.ts`),
          ),
        )
        .digest("hex"),
    ]),
  );
export function reference(item, fixture) {
  const loaded = project.loadCheapProject(fixture),
    thresholds = schema.ThresholdsSchema.parse({});
  if (item.mode === "workflow") {
    const edge = project.loadEdgeProject(fixture, "package", fixture),
      a = item.analysis ?? {};
    return assembly.assembleGraphWithEdges(
      edge,
      thresholds,
      "package",
      path.join(fixture, "tsconfig.json"),
      {
        crossRuntime: a.crossRuntime ?? false,
        kinds: a.kinds ?? false,
        reach: a.reach ?? false,
        clusters: a.clusters ?? false,
        interfaceWidth: a.interfaceWidth ?? false,
        kindRules: rules.NodeKindRulesSchema.parse({}),
        repoRoot: fixture,
      },
      item.data ? { repoRoot: fixture } : null,
    );
  }
  if (item.mode === "data") {
    const found = functions.discoverFunctions(loaded.sourceFiles).functions,
      c = catalog.loadBindingCatalog(fixture),
      units = item.duplicateUnits
        ? [...loaded.sourceFiles, ...loaded.sourceFiles]
        : loaded.sourceFiles;
    return {
      scan: data.scanDataSites({
        units,
        functions: found,
        catalog: c,
        repoRoot: fixture,
      }),
      report: data.loadDataReport(units, found, fixture),
    };
  }
  if (item.mode === "inputs") {
    let found = functions.discoverFunctions(loaded.sourceFiles).functions;
    if (item.symbolOrder)
      found = item.symbolOrder.map((id) => {
        const f = found.find((f) => f.id === id);
        assert.ok(f);
        return f;
      });
    if (item.reverseSymbols) found.reverse();
    if (item.repeatFirst) found.push(found[0]);
    const before = found.map((f) => f.id),
      input = analysis.analysisInputs(found);
    assert.deepEqual(
      found.map((f) => f.id),
      before,
    );
    return { names: [...input.names], exportsByFile: [...input.exportsByFile] };
  }
  const graph = assembly.assembleGraph(loaded, thresholds);
  if (item.mode === "directories") {
    if (item.moduleOrder)
      graph.modules.sort(
        (a, b) =>
          item.moduleOrder.indexOf(a.file) - item.moduleOrder.indexOf(b.file),
      );
    const before = JSON.stringify(graph.modules),
      out = directories.buildDirectories(graph.modules, thresholds);
    assert.equal(JSON.stringify(graph.modules), before);
    return out;
  }
  return graph;
}
