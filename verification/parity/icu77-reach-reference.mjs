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
  reach = await load("query/reach"),
  unguarded = await load("query/unguarded"),
  unreachable = await load("query/unreachable"),
  surface = await load("query/surface"),
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
  "query/reach",
  "query/unguarded",
  "query/unreachable",
  "query/surface",
  "kinds/rules",
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
  const loaded = project.loadCheapProject(fixture);
  const graph = assembly.assembleGraph(
    loaded,
    schema.ThresholdsSchema.parse({}),
  );
  let refs = {
    referencesById: new Map(Object.entries(item.referencesById ?? {})),
    moduleScopeRoots: item.moduleScopeRoots ?? [],
    testModuleScopeRoots: item.testModuleScopeRoots ?? [],
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
          kind: r.kind ?? "static",
          specifier: r.to ?? "external",
          target: r.to,
          typeOnly: r.typeOnly ?? false,
        }));
    for (const node of graph.functions)
      node.edges = {
        calls: (item.calls ?? [])
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
  for (const f of graph.functions) {
    const value = item.kinds?.[f.id];
    if (value)
      f.nodeKind =
        value.kind === "entry"
          ? { ...value, evidence: ["fixture"] }
          : value.kind === "plain"
            ? value
            : { ...value, evidence: ["fixture"] };
  }
  if (item.functionOrder)
    graph.functions.sort(
      (a, b) =>
        (item.functionOrder.indexOf(a.id) < 0
          ? item.functionOrder.length
          : item.functionOrder.indexOf(a.id)) -
        (item.functionOrder.indexOf(b.id) < 0
          ? item.functionOrder.length
          : item.functionOrder.indexOf(b.id)),
    );
  const support = (item.testSupport ?? []).map((r) => ({
    key: r.key,
    patterns: r.patterns.map((p) => new RegExp(p)),
  }));
  const patterns = (item.exportPatterns ?? []).map((p) => new RegExp(p));
  const before = JSON.stringify(graph);
  const invoked = reach.invokedAdjacency(graph.functions),
    full = reach.fullAdjacency(graph.functions, refs.referencesById);
  const result = {
    invoked: [...invoked],
    full: [...full],
    reachable: [...reach.reachableFrom(full, item.roots ?? [])],
    surface: [
      ...surface.publicSurfaceFiles(
        graph.modules,
        item.extraEntryFiles ?? [],
        patterns,
      ),
    ],
    unreachable: unreachable.findUnreachable(
      graph.functions,
      graph.modules,
      refs,
      item.extraEntryFiles ?? [],
      support,
      patterns,
    ),
    unguarded: unguarded.findUnguarded(graph.functions),
  };
  assert.equal(
    JSON.stringify(graph),
    before,
    "original graph facts/order retained",
  );
  return result;
}
