import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { loadDataReport } from "../../packages/code-graph/src/data/extract.js";
import * as ts from "../../packages/code-graph/src/engine/tsgo.js";
import {
  assembleGraph,
  assembleGraphWithEdges,
} from "../../packages/code-graph/src/extract/assemble.js";
import { discoverFunctions } from "../../packages/code-graph/src/extract/functions.js";
import {
  loadCheapProject,
  loadEdgeProject,
} from "../../packages/code-graph/src/extract/project.js";
import { NodeKindRulesSchema } from "../../packages/code-graph/src/kinds/rules.js";
import {
  GraphSchema,
  ThresholdsSchema,
} from "../../packages/code-graph/src/schema.js";

const binary = process.argv[2];
assert.ok(
  binary,
  "usage: node --import tsx graph-data-assembly.mts <native-driver> [evidence.json]",
);
assert.equal(process.version, "v22.21.1");
assert.ok(process.versions.v8.startsWith("12.4."));
assert.equal((await ts.tsgoBinary()).version, "7.0.0-dev.20260707.2");
const repo = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const manifest = createRequire(
  path.join(repo, "packages/code-graph/package.json"),
).resolve("@typescript/native-preview/package.json");
const inputSchema = z.strictObject({
  root: z.string(),
  repoRoot: z.string().optional(),
  pass: z.enum(["cheap", "edges"]),
  scope: z.enum(["package", "deep"]).optional(),
  data: z.boolean(),
  analysis: z.boolean().default(false),
  headers: z.boolean().default(false),
  thresholds: ThresholdsSchema.default(() => ThresholdsSchema.parse({})),
});
type Input = z.infer<typeof inputSchema>;
type Case = { id: string; operation: "code_graph.data_graph"; input: Input };
const responseSchema = z.object({
  id: z.string().nullable(),
  ok: z.boolean(),
  output: z.unknown().optional(),
  error: z.object({ kind: z.string(), message: z.string() }).optional(),
  observedCalls: z.array(z.string()),
});
type Response = z.infer<typeof responseSchema>;
const root = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "demlik-data-assembly-parity-")),
);
const cases: Case[] = [];
function write(file: string, text: string): void {
  const absolute = path.join(root, file);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, text);
}
function config(dir: string): void {
  write(
    `${dir}/tsconfig.json`,
    JSON.stringify({
      compilerOptions: {
        strict: true,
        target: "es2022",
        module: "esnext",
        moduleResolution: "bundler",
        types: [],
      },
    }),
  );
}
function add(id: string, dir: string, options: Partial<Input> = {}): void {
  cases.push({
    id,
    operation: "code_graph.data_graph",
    input: inputSchema.parse({
      root: path.join(root, dir),
      pass: "cheap",
      data: true,
      ...options,
    }),
  });
}
function copyFixture(source: string, destination: string): void {
  fs.cpSync(source, path.join(root, destination), { recursive: true });
  const pending = [path.join(root, destination)];
  for (
    let directory = pending.pop();
    directory !== undefined;
    directory = pending.pop()
  ) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(file);
      else if (entry.name.startsWith("wrangler.fixture."))
        fs.renameSync(
          file,
          path.join(
            directory,
            entry.name.replace("wrangler.fixture.", "wrangler."),
          ),
        );
    }
  }
}
function reference(item: Case): Response {
  try {
    const input = item.input;
    if (input.pass === "cheap" && input.analysis)
      throw new Error("cheap pass cannot request semantic analysis");
    if (input.pass === "cheap" && input.scope !== undefined)
      throw new Error("cheap pass cannot request an edge scope");
    const repoRoot = input.repoRoot ?? input.root;
    const data = input.data ? { repoRoot } : null;
    const fields = { headers: input.headers };
    const { loaded, graph } = (() => {
      if (input.pass === "cheap") {
        const loaded = loadCheapProject(input.root);
        return {
          loaded,
          graph: assembleGraph(loaded, input.thresholds, data, fields),
        };
      }
      const loaded = loadEdgeProject(
        input.root,
        input.scope ?? "package",
        repoRoot,
      );
      return {
        loaded,
        graph: assembleGraphWithEdges(
          loaded,
          input.thresholds,
          loaded.scope,
          loaded.tsConfigPath,
          input.analysis
            ? {
                crossRuntime: true,
                kinds: true,
                reach: true,
                clusters: true,
                interfaceWidth: true,
                kindRules: NodeKindRulesSchema.parse({}),
                repoRoot,
              }
            : null,
          data,
          fields,
        ),
      };
    })();
    const parsed = GraphSchema.parse(graph);
    assert.equal(parsed.data !== null, input.data, item.id);
    if (input.data) {
      const functions = discoverFunctions(loaded.sourceFiles).functions;
      assert.deepEqual(
        parsed.data,
        loadDataReport(loaded.sourceFiles, functions, repoRoot),
        item.id,
      );
    }
    return {
      id: item.id,
      ok: true,
      output: JSON.parse(JSON.stringify(parsed)),
      observedCalls: [],
    };
  } catch (error) {
    return {
      id: item.id,
      ok: false,
      error: {
        kind: error instanceof TypeError ? "type-error" : "backend-error",
        message: error instanceof Error ? error.message : String(error),
      },
      observedCalls: [],
    };
  }
}
try {
  for (const fixture of ["fixture", "alias-scope"]) {
    copyFixture(
      path.join(repo, "packages/code-graph/test/data", fixture),
      fixture,
    );
    for (const pass of ["cheap", "edges"] as const) {
      for (const data of [false, true])
        add(`${fixture}-${pass}-data-${data}`, fixture, {
          pass,
          data,
          headers: true,
        });
    }
    for (const data of [false, true])
      add(`${fixture}-edges-all-analysis-data-${data}`, fixture, {
        pass: "edges",
        data,
        analysis: true,
      });
  }
  add("selected-worker-package-data", "fixture/workers/api", {
    pass: "edges",
    scope: "package",
    repoRoot: path.join(root, "fixture"),
  });
  add("selected-worker-deep-data-and-analysis", "fixture/workers/api", {
    pass: "edges",
    scope: "deep",
    analysis: true,
    repoRoot: path.join(root, "fixture"),
  });
  config("raw");
  write(
    "raw/wrangler.json",
    String.raw`{"name":"\udfff","d1_databases":[{"binding":"\ud800"}],"kv_namespaces":[{"binding":""}]}`,
  );
  write(
    "raw/entry.ts",
    'export function raw(env: any) {env["\\ud800"]["\\udfff"]("SELECT 1"); env[""].put("k","v");}\n',
  );
  add("raw-data-fields-in-cheap-graph", "raw");
  add("raw-data-fields-with-measured-analysis", "raw", {
    pass: "edges",
    analysis: true,
  });
  config("empty");
  write("empty/entry.ts", "export function empty() { return 0; }\n");
  for (const pass of ["cheap", "edges"] as const) {
    for (const data of [false, true])
      add(`empty-${pass}-data-${data}`, "empty", { pass, data });
  }
  add("empty-edges-all-analysis-data-true", "empty", {
    pass: "edges",
    analysis: true,
  });
  add("independent-data-repo-root-measures-no-owned-sites", "fixture", {
    repoRoot: path.join(root, "empty"),
  });
  config("malformed");
  write("malformed/wrangler.jsonc", '{"d1_databases":[{"binding":"DB"}');
  write(
    "malformed/entry.ts",
    "export function parsed(env: any) { return env.DB.prepare('SELECT 1'); }\n",
  );
  for (const pass of ["cheap", "edges"] as const)
    add(`unparsed-config-${pass}`, "malformed", { pass });
  add("unparsed-config-edges-all-analysis", "malformed", {
    pass: "edges",
    analysis: true,
  });
  config("throws");
  write("throws/wrangler.json", '{"vars":{"constructor":null}}');
  write("throws/entry.ts", "export function safe() { return 0; }\n");
  for (const pass of ["cheap", "edges"] as const) {
    for (const data of [false, true])
      add(`constructor-null-${pass}-data-${data}`, "throws", { pass, data });
  }
  for (const data of [false, true])
    add(`constructor-null-analysis-before-data-${data}`, "throws", {
      pass: "edges",
      analysis: true,
      data,
    });
  config("parse");
  write(
    "parse/wrangler.json",
    '{"name":"parse","d1_databases":[{"binding":"DB"}]}',
  );
  write(
    "parse/valid.ts",
    "export function valid(env: any) {return env.DB.prepare('SELECT 1');}\n",
  );
  write("parse/broken.ts", "export function broken( {\n");
  for (const pass of ["cheap", "edges"] as const)
    add(`parse-failure-stays-visible-${pass}`, "parse", { pass });
  add("missing-tsconfig-is-observable-before-data", "missing", {
    pass: "edges",
  });
  cases.push({
    id: "existing-core-fixture-measured-with-all-analysis-and-data",
    operation: "code_graph.data_graph",
    input: inputSchema.parse({
      root: path.join(
        repo,
        "packages/code-graph/test/parity/fixture/apps/core",
      ),
      pass: "edges",
      data: true,
      analysis: true,
    }),
  });
  const expected = cases.map(reference);
  const byId = (id: string) =>
    GraphSchema.parse(
      expected[cases.findIndex((item) => item.id === id)].output,
    );
  for (const [index, answer] of expected.entries()) {
    const item = cases[index];
    const throws =
      item.id.includes("constructor-null") &&
      (item.input.data || item.input.analysis);
    assert.equal(
      answer.ok,
      !throws && !item.id.startsWith("missing-tsconfig"),
      `${item.id}: ${JSON.stringify(answer.error)}`,
    );
  }
  const cheap = byId("fixture-cheap-data-true");
  assert.equal(cheap.data?.edges.length, 18);
  assert.equal(cheap.data?.unattributed.length, 2);
  assert.deepEqual(cheap.data, byId("fixture-edges-data-true").data);
  assert.deepEqual(
    cheap.data,
    byId("fixture-edges-all-analysis-data-true").data,
  );
  assert.equal(byId("fixture-cheap-data-false").data, null);
  assert.deepEqual(byId("empty-cheap-data-true").data, {
    configFiles: [],
    unparsedConfigs: [],
    edges: [],
    unattributed: [],
  });
  assert.equal(
    byId("raw-data-fields-with-measured-analysis").data?.edges[0].binding,
    "\ud800",
  );
  assert.deepEqual(
    byId("unparsed-config-edges-all-analysis").data?.unparsedConfigs,
    ["wrangler.jsonc"],
  );
  assert.deepEqual(
    byId("parse-failure-stays-visible-edges").stats.parseFailures,
    ["broken.ts"],
  );
  const invalid = [
    "not json",
    JSON.stringify({
      id: "missing-root",
      operation: "code_graph.data_graph",
      input: { pass: "cheap", data: true },
    }),
    JSON.stringify({
      id: "missing-pass",
      operation: "code_graph.data_graph",
      input: { root, data: true },
    }),
    JSON.stringify({
      id: "missing-data",
      operation: "code_graph.data_graph",
      input: { root, pass: "cheap" },
    }),
    JSON.stringify({
      id: "bad-data",
      operation: "code_graph.data_graph",
      input: { root, pass: "cheap", data: "yes" },
    }),
    JSON.stringify({
      id: "unknown-option",
      operation: "code_graph.data_graph",
      input: { root, pass: "edges", data: true, silentlyIgnored: true },
    }),
    JSON.stringify({
      id: "cheap-analysis",
      operation: "code_graph.data_graph",
      input: { root, pass: "cheap", data: true, analysis: true },
    }),
    JSON.stringify({
      id: "cheap-scope",
      operation: "code_graph.data_graph",
      input: { root, pass: "cheap", data: true, scope: "deep" },
    }),
  ];
  const native = spawnSync(binary, [manifest], {
    input: `${[...cases.map((item) => JSON.stringify(item)), ...invalid].join("\n")}\n`,
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
  });
  assert.equal(native.status, 0, native.stderr);
  assert.equal(native.stderr, "");
  const actual = native.stdout
    .trim()
    .split("\n")
    .map((line) => responseSchema.parse(JSON.parse(line)));
  assert.equal(actual.length, cases.length + invalid.length);
  for (const [index, answer] of expected.entries()) {
    const returned = actual[index],
      item = cases[index];
    assert.equal(
      returned.ok,
      answer.ok,
      `${item.id}: ${JSON.stringify(returned.error)}`,
    );
    if (answer.ok) {
      GraphSchema.parse(returned.output);
      assert.deepEqual(returned.output, answer.output, item.id);
      const api =
        item.input.pass === "edges"
          ? "assemble_graph_with_reports"
          : item.input.data
            ? "assemble_graph_with_data"
            : "assemble_graph";
      assert.ok(
        returned.observedCalls.includes(
          `demlik_code_graph::extract::assemble::${api}`,
        ),
        item.id,
      );
    } else assert.deepEqual(returned.error, answer.error, item.id);
  }
  for (const answer of actual.slice(cases.length)) {
    assert.equal(answer.ok, false);
    assert.equal(answer.error?.kind, "driver-error");
    assert.ok(answer.error.message);
    assert.deepEqual(answer.observedCalls, []);
  }
  const graphs = expected
    .filter((answer) => answer.ok)
    .map((answer) => GraphSchema.parse(answer.output));
  const evidence = {
    reference: {
      node: process.version,
      v8: process.versions.v8,
      parser: "OXC 0.151.0",
      compiler: "7.0.0-dev.20260707.2",
      profile:
        "full cheap/measured Graph equality; data remains syntax-only and composes with all measured analysis",
    },
    passed: cases.length,
    rejectedInvalidInputs: invalid.length,
    functions: graphs.reduce((sum, graph) => sum + graph.functions.length, 0),
    sites: graphs.reduce(
      (sum, graph) =>
        sum +
        (graph.data?.edges.length ?? 0) +
        (graph.data?.unattributed.length ?? 0),
      0,
    ),
    nativeApis: [
      ...new Set(actual.flatMap((answer) => answer.observedCalls)),
    ].sort(),
    cases: actual,
  };
  if (process.argv[3])
    fs.writeFileSync(process.argv[3], `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify({ ...evidence, cases: undefined }, null, 2));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
