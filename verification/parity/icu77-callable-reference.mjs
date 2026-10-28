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
  functions = await load("extract/functions"),
  assembly = await load("extract/assemble"),
  schema = await load("schema"),
  rulesModule = await load("kinds/rules"),
  classification = await load("kinds/classify"),
  decl = await load("kinds/declarations"),
  conventions = await load("kinds/conventions"),
  entries = await load("extract/conventions/entries"),
  analysis = await load("extract/analysis"),
  edges = await load("extract/edges"),
  references = await load("extract/references"),
  imports = await load("syntax/imports"),
  context = await load("checker/context");
export const sourceFiles = [
  "extract/project",
  "extract/functions",
  "extract/assemble",
  "kinds/rules",
  "kinds/classify",
  "kinds/declarations",
  "kinds/conventions",
  "extract/conventions/entries",
  "extract/analysis",
  "extract/edges",
  "extract/references",
  "extract/callee/factory",
  "syntax/imports",
  "checker/context",
];
export function sourcePins() {
  return Object.fromEntries(
    sourceFiles.map((file) => [
      file,
      createHash("sha256")
        .update(
          fs.readFileSync(
            path.join(root, "packages/code-graph/src", `${file}.ts`),
          ),
        )
        .digest("hex"),
    ]),
  );
}
const foundRows = (rows) =>
  rows.map((f) => ({
    id: f.id,
    name: f.name,
    kind: f.kind,
    file: f.file,
    startLine: f.startLine,
    endLine: f.endLine,
    isExported: f.isExported,
    isTest: f.isTest,
  }));
export function reference(item, fixture) {
  if (item.operation === "merge-entries")
    return [
      ...decl
        .mergeRuleMaps(...item.maps.map((m) => new Map(Object.entries(m))))
        .entries(),
    ];
  if (item.operation === "merge")
    return Object.fromEntries(
      decl.mergeRuleMaps(...item.maps.map((m) => new Map(Object.entries(m)))),
    );
  if (item.operation === "conventions") {
    const compiled = conventions.compileConventions(item.conventions);
    return {
      compiled: compiled.map((c) => c.name),
      matched: conventions.matchingConventions(
        compiled,
        item.packagePath,
        item.exportNames,
      ),
    };
  }
  const loaded = project.loadCheapProject(fixture);
  const found = functions.discoverFunctions(loaded.sourceFiles).functions;
  if (item.operation === "syntax") return { functions: foundRows(found) };
  const rules = rulesModule.NodeKindRulesSchema.parse(item.rules ?? {}),
    compiled = classification.compileKindRules(rules);
  const cheap = assembly.assembleGraph(
    loaded,
    schema.ThresholdsSchema.parse({}),
  );
  if (item.operation === "classify") {
    const node = cheap.functions.find((f) => f.name === "subject");
    if (item.calls)
      node.edges = { calls: item.calls, calledBy: [], chainDepth: 0 };
    const ctx = {
      crossRuntimeTargets: new Set(),
      durableObjectMethods: new Set(),
      baseClassEntries: new Map(),
      declaredGuards: new Map([[node.id, item.guards ?? []]]),
      conventionEntries: new Map([[node.id, item.extraEvidence ?? []]]),
    };
    return classification.classifyFunction(node, compiled, ctx);
  }
  const tsConfig = path.join(fixture, "tsconfig.json"),
    input = analysis.analysisInputs(found),
    im = imports.resolveImports(fixture, loaded.sourceFiles, tsConfig);
  const ctx = context.TypeContext.open({
    rootAbsolute: loaded.rootAbsolute,
    sourceFiles: loaded.sourceFiles,
    tsConfigPath: tsConfig,
    functions: found,
  });
  try {
    const e = edges.resolveEdges(
      ctx,
      im,
      found.map((f) => f.id),
    );
    const refs = references.resolveReferences(
      ctx,
      input.names,
      input.exportsByFile,
    );
    const base = decl.publicMethodRulesByBaseClass(
        ctx,
        compiled.entryBaseClasses,
      ),
      siblings = decl.siblingPropertyRules(ctx, compiled.entryGuardProperties),
      types = decl.typeScopeRules(ctx, compiled.entryGuardProperties),
      guards = decl.mergeRuleMaps(siblings, types);
    const convention = entries.conventionEntries(
      found,
      rules,
      fixture,
      fixture,
    );
    const classCtx = {
      crossRuntimeTargets: new Set(),
      durableObjectMethods: new Set(),
      baseClassEntries: base,
      declaredGuards: guards,
      conventionEntries: convention,
    };
    for (const f of cheap.functions) {
      f.edges = {
        calls: e.callsById.get(f.id) ?? [],
        calledBy: e.calledById.get(f.id) ?? [],
        chainDepth: e.chainDepthById.get(f.id) ?? 0,
      };
      f.nodeKind = classification.classifyFunction(f, compiled, classCtx);
    }
    return {
      functions: foundRows(found),
      calls: Object.fromEntries(e.callsById),
      callers: Object.fromEntries(e.calledById),
      depths: Object.fromEntries(e.chainDepthById),
      references: {
        referencesById: Object.fromEntries(refs.referencesById),
        moduleScopeRoots: refs.moduleScopeRoots,
        testModuleScopeRoots: refs.testModuleScopeRoots,
        identifierFiles: Object.fromEntries(refs.identifierFiles),
      },
      classifications: cheap.functions.map((f) => ({
        id: f.id,
        nodeKind: f.nodeKind,
      })),
      base: Object.fromEntries(base),
      siblings: Object.fromEntries(siblings),
      types: Object.fromEntries(types),
      guards: Object.fromEntries(guards),
      conventions: Object.fromEntries(convention),
    };
  } finally {
    ctx.close();
  }
}
