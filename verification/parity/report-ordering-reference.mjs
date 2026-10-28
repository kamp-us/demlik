import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assembleGraph,
  assembleGraphWithEdges,
} from "../../packages/code-graph/src/extract/assemble.js";
import { buildDirectories } from "../../packages/code-graph/src/extract/directories.js";
import {
  loadCheapProject,
  loadEdgeProject,
} from "../../packages/code-graph/src/extract/project.js";
import { renderUnreachable } from "../../packages/code-graph/src/render/analysis.js";
import { buildHtmlModel } from "../../packages/code-graph/src/render/html-model.js";
import { renderPlan } from "../../packages/code-graph/src/render/plan.js";
import {
  DirectoryNodeSchema,
  FunctionNodeSchema,
  GraphSchema,
  ModuleNodeSchema,
  ThresholdsSchema,
} from "../../packages/code-graph/src/schema.js";
import {
  compareFlatSmells,
  smellsForDirectory,
  smellsForFunction,
  smellsForModule,
} from "../../packages/code-graph/src/smells/evaluate.js";
import { rankPlan } from "../../packages/code-graph/src/smells/plan.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
const require = createRequire(import.meta.url);
export const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const sourceFiles = [
  "smells/evaluate.ts",
  "smells/plan.ts",
  "smells/rules.ts",
  "smells/coupling.ts",
  "render/plan.ts",
  "render/analysis.ts",
  "render/html-model.ts",
  "render/json.ts",
  "extract/assemble.ts",
  "extract/directories.ts",
  "extract/edges.ts",
  "extract/project.ts",
  "schema/core.ts",
  "schema/reachability.ts",
  "index.ts",
  "cli.ts",
];
export const pins = () =>
  Object.fromEntries(
    sourceFiles.map((file) => [
      file,
      hash(fs.readFileSync(path.join(root, "packages/code-graph/src", file))),
    ]),
  );
export function snapshot(directory) {
  return Object.fromEntries(
    fs
      .readdirSync(directory, { recursive: true })
      .filter((file) => fs.statSync(path.join(directory, file)).isFile())
      .sort()
      .map((file) => [
        file,
        {
          base64: fs
            .readFileSync(path.join(directory, file))
            .toString("base64"),
          mode: fs.statSync(path.join(directory, file)).mode & 0o777,
        },
      ]),
  );
}
export function restore(directory, files) {
  fs.rmSync(directory, { recursive: true, force: true });
  fs.mkdirSync(directory, { recursive: true });
  for (const [file, value] of Object.entries(files)) {
    const target = path.join(directory, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, Buffer.from(value.base64, "base64"));
    fs.chmodSync(target, value.mode);
  }
}
const fn = (value) =>
  FunctionNodeSchema.parse({
    id: "f",
    name: value.id?.split(":").at(-1) ?? "f",
    kind: "function",
    file: "one.ts",
    startLine: 1,
    endLine: 1,
    loc: 1,
    commentLines: 0,
    nestingDepth: 0,
    complexity: 1,
    isExported: true,
    isTest: false,
    edges: null,
    nodeKind: null,
    smells: [],
    ...value,
  });
const module = (value) =>
  ModuleNodeSchema.parse({
    file: "one.ts",
    loc: 1,
    commentLines: 0,
    functionIds: [],
    imports: [],
    importedBy: [],
    importEdges: [],
    isTest: false,
    smells: [],
    ...value,
  });
