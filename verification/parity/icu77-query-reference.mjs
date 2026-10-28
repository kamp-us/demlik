import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const load = (file) =>
  import(
    pathToFileURL(path.join(root, "packages/code-graph/src", `${file}.ts`))
  );
const project = await load("extract/project"),
  assembly = await load("extract/assemble"),
  schema = await load("schema"),
  cluster = await load("query/clusters"),
  partition = await load("query/louvain"),
  width = await load("query/interface-width"),
  functions = await load("extract/functions"),
  analysis = await load("extract/analysis"),
  imports = await load("syntax/imports"),
  context = await load("checker/context"),
  edges = await load("extract/edges"),
  references = await load("extract/references");
export const sourceFiles = [
  "extract/project",
  "extract/assemble",
  "schema",
  "query/clusters",
  "query/louvain",
  "query/interface-width",
  "smells/coupling",
  "extract/functions",
  "extract/analysis",
  "syntax/imports",
  "checker/context",
  "extract/edges",
  "extract/references",
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
  if (item.operation === "partition") {
    const result = partition.louvain(item.nodes, item.edges);
    return {
      membership: [...result.membership],
      modularity: result.modularity,
    };
  }
  const loaded = project.loadCheapProject(fixture);
  const graph = assembly.assembleGraph(
    loaded,
    schema.ThresholdsSchema.parse({}),
  );
  let refs = {
    referencesById: new Map(),
    moduleScopeRoots: [],
    testModuleScopeRoots: [],
    identifierFiles: new Map(Object.entries(item.identifierFiles ?? {})),
  };
  if (item.operation === "workflow") {
    const found = functions.discoverFunctions(loaded.sourceFiles).functions;
    const config = path.join(fixture, "tsconfig.json"),
      input = analysis.analysisInputs(found);
    const ctx = context.TypeContext.open({
      rootAbsolute: loaded.rootAbsolute,
      sourceFiles: loaded.sourceFiles,
      tsConfigPath: config,
      functions: found,
    });
    try {
      const e = edges.resolveEdges(
        ctx,
        imports.resolveImports(fixture, loaded.sourceFiles, config),
        found.map((f) => f.id),
      );
      refs = references.resolveReferences(
        ctx,
        input.names,
        input.exportsByFile,
      );
      for (const node of graph.functions)
        node.edges = {
          calls: e.callsById.get(node.id) ?? [],
          calledBy: e.calledById.get(node.id) ?? [],
          callChainDepth: e.chainDepthById.get(node.id) ?? 0,
        };
      for (const node of graph.modules) {
        node.imports = e.importsByFile.get(node.file) ?? [];
        node.importedBy = e.importedByFile.get(node.file) ?? [];
        node.importEdges = e.importEdgesByFile.get(node.file) ?? [];
      }
    } finally {
      ctx.close();
    }
  } else {
    for (const node of graph.modules)
      node.importEdges = (item.moduleLinks ?? [])
        .filter((r) => r.from === node.file)
        .map((r) => ({
          kind: "static",
          specifier: r.to ?? "external",
          target: r.to,
          typeOnly: r.typeOnly ?? false,
        }));
    for (const node of graph.functions)
      node.edges = {
        calls: (item.callLinks ?? [])
          .filter((r) => r.callerId === node.id)
          .map((r) => ({
            calleeId: r.calleeId,
            declaration: null,
            line: 1,
            constArgs: [],
          })),
        calledBy: [],
        callChainDepth: 0,
      };
  }
  const before = JSON.stringify(graph);
  const result = {
    clusters: cluster.buildClusterReport(graph.functions, graph.modules),
    interfaceWidth: width.findInterfaceWidth(
      graph.functions,
      refs,
      item.packageDirs ?? [],
    ),
    packageOwners: (item.lookupFiles ?? []).map((file) =>
      width.packageOf(file, item.packageDirs ?? []),
    ),
  };
  assert.equal(
    JSON.stringify(graph),
    before,
    "queries retain original input order/facts",
  );
  return result;
}
