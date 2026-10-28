import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { modulesFor } from "./icu77-coupling-cases.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url)),
  load = (f) =>
    import(
      pathToFileURL(path.join(root, "packages/code-graph/src", `${f}.ts`))
    );
const coupling = await load("smells/coupling"),
  project = await load("extract/project"),
  assembly = await load("extract/assemble"),
  schema = await load("schema"),
  smells = await load("render/smells"),
  analysis = await load("render/analysis"),
  rules = await load("kinds/rules");
export const sourceFiles = [
  "smells/coupling",
  "extract/scc",
  "extract/project",
  "extract/assemble",
  "query/clusters",
  "query/louvain",
  "render/smells",
  "render/analysis",
  "schema",
  "kinds/rules",
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
function views(modules, roots) {
  const before = JSON.stringify(modules),
    result = coupling.analyzeCoupling(modules, roots);
  const out = {
    valueEdges: coupling.valueEdges(modules),
    cycles: coupling.findCycles(modules),
    crossBoundary: coupling.crossBoundaryEdges(modules, roots),
    ranked: coupling.rankModules(modules, roots),
    coupling: [...coupling.couplingByFile(modules, roots)],
    analysis: { ...result, coupling: [...result.coupling] },
  };
  assert.equal(JSON.stringify(modules), before);
  return out;
}
function renders(graph) {
  return {
    smellsText: smells.renderSmells(graph, false, false),
    smellsJson: smells.renderSmells(graph, true, false),
    smellsPretty: smells.renderSmells(graph, true, true),
    cyclesText: analysis.renderCycles(graph, false, false),
    cyclesJson: analysis.renderCycles(graph, true, false),
    cyclesPretty: analysis.renderCycles(graph, true, true),
  };
}
export function reference(item, fixture) {
  const roots = item.packageRoots ?? [];
  if (!item.mode) return views(modulesFor(item), roots);
  const loaded = project.loadCheapProject(fixture),
    t = schema.ThresholdsSchema.parse({
      dependencyCycle: 1,
      crossBoundaryImports: 0,
    });
  if (item.mode === "workflow") {
    const edge = project.loadEdgeProject(fixture, "package", fixture),
      graph = assembly.assembleGraphWithEdges(
        edge,
        t,
        "package",
        path.join(fixture, "tsconfig.json"),
        {
          crossRuntime: false,
          kinds: false,
          reach: false,
          clusters: true,
          interfaceWidth: false,
          kindRules: rules.NodeKindRulesSchema.parse({}),
          repoRoot: fixture,
        },
        null,
      );
    return {
      graph,
      ...views(graph.modules, project.discoverPackageRoots(fixture)),
      renders: renders(graph),
    };
  }
  const graph = assembly.assembleGraph(loaded, t);
  if (item.mode === "guards") {
    graph.root = "invalid\0root";
    return {
      smellsJson: smells.renderSmells(graph, true, false),
      smellsPretty: smells.renderSmells(graph, true, true),
      cyclesText: analysis.renderCycles(graph, false, false),
      cyclesJson: analysis.renderCycles(graph, true, false),
    };
  }
  if (item.mode === "render") {
    graph.modules = modulesFor(item);
    graph.provenance = {
      pass: "edges",
      scope: "package",
      tsConfig: path.join(fixture, "tsconfig.json"),
    };
    return { ...views(graph.modules, roots), renders: renders(graph) };
  }
  return { graph, ...views(graph.modules, roots), renders: renders(graph) };
}
