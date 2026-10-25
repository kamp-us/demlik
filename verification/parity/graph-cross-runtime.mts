import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { TypeContext } from "../../packages/code-graph/src/checker/context.js";
import * as ts from "../../packages/code-graph/src/engine/tsgo.js";
import { enclosingId } from "../../packages/code-graph/src/extract/callee/resolve.js";
import {
  createCrossRuntimeResolver,
  methodIdsOfClasses,
  ownerOf,
} from "../../packages/code-graph/src/extract/cross-runtime.js";
import { resolveEdges } from "../../packages/code-graph/src/extract/edges.js";
import { discoverFunctions } from "../../packages/code-graph/src/extract/functions.js";
import { loadEdgeProject } from "../../packages/code-graph/src/extract/project.js";
import { loadBindingCatalog } from "../../packages/code-graph/src/extract/wrangler-config.js";
import { resolveImports } from "../../packages/code-graph/src/syntax/imports.js";

const binary = process.argv[2];
assert.ok(
  binary,
  "usage: node --import tsx graph-cross-runtime.mts <native-driver> [evidence.json]",
);
assert.equal(process.version, "v22.21.1");
assert.ok(process.versions.v8.startsWith("12.4."));
const repo = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const manifest = createRequire(
  path.join(repo, "packages/code-graph/package.json"),
).resolve("@typescript/native-preview/package.json");
assert.equal((await ts.tsgoBinary()).version, "7.0.0-dev.20260707.2");
const inputSchema = z.strictObject({
  root: z.string(),
  repoRoot: z.string().optional(),
  scope: z.enum(["package", "deep"]).optional(),
  ownerFiles: z.array(z.string()).default([]),
  classes: z.array(z.string()).default([]),
});
type Input = z.infer<typeof inputSchema>;
type Case = { id: string; operation: "code_graph.cross_runtime"; input: Input };
const responseSchema = z.object({
  id: z.string().nullable(),
  ok: z.boolean(),
  output: z.unknown().optional(),
  error: z.object({ kind: z.string(), message: z.string() }).optional(),
  observedCalls: z.array(z.string()),
});
type Response = z.infer<typeof responseSchema>;
const root = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "demlik-cross-runtime-parity-")),
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
      include: ["**/*.ts"],
    }),
  );
}
function add(id: string, dir: string, input: Partial<Input> = {}): void {
  cases.push({
    id,
    operation: "code_graph.cross_runtime",
    input: inputSchema.parse({ root: path.join(root, dir), ...input }),
  });
}
function service(
  dir: string,
  options: {
    target?: string;
    class?: string;
    source?: string;
    owner?: string;
  } = {},
): void {
  config(dir);
  write(
    `${dir}/api/wrangler.json`,
    JSON.stringify({
      name: options.owner ?? "api",
      services: [
        {
          binding: "SEARCH",
          service: options.target ?? "worker",
          entrypoint: options.class ?? "Search",
        },
      ],
    }),
  );
  write(
    `${dir}/api/entry.ts`,
    "declare const env: any;\nexport function execute() { env.SEARCH.search(); }\n",
  );
  write(`${dir}/worker/wrangler.toml`, "name='worker'\n");
  write(
    `${dir}/worker/search.ts`,
    options.source ?? "export class Search { search() {} }\n",
  );
}
function reference(item: Case): Response {
  try {
    const input = item.input;
    const repoRoot = input.repoRoot ?? input.root;
    const loaded = loadEdgeProject(
      input.root,
      input.scope ?? "package",
      repoRoot,
    );
    const catalog = loadBindingCatalog(repoRoot);
    const owners = input.ownerFiles.map(
      (file) => ownerOf(catalog.manifests, file)?.service ?? null,
    );
    const { functions } = discoverFunctions(loaded.sourceFiles);
    const imports = resolveImports(
      input.root,
      loaded.sourceFiles,
      loaded.tsConfigPath,
    );
    const ctx = TypeContext.open({
      rootAbsolute: input.root,
      tsConfigPath: loaded.tsConfigPath,
      sourceFiles: loaded.sourceFiles,
      functions,
    });
    try {
      const methods = [...methodIdsOfClasses(ctx, new Set(input.classes))];
      const resolverInput = {
        catalog,
        rootAbsolute: input.root,
        repoRoot,
        ctx,
      };
      const probeResolver = createCrossRuntimeResolver(resolverInput);
      const probes: { callerId: string; line: number; callee: unknown }[] = [];
      for (const file of ctx.files) {
        function visit(node: ts.Node): void {
          if (ts.isCallExpression(node)) {
            const callerId = enclosingId(node, ctx.nodeToId);
            if (callerId !== null)
              probes.push({
                callerId,
                line: ctx.startLine(node),
                callee: probeResolver.resolve(
                  node,
                  callerId,
                  ctx.relativePath(node.getSourceFile()),
                ),
              });
          }
          node.forEachChild(visit);
        }
        file.source.forEachChild(visit);
      }
      const resolver = createCrossRuntimeResolver(resolverInput);
      const edges = resolveEdges(
        ctx,
        imports,
        functions.map((fn) => fn.id),
        resolver,
      );
      return {
        id: item.id,
        ok: true,
        observedCalls: [],
        output: {
          catalog,
          owners,
          functions: functions.length,
          details: {
            methods,
            probes,
            edges: {
              callsById: Object.fromEntries(edges.callsById),
              calledById: Object.fromEntries(edges.calledById),
              chainDepthById: Object.fromEntries(edges.chainDepthById),
              importsByFile: Object.fromEntries(edges.importsByFile),
              importedByFile: Object.fromEntries(edges.importedByFile),
              importEdgesByFile: Object.fromEntries(edges.importEdgesByFile),
            },
            crossEdges: resolver.edges(),
            unjoined: ctx.unjoined,
          },
        },
      };
    } finally {
      ctx.close();
    }
  } catch (error) {
    return {
      id: item.id,
      ok: false,
      observedCalls: [],
      error: {
        kind: error instanceof TypeError ? "type-error" : "backend-error",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}
try {
  config("real");
  write(
    "real/api/wrangler.json",
    String.raw`{"name":"api","services":[{"binding":"SEARCH","service":"worker","entrypoint":"Search"},{"binding":"MISSING","service":"\ud800","entrypoint":"Absent"}],"durable_objects":{"bindings":[{"name":"ROOM","class_name":"Room"}]},"workflows":[{"binding":"FLOW","class_name":"Flow","script_name":"worker"}]}`,
  );
  write("real/worker/wrangler.toml", "name='worker'\n");
  write(
    "real/api/entry.ts",
    "export class Api {\n constructor(private env: any) {}\n execute() {\n this.env.SEARCH.search(); this.env.SEARCH.search();\n this.env.MISSING.load();\n this.env.FLOW.create({});\n this.env.FLOW.createBatch([]);\n this.env.FLOW.get('ignored');\n this.env.ROOM.hit();\n }\n}\n",
  );
  write(
    "real/api/room.ts",
    "export class Room { hit() {} private hidden() {} static build() {} }\n",
  );
  write("real/worker/search.ts", "export class Search { search() {} }\n");
  write(
    "real/worker/flow.ts",
    "class FlowImpl { run() {} }\ndeclare function wrap<T>(value: T): T;\nconst Flow = wrap(FlowImpl);\n",
  );
  add(
    "real-workers-services-do-workflows-dedup-and-missing-utf16-target",
    "real",
    {
      classes: ["Room", "Flow"],
      ownerFiles: ["api/entry.ts", "worker/flow.ts", "api-other/entry.ts"],
    },
  );
  add("target-known-but-not-loaded-in-selected-project", "real/api", {
    repoRoot: path.join(root, "real"),
    scope: "deep",
    classes: ["Room", "Flow"],
  });
  service("ambiguous");
  write("ambiguous/worker/second.ts", "export class Search { search() {} }\n");
  add("two-loaded-matching-methods-are-ambiguous", "ambiguous");
  service("duplicate");
  write("duplicate/other/wrangler.json", '{"name":"worker"}');
  add("duplicate-service-names-have-no-target-directory", "duplicate");
  service("missing-class", { class: "Absent" });
  add("existing-service-without-target-class-is-not-loaded", "missing-class");
  service("unknown-service", { target: "absent" });
  add("missing-service-is-observable", "unknown-service");
  service("decoded", { source: String.raw`class \u0053earch { search() {} }` });
  add("class-index-uses-decoded-identifier-text", "decoded", {
    classes: ["Search", String.raw`\u0053earch`],
  });
  service("wrapper", {
    class: "Wrapper",
    source:
      "class Search { search() {} }\ndeclare function wrap<T>(value: T): T;\nconst Wrapper = wrap(Search);\n",
  });
  add("nonexported-top-level-wrapping-variable-is-a-class-alias", "wrapper", {
    classes: ["Wrapper"],
  });
  service("raw-wrapper", {
    class: "Wrapper",
    source: String.raw`class Search { search() {} } declare function wrap<T>(value: T): T; const Wrapper = wrap(\u0053earch);`,
  });
  add("wrapper-argument-comparison-preserves-source-spelling", "raw-wrapper", {
    classes: ["Wrapper"],
  });
  service("default", {
    class: "default",
    source: "export default class { search() {} }\n",
  });
  add("anonymous-class-declaration-uses-default-name", "default", {
    classes: ["default"],
  });
  service("anonymous-expression", {
    class: "Variable",
    source: "const Variable = class { search() {} };\n",
  });
  add("anonymous-class-expression-uses-variable-name", "anonymous-expression", {
    classes: ["Variable"],
  });
  service("named-expression", {
    class: "Inner",
    source: "const Outer = class Inner { search() {} };\n",
  });
  add("named-class-expression-retains-inner-name", "named-expression", {
    classes: ["Inner", "Outer"],
  });
  service("shapes");
  write(
    "shapes/api/entry.ts",
    "declare const env: any;\nexport function execute() {\n env.SEARCH.search();\n env['SEARCH'].search();\n env.SEARCH['search']();\n env?.SEARCH?.search();\n (env.SEARCH).search();\n const nested = () => env.SEARCH.search();\n nested();\n}\n",
  );
  add(
    "property-access-only-shape-and-discovered-nested-call-ownership",
    "shapes",
  );
  service("owners", { owner: "nested" });
  write(
    "owners/wrangler.json",
    '{"name":"root","services":[{"binding":"SEARCH","service":"absent"}]}',
  );
  add("nearest-owner-wins-with-component-boundaries", "owners", {
    ownerFiles: [
      "api/entry.ts",
      "api-other/entry.ts",
      "worker/search.ts",
      "index.ts",
    ],
  });
  service("raw-owner", { owner: "\udfff", target: "\ud800" });
  add("raw-service-labels-survive-reports-and-unresolved-callees", "raw-owner");
  config("outside");
  write(
    "outside/catalog/wrangler.json",
    '{"name":"worker","services":[{"binding":"SEARCH","service":"worker","entrypoint":"Search"}]}',
  );
  write(
    "outside/entry.ts",
    "declare const env: any;\nclass Search { search() {} }\nexport function execute() { env.SEARCH.search(); }\n",
  );
  add(
    "outside-repo-prefix-retains-source-ancestor-index-ambiguity",
    "outside",
    { repoRoot: path.join(root, "outside/catalog") },
  );
  config("empty");
  write("empty/entry.ts", "export function execute() {}\n");
  add("empty-catalog-does-not-invent-cross-runtime-edges", "empty", {
    ownerFiles: ["entry.ts"],
  });
  config("throwing");
  write("throwing/wrangler.json", '{"vars":{"constructor":null}}');
  write("throwing/entry.ts", "export function execute() {}\n");
  add("catalog-type-error-remains-observable", "throwing");
  add("missing-project-configuration-remains-observable", "missing");
  const worker = path.join(
    repo,
    "packages/code-graph/test/parity/fixture/apps/worker",
  );
  for (const entry of fs.readdirSync(worker))
    if (entry.endsWith(".ts") || entry === "tsconfig.json")
      write(
        `existing-worker/${entry}`,
        fs.readFileSync(path.join(worker, entry), "utf8"),
      );
  write(
    "existing-worker/wrangler.toml",
    fs.readFileSync(path.join(worker, "wrangler.fixture.toml"), "utf8"),
  );
  add("existing-worker-fixture-workflow-wrapper-and-get", "existing-worker", {
    classes: ["Store", "ScanWorkflow", "OrphanWorkflow"],
  });
  cases.push({
    id: "existing-code-graph-core-fixture",
    operation: "code_graph.cross_runtime",
    input: inputSchema.parse({
      root: path.join(
        repo,
        "packages/code-graph/test/parity/fixture/apps/core",
      ),
      classes: ["User", "Store"],
    }),
  });
  const expected = cases.map(reference);
  const detailSchema = z.object({
    functions: z.number(),
    details: z.object({
      methods: z.array(z.string()),
      crossEdges: z.array(
        z.object({
          binding: z.string(),
          method: z.string(),
          calleeId: z.string().nullable(),
          reason: z.string().nullable(),
          targetService: z.string(),
        }),
      ),
      edges: z.object({
        callsById: z.record(z.string(), z.array(z.unknown())),
      }),
    }),
  });
  const first = detailSchema.parse(expected[0].output);
  assert.equal(first.details.crossEdges.length, 5);
  assert.equal(first.details.methods.length, 4);
  assert.equal(first.details.edges.callsById["api/entry.ts:execute"].length, 6);
  assert.equal(
    first.details.crossEdges.find((edge) => edge.binding === "MISSING")
      ?.targetService,
    "\ud800",
  );
  for (const [id, reason] of [
    ["two-loaded-matching-methods-are-ambiguous", "ambiguous-target"],
    [
      "duplicate-service-names-have-no-target-directory",
      "target-service-unknown",
    ],
    [
      "existing-service-without-target-class-is-not-loaded",
      "target-not-loaded",
    ],
    [
      "wrapper-argument-comparison-preserves-source-spelling",
      "target-not-loaded",
    ],
    [
      "outside-repo-prefix-retains-source-ancestor-index-ambiguity",
      "ambiguous-target",
    ],
  ] as const) {
    const answer = detailSchema.parse(
      expected[cases.findIndex((item) => item.id === id)].output,
    );
    assert.equal(answer.details.crossEdges[0].reason, reason, id);
  }
  const invalid = [
    "not json",
    JSON.stringify({
      id: "missing-root",
      operation: "code_graph.cross_runtime",
      input: {},
    }),
    JSON.stringify({
      id: "bad-scope",
      operation: "code_graph.cross_runtime",
      input: { root, scope: "invented" },
    }),
    JSON.stringify({
      id: "bad-class",
      operation: "code_graph.cross_runtime",
      input: { root, classes: [7] },
    }),
    JSON.stringify({
      id: "unsupported",
      operation: "invented",
      input: { root },
    }),
    JSON.stringify({
      id: "unknown",
      operation: "code_graph.cross_runtime",
      input: { root, silentlyIgnored: true },
    }),
  ];
  const native = spawnSync(binary, [manifest], {
    input: `${[...cases.map((item) => JSON.stringify(item)), ...invalid].join("\n")}\n`,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(native.status, 0, native.stderr);
  assert.equal(native.stderr, "");
  const actual = native.stdout
    .trim()
    .split("\n")
    .map((line) => responseSchema.parse(JSON.parse(line)));
  assert.equal(actual.length, cases.length + invalid.length);
  for (const [index, answer] of expected.entries()) {
    const returned = actual[index];
    assert.equal(
      returned.ok,
      answer.ok,
      `${cases[index].id}: ${JSON.stringify(returned.error)}`,
    );
    if (answer.ok)
      assert.deepEqual(returned.output, answer.output, cases[index].id);
    else assert.deepEqual(returned.error, answer.error, cases[index].id);
    if (answer.ok)
      assert.ok(
        returned.observedCalls.includes(
          "demlik_code_graph::extract::edges::resolve_edges_with_cross_runtime",
        ),
      );
  }
  for (const answer of actual.slice(cases.length)) {
    assert.equal(answer.ok, false);
    assert.ok(answer.error?.message);
    assert.deepEqual(answer.observedCalls, []);
  }
  const evidence = {
    reference: {
      node: process.version,
      v8: process.versions.v8,
      compiler: "7.0.0-dev.20260707.2",
      protocol: 5,
    },
    passed: cases.length,
    rejectedInvalidInputs: invalid.length,
    functions: expected
      .filter((answer) => answer.ok)
      .reduce(
        (sum, answer) => sum + detailSchema.parse(answer.output).functions,
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