const thresholds = (value) => ThresholdsSchema.parse(value ?? {});
function graph(input) {
  const functions = (input.functions ?? []).map(fn);
  const modules = (input.modules ?? []).map(module);
  const t = thresholds(input.thresholds);
  return GraphSchema.parse({
    root: "authored",
    provenance: { pass: "cheap" },
    thresholds: t,
    summary: {
      health: "rough",
      fileCount: modules.length,
      functionCount: functions.length,
      smellCount: functions.reduce((n, f) => n + f.smells.length, 0),
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
    functions,
    modules,
    directories: buildDirectories(modules, t),
    declarations: [],
    smells: functions.flatMap((f) => f.smells),
    stats: {
      fileCount: modules.length,
      functionCount: functions.length,
      totalLoc: 0,
      totalCommentLines: 0,
      smellCount: 0,
      parseFailures: [],
    },
  });
}
const permutations = (xs) =>
  xs.length === 0
    ? [[]]
    : xs.flatMap((x, i) =>
        permutations(xs.filter((_, j) => i !== j)).map((rest) => [x, ...rest]),
      );
function renderViews(g, axis) {
  return {
    rows: rankPlan(g.functions, axis),
    text: renderPlan(g, axis, false, false),
    json: renderPlan(g, axis, true, false),
    pretty: renderPlan(g, axis, true, true),
  };
}
function cli(input, directory, saved) {
  const output = [];
  for (const action of input.actions) {
    const before = snapshot(directory);
    const packet = path.join(saved, `${action.id}.packet.json`);
    fs.writeFileSync(
      packet,
      JSON.stringify({
        index: path.join(root, "packages/code-graph/src/index.ts"),
        argv: [directory, ...action.flags],
        ...(action.initial === undefined ? {} : { initial: action.initial }),
      }),
    );
    const command = [
      "--import",
      require.resolve("tsx"),
      path.join(root, "verification/parity/icu77-env-keys-source-cli.mjs"),
      packet,
    ];
    const child = spawnSync(process.execPath, command, {
      cwd: directory,
      env: { ...process.env, PATH: "/nonexistent", TMPDIR: "/private/tmp" },
      encoding: "utf8",
      maxBuffer: 32 << 20,
    });
    assert.ifError(child.error);
    assert.equal(child.signal, null);
    const status = action.code ?? action.initial ?? 0;
    assert.equal(child.status, status, child.stderr);
    fs.writeFileSync(
      path.join(saved, `${action.id}.process.json`),
      `${JSON.stringify({ command: [process.execPath, ...command], status: child.status, signal: child.signal, stdout: child.stdout, stderr: child.stderr }, null, 2)}\n`,
    );
    output.push({
      id: action.id,
      process: {
        status: child.status,
        signal: child.signal,
        stdout: child.stdout,
        stderr: child.stderr,
      },
      before,
      after: snapshot(directory),
    });
  }
  return output;
}
export function reference(input, directory, saved) {
  const calls = [];
  const observe = (name, operation) => {
    const result = operation();
    calls.push(name);
    return result;
  };
  let output;
  if (input.mode === "kind-matrix") {
    const one = (kind) => ({
      kind,
      target: { type: "function", id: "same", file: "same.ts", startLine: 1 },
      value: 1,
      threshold: 1,
      severity: "warn",
    });
    output = input.words.flatMap((left) =>
      input.words.map((right) => ({
        left,
        right,
        result: compareFlatSmells(one(left), one(right)),
      })),
    );
    calls.push("compareFlatSmells");
  } else if (input.mode === "tally") {
    output = permutations(input.reasons).map((order) => {
      const g = graph({});
      g.reachability = {
        entryCount: 0,
        exportedCount: 0,
        reachableCount: 0,
        unreachable: [],
        withheld: order.flatMap((reason) =>
          Array.from({ length: input.reasons.indexOf(reason) + 1 }, (_, i) => ({
            id: `${reason}.${i}`,
            reason,
          })),
        ),
        unguarded: [],
      };
      return {
        order,
        text: renderUnreachable(g, false, false),
        json: renderUnreachable(g, true, false),
        pretty: renderUnreachable(g, true, true),
      };
    });
    calls.push("renderUnreachable");
  } else if (input.mode === "function")
    output = observe("smellsForFunction", () =>
      input.functions.map((f) =>
        smellsForFunction(fn(f), thresholds(input.thresholds)),
      ),
    );
  else if (input.mode === "module")
    output = observe("smellsForModule", () =>
      input.modules.map((m, i) =>
        smellsForModule(
          module(m),
          thresholds(input.thresholds),
          input.coupling[i],
        ),
      ),
    );
  else if (input.mode === "directory")
    output = observe("smellsForDirectory", () =>
      input.directories.map((d) =>
        smellsForDirectory(
          DirectoryNodeSchema.parse({
            functionCount: 0,
            files: [],
            smells: [],
            ...d,
          }),
          thresholds(input.thresholds),
        ),
      ),
    );
  else if (input.mode === "flat") {
    const smells = structuredClone(input.smells);
    output = observe("compareFlatSmells", () => smells.sort(compareFlatSmells));
  } else if (input.mode === "plan" || input.mode === "render-plan") {
    const g = graph(input),
      before = JSON.stringify(g.functions);
    output = observe("rankPlan/renderPlan", () => renderViews(g, input.axis));
    assert.equal(JSON.stringify(g.functions), before);
  } else if (input.mode === "empty") {
    const g = graph({});
    output = {
      plans: renderViews(g, "rot"),
      noPass: renderUnreachable(g, false, false),
    };
    g.reachability = {
      entryCount: 0,
      exportedCount: 0,
      reachableCount: 0,
      unreachable: [],
      withheld: [],
      unguarded: [],
    };
    output.emptyText = renderUnreachable(g, false, false);
    output.emptyJson = renderUnreachable(g, true, true);
    calls.push("rankPlan/renderPlan/renderUnreachable");
  } else if (input.mode === "html") {
    const g = graph(input);
    output = observe("buildHtmlModel", () => buildHtmlModel(g));
    assert.equal(output.summary, g.summary);
  } else if (input.mode === "cheap" || input.mode === "go") {
    let g;
    const t = thresholds(input.thresholds);
    if (input.mode === "go") {
      const loaded = loadEdgeProject(directory, "deep", directory);
      g = observe("assembleGraphWithEdges", () =>
        assembleGraphWithEdges(loaded, t, "deep", loaded.tsConfigPath),
      );
    } else
      g = observe("assembleGraph", () =>
        assembleGraph(loadCheapProject(directory), t),
      );
    assert(g.modules.length > 2);
    assert(g.smells.length > 0);
    output = {
      graph: g,
      plan: renderViews(g, input.mode === "go" ? "impact" : "rot"),
    };
    if (input.id === "summary-top10-worst") {
      assert.equal(g.summary.topTargets.length, 10);
      assert(g.summary.worstFunction);
    }
  } else if (input.mode === "cli") output = cli(input, directory, saved);
  else throw new Error(`unknown fixture mode ${input.mode}`);
  return { output, calls };
}
