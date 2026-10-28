import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url)),
  load = (f) =>
    import(
      pathToFileURL(path.join(root, "packages/code-graph/src", `${f}.ts`))
    );
const analysis = await load("boundaries/analyze"),
  impure = await load("boundaries/impure-uses"),
  libraries = await load("boundaries/libraries/libraries"),
  libraryJudgments = await load("boundaries/libraries/violations"),
  cycles = await load("boundaries/deployables/cycles"),
  bindings = await load("boundaries/deployables/bindings"),
  deployables = await load("boundaries/deployables/deployables"),
  rules = await load("boundaries/rules"),
  shape = await load("boundaries/shape/shape"),
  catalog = await load("extract/wrangler-config"),
  project = await load("extract/project"),
  gate = await load("boundaries/gate"),
  units = await load("test-helpers/source-unit");
export const sourceFiles = [
  "boundaries/analyze",
  "boundaries/impure-uses",
  "boundaries/libraries/libraries",
  "boundaries/libraries/violations",
  "boundaries/deployables/cycles",
  "boundaries/deployables/bindings",
  "boundaries/deployables/deployables",
  "boundaries/deployables/judge",
  "boundaries/rules",
  "boundaries/shape/shape",
  "extract/wrangler-config",
  "extract/project",
  "boundaries/gate",
  "boundaries/ledger",
  "boundaries/reconcile",
  "test-helpers/source-unit",
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
export const snapshot = (dir) =>
  Object.fromEntries(
    fs
      .readdirSync(dir, { recursive: true })
      .sort()
      .map((f) => [f, path.join(dir, f)])
      .filter(([, f]) => fs.statSync(f).isFile())
      .map(([f, a]) => [
        f,
        {
          base64: fs.readFileSync(a).toString("base64"),
          mode: fs.statSync(a).mode & 0o777,
        },
      ]),
  );
export function restore(dir, files) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const [f, text] of Object.entries(files)) {
    const at = path.join(dir, f);
    fs.mkdirSync(path.dirname(at), { recursive: true });
    fs.writeFileSync(at, text);
  }
}
const viewedRead = (d) =>
  d.kind === "refused"
    ? d
    : {
        kind: d.kind,
        kinds: [...d.deployables.kinds],
        catalog: d.deployables.catalog,
        graph: d.deployables.graph,
        workspaces: [...d.deployables.workspaces],
        judged: [...d.deployables.judged].map(([m, b]) => [m, [...b]]),
      };
function inputs(item, fixture) {
  const parsed = rules.BoundaryRulesSchema.parse(item.rules ?? {}),
    listing = project.listRepo(fixture),
    c = catalog.loadBindingCatalog(fixture, listing),
    l = libraries.readLibraries(parsed, fixture, listing);
  if (l.kind !== "read") return { refused: { ...l, phase: "libraries" } };
  const d = deployables.readDeployables(parsed, fixture, listing, c);
  if (d.kind !== "read") return { refused: { ...d, phase: "deployables" } };
  const s = shape.readShape(parsed, c);
  if (s.kind !== "read") return { refused: { ...s, phase: "shape" } };
  return {
    parsed,
    libraries: l.libraries,
    deployables: d.deployables,
    shape: s.shape,
  };
}
function runGate(fixture, under, flags = {}) {
  const emitted = [],
    reports = [],
    ledger = path.join(fixture, "boundary-ledger.json"),
    before = fs.existsSync(ledger)
      ? fs.statSync(ledger, { bigint: true })
      : null;
  const exitCode = gate.runBoundaryGate({
    rootAbsolute: path.join(fixture, under),
    repoRoot: fixture,
    boundaryRulesFile: path.join(fixture, "rules.json"),
    ci: false,
    writeCeilings: false,
    acceptCrossings: false,
    migrateCeilings: false,
    json: true,
    pretty: false,
    ...flags,
    emit: (x) => emitted.push(x),
    report: (x) => reports.push(x),
  });
  const after = fs.existsSync(ledger)
    ? fs.statSync(ledger, { bigint: true })
    : null;
  return {
    exitCode,
    emitted,
    reports,
    ledgerWritten:
      before === null
        ? after !== null
        : after === null ||
          before.mtimeNs !== after.mtimeNs ||
          before.ino !== after.ino,
  };
}
export function reference(item, fixture) {
  if (item.mode === "impure")
    return impure.detectImpureUses(units.sourceUnit(item.source).syntax);
  if (item.mode === "bindings")
    return bindings.bindingViolations({
      scope: "services/api",
      file: "src/ok.ts",
      from: "services/api/src/ok.ts",
      importEdges: [],
      bindingSites: item.bindingNames.map((binding, i) => ({
        binding,
        line: i + 1,
      })),
      driven: item.driven ?? false,
      isMain: item.isMain ?? false,
      owners: item.owners,
    });
  if (item.mode === "worker") {
    const c = catalog.loadBindingCatalog(fixture),
      graph = cycles.workerGraph(c);
    return { graph, cycles: cycles.workerCycles(graph) };
  }
  if (item.mode === "read") {
    const parsed = rules.BoundaryRulesSchema.parse(item.rules),
      listing = project.listRepo(fixture),
      c = catalog.loadBindingCatalog(fixture, listing);
    return viewedRead(deployables.readDeployables(parsed, fixture, listing, c));
  }
  if (item.mode === "libraries") {
    const parsed = rules.BoundaryRulesSchema.parse(item.rules),
      l = libraries.readLibraries(parsed, fixture);
    if (l.kind !== "read") return l;
    return {
      kind: l.kind,
      dirs: l.libraries.dirs,
      packageDirs: l.libraries.packageDirs,
      roots: item.roots.map((root) => ({
        root,
        undeclared: libraries.undeclaredUnder(l.libraries, root),
        violations: libraryJudgments.undeclaredLibraries(l.libraries, root),
      })),
    };
  }
  if (item.mode === "analyze") {
    const i = inputs(item, fixture);
    if (i.refused) return i.refused;
    const modules = item.modules.map((m) => ({
        ...m,
        runtimeSpecifiers: new Set(m.runtimeSpecifiers),
      })),
      before = JSON.stringify(item.modules),
      a = analysis.analyzeBoundaries(item.scope, modules, i.parsed, i);
    assert.equal(JSON.stringify(item.modules), before);
    const writes = a.report.violations
      .filter((v) => v.write !== undefined)
      .map((v) => v.write);
    return {
      ...a,
      sharedWriteIdentity:
        writes.length < 2 ? null : writes.every((w) => w === writes[0]),
    };
  }
  if (item.mode === "gate") return runGate(fixture, ".", item.flags);
  if (item.mode === "workflow") {
    const rows = [],
      actions = [
        { name: "report", under: "." },
        {
          name: "record",
          under: ".",
          flags: { acceptCrossings: true, reason: "initial architecture" },
        },
        { name: "repeat-ci", under: ".", flags: { ci: true } },
        {
          name: "repeat-record-no-write",
          under: ".",
          flags: { acceptCrossings: true, reason: "ignored second reason" },
        },
        { name: "add-drift", under: ".", flags: { ci: true }, add: true },
        {
          name: "record-api-scope",
          under: "services/api",
          flags: { acceptCrossings: true, reason: "new API use" },
        },
        {
          name: "remove-and-prune",
          under: ".",
          flags: { ci: true },
          remove: true,
        },
        { name: "other-scope", under: "services/other", flags: { ci: true } },
        { name: "final-report", under: ".", flags: { pretty: true } },
      ];
    for (const action of actions) {
      const at = path.join(
        fixture,
        "services/api/src/orders/application/new.ts",
      );
      if (action.add)
        fs.writeFileSync(at, "export const newer=()=>process.env.X;");
      if (action.remove) fs.unlinkSync(at);
      const before = snapshot(fixture),
        result = runGate(fixture, action.under, action.flags);
      rows.push({
        name: action.name,
        before,
        result,
        after: snapshot(fixture),
      });
    }
    return { steps: rows };
  }
  throw new Error(`unknown mode ${item.mode}`);
}
