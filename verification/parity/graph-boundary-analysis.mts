import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import {
  analyzeBoundaries,
  type BoundaryModule,
} from "../../packages/code-graph/src/boundaries/analyze.js";
import { readDeployables } from "../../packages/code-graph/src/boundaries/deployables/deployables.js";
import { readLibraries } from "../../packages/code-graph/src/boundaries/libraries/libraries.js";
import { BoundaryRulesSchema } from "../../packages/code-graph/src/boundaries/rules.js";
import { readShape } from "../../packages/code-graph/src/boundaries/shape/shape.js";
import { loadBindingCatalog } from "../../packages/code-graph/src/extract/wrangler-config.js";

const binary = process.argv[2];
assert.ok(binary, "provide the compiled boundary analyzer driver");
assert.equal(process.version, "v22.21.1");
assert.equal(process.versions.v8, "12.4.254.21-node.33");
const text = z.string(),
  texts = z.array(text);
const site = z
  .object({
    binding: text,
    line: z.custom<number>((value) => typeof value === "number"),
  })
  .strict();
const edge = z
  .object({
    specifier: text,
    kind: z.enum(["static", "export-from", "dynamic"]),
    typeOnly: z.boolean(),
    target: text.nullable(),
  })
  .strict();
const moduleSchema = z
  .object({
    file: text,
    importEdges: z.array(edge),
    offendingForm: text.nullable(),
    firstWrite: site.nullable(),
    importedNames: z.record(
      text,
      z.object({ names: texts, unreadable: z.boolean() }).strict(),
    ),
    impureUses: z.array(z.object({ name: text, path: texts }).strict()),
    runtimeSpecifiers: texts,
    bindingSites: z.array(site),
  })
  .strict();
const inputSchema = z
  .object({
    repoRoot: text,
    scope: text,
    rules: z.unknown(),
    modules: z.array(moduleSchema),
  })
  .strict();
type Module = z.infer<typeof moduleSchema>;
type Input = z.infer<typeof inputSchema>;
type Case = { id: string; input: Input; rawLine?: string };
const directory = fs.mkdtempSync(
  path.join(tmpdir(), "demlik-boundary-analysis-"),
);
try {
  const root = path.join(directory, "repo");
  function put(file: string, content: string, base = root) {
    const absolute = path.join(base, file);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content);
  }
  put("package.json", "{}");
  put(
    "wrangler.jsonc",
    '{"name":"root","main":"src/main.ts","d1_databases":[{"binding":"DB"}]}',
  );
  put(
    "services/api/wrangler.jsonc",
    '{"name":"api","main":"src/main.ts","d1_databases":[{"binding":"DB"}]}',
  );
  put("services/api/package.json", '{"name":"@shop/api"}');
  for (const [dir, name] of [
    ["packages/kernel", "@shop/kernel"],
    ["packages/world", "@shop/world"],
    ["services/api/packages/inner", "@shop/inner"],
  ]) {
    put(`${dir}/package.json`, JSON.stringify({ name }));
    put(`${dir}/src/index.ts`, "export const decide=1;");
  }
  const bad = path.join(directory, "bad");
  put("a/wrangler.jsonc", "{", bad);
  function module(
    file: string,
    edges: Module["importEdges"] = [],
    extra: Partial<Module> = {},
  ): Module {
    return moduleSchema.parse({
      file,
      importEdges: edges,
      offendingForm: null,
      firstWrite: null,
      importedNames: {},
      impureUses: [],
      runtimeSpecifiers: edges
        .filter((e) => !e.typeOnly)
        .map((e) => e.specifier),
      bindingSites: [],
      ...extra,
    });
  }
  function importEdge(
    target: string | null,
    specifier = "./target",
    typeOnly = false,
  ): Module["importEdges"][number] {
    return { target, specifier, typeOnly, kind: "static" };
  }
  const scope = "services/api";
  const baseRules = {
    features: { [scope]: ["orders", "billing"] },
    lib: ["lib"],
  };
  const allCases: Case[] = [];
  function add(
    id: string,
    modules: Module[],
    rules: unknown = baseRules,
    ownScope = scope,
    repoRoot = root,
    rawLine?: string,
  ) {
    allCases.push({
      id,
      input: inputSchema.parse({ repoRoot, scope: ownScope, rules, modules }),
      rawLine,
    });
  }
  const zones = [
    "index.ts",
    "ports.ts",
    "application/run.ts",
    "adapters/driving/http.ts",
    "adapters/driven/store.ts",
    "mystery/one.ts",
    "adapters/other/one.ts",
  ];
  const fromFiles = [
    ...zones.map((file) => `src/orders/${file}`),
    "src/lib/value.ts",
    "src/outside.ts",
  ];
  const targets = [
    ...["orders", "billing"].flatMap((feature) =>
      zones.map((file) => `src/${feature}/${file}`),
    ),
    "src/lib/value.ts",
    "src/outside.ts",
  ];
  for (const [i, from] of fromFiles.entries())
    for (const [j, target] of targets.entries())
      for (const typeOnly of [false, true]) {
        add(`zones-${i}-${j}-${typeOnly}`, [
          module(from, [importEdge(target, "./edge", typeOnly)]),
          module(target),
        ]);
      }
  add("empty", []);
  add(
    "unresolved-and-bare",
    [
      module("src/orders/application/run.ts", [
        importEdge(null, "./missing"),
        importEdge(null, "third-party"),
      ]),
    ],
    {
      ...baseRules,
      applicationShape: ["application-import-outside-allowlist"],
    },
  );
  add(
    "all-edge-kinds",
    [
      module(
        "src/orders/application/run.ts",
        ["static", "export-from", "dynamic"].map((kind, index) => ({
          ...importEdge(
            "src/orders/adapters/driven/store.ts",
            `./edge-${index}`,
            index === 1,
          ),
          kind: kind as "static" | "export-from" | "dynamic",
        })),
      ),
    ],
    baseRules,
  );
  add("unknown-entry-once", [
    module("src/orders/mystery/one.ts"),
    module("src/orders/mystery/two.ts"),
    module("src/orders/mystery/one.ts"),
  ]);
  add(
    "unknown-only-tests",
    [
      module("src/orders/spec/one.test.ts"),
      module("src/orders/spec/two.test.ts"),
    ],
    { ...baseRules, testFiles: ["**/*.test.ts"] },
  );
  add(
    "mixed-unknown-tests",
    [
      module("src/orders/spec/one.test.ts"),
      module("src/orders/spec/helper.ts"),
    ],
    { ...baseRules, testFiles: ["**/*.test.ts"] },
  );
  const writer = "src/orders/adapters/driven/write.ts",
    reader = "src/orders/adapters/driven/read.ts",
    driving = "src/orders/adapters/driving/http.ts";
  const readModules = [
    module(driving, [
      importEdge(writer, "./write"),
      importEdge(writer, "./write.js"),
      importEdge(reader, "./read"),
    ]),
    module(writer, [], { firstWrite: { binding: "DB", line: 3 } }),
    module(reader),
  ];
  add("one-write-shared-by-two-crossings", readModules, {
    ...baseRules,
    readAllowance: { [scope]: { driven: [writer, reader] } },
  });
  add(
    "writes-last-file-row-owns-fact",
    [
      ...readModules,
      module(writer, [], { firstWrite: { binding: "LAST", line: 8 } }),
    ],
    { ...baseRules, readAllowance: { [scope]: { driven: [writer, reader] } } },
  );
  const libraryRules = {
    libraryTypes: {
      kernel: { imports: [], pure: true },
      world: { imports: [], pure: false, importedFrom: ["driven"] },
    },
    libraries: {
      "packages/kernel": "kernel",
      "packages/world": "world",
      "services/api/packages/inner": "kernel",
    },
  };
  for (const runtime of [true, false]) {
    const imports = [
      importEdge(reader, "./read"),
      importEdge(null, "@shop/kernel"),
    ];
    add(
      `decision-runtime-${runtime}`,
      [
        module(driving, imports, {
          runtimeSpecifiers: runtime ? ["./read", "@shop/kernel"] : ["./read"],
        }),
        module(reader),
      ],
      {
        ...baseRules,
        ...libraryRules,
        readAllowance: { [scope]: { driven: [reader], decidedBy: ["kernel"] } },
      },
    );
  }
  const allRules = {
    ...baseRules,
    ...libraryRules,
    applicationShape: [
      "index-not-exports-only",
      "application-import-outside-allowlist",
    ],
    acrossDeployables: [
      "binding-outside-driven-adapter",
      "relative-import-crosses-workspace",
    ],
    testFiles: ["**/*.test.ts"],
    compositionRoots: ["src/main.ts"],
  };
  for (const isTest of [false, true]) {
    const suffix = isTest ? ".test.ts" : ".ts";
    add(
      `test-role-${isTest}`,
      [
        module(
          `src/orders/application/run${suffix}`,
          [
            importEdge("src/orders/adapters/driven/store.ts", "./store"),
            importEdge("src/billing/application/run.ts", "../billing"),
            importEdge(null, "third-party"),
          ],
          {
            impureUses: [{ name: "fetch", path: ["fetch"] }],
            bindingSites: [{ binding: "DB", line: 7 }],
          },
        ),
        module(`src/orders/index${isTest ? ".test" : ""}.ts`, [], {
          offendingForm: "VariableDeclaration",
        }),
      ],
      allRules,
    );
  }
  add(
    "transitive-runtime-test-root",
    [
      module("src/root.test.ts", [importEdge("src/harness.ts", "./harness")]),
      module("src/harness.ts", [importEdge("src/main.ts", "./main")]),
      module("src/main.ts"),
    ],
    {
      ...baseRules,
      testFiles: ["**/*.test.ts"],
      compositionRoots: ["src/main.ts"],
    },
  );
  add(
    "root-is-itself-a-test",
    [module("src/main.test.ts", [importEdge("src/main.test.ts", "./self")])],
    {
      ...baseRules,
      testFiles: ["**/*.test.ts"],
      compositionRoots: ["src/main.test.ts"],
    },
  );
  add(
    "inline-type-specifier-opens-no-root",
    [
      module("src/root.test.ts", [importEdge("src/main.ts", "./main")], {
        runtimeSpecifiers: [],
      }),
      module("src/main.ts"),
    ],
    {
      ...baseRules,
      testFiles: ["**/*.test.ts"],
      compositionRoots: ["src/main.ts"],
    },
  );
  add(
    "declared-binding-owner-refuses",
    [
      module("src/orders/adapters/driven/store.ts", [], {
        bindingSites: [
          { binding: "DB", line: 3 },
          { binding: "DB", line: 9 },
        ],
      }),
    ],
    {
      ...baseRules,
      acrossDeployables: ["binding-outside-driven-adapter"],
      bindingOwners: { [scope]: { DB: ["src/other.ts"] } },
    },
  );
  add(
    "worker-main-exempts-bindings",
    [module("src/main.ts", [], { bindingSites: [{ binding: "DB", line: 1 }] })],
    { ...baseRules, acrossDeployables: ["binding-outside-driven-adapter"] },
  );
  add(
    "nested-library-is-judged-in-its-own-scope",
    [
      module("packages/inner/src/index.ts", [importEdge(null, "@shop/world")], {
        bindingSites: [{ binding: "DB", line: 1 }],
      }),
    ],
    {
      ...baseRules,
      ...libraryRules,
      acrossDeployables: ["binding-outside-driven-adapter"],
    },
  );
  add(
    "nested-library-own-scope",
    [
      module(
        "src/index.ts",
        [importEdge(null, "@shop/world"), importEdge(null, "@missing/pkg")],
        { offendingForm: "statement" },
      ),
    ],
    { ...libraryRules, applicationShape: ["index-not-exports-only"] },
    "services/api/packages/inner",
  );
  add(
    "library-root-undeclared-packages",
    [],
    { ...libraryRules, libraryRoots: ["packages"] },
    "packages",
  );
  add(
    "all-library-purity-kinds",
    [
      module(
        "src/index.ts",
        [
          importEdge(null, "@shop/world"),
          importEdge(null, "@missing/a"),
          importEdge(null, "@missing/a/sub"),
        ],
        {
          impureUses: [{ name: "fetch", path: ["fetch"] }],
          offendingForm: "statement",
        },
      ),
    ],
    {
      ...libraryRules,
      applicationShape: ["index-not-exports-only"],
      worldLibraries: ["@shop/world"],
    },
    "packages/kernel",
  );
  add("features-locale-order", [], {
    features: { [scope]: ["z", "Z", "é", "e", "a\ud800", "10", "2"] },
  });
  add(
    "scope-dot",
    [
      module("src/orders/application/run.ts", [
        importEdge("src/orders/adapters/driven/store.ts"),
      ]),
    ],
    { features: { ".": ["orders"] } },
    ".",
  );
  add(
    "opaque-form-label",
    [module("src/orders/index.ts", [], { offendingForm: "form\ud800" })],
    { ...baseRules, applicationShape: ["index-not-exports-only"] },
  );
  add(
    "opaque-specifier-and-file",
    [
      module("src/orders/application/a\ud800.ts", [
        importEdge("src/orders/adapters/driven/store.ts", "specifier\ud800"),
      ]),
    ],
    baseRules,
  );
  add("stable-report-ties", [
    module("src/orders/application/run.ts", [
      importEdge("src/orders/adapters/driven/z.ts", "same"),
      importEdge("src/orders/adapters/driven/a.ts", "same"),
    ]),
  ]);
  for (const name of [
    "toString",
    "valueOf",
    "hasOwnProperty",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toLocaleString",
    "constructor",
    "__proto__",
  ]) {
    add(`inherited-scope-${name}`, [], {}, name);
    for (const binding of [
      "bind",
      "apply",
      "call",
      "length",
      "name",
      "caller",
      "arguments",
      "callee",
      "prototype",
      "toString",
      "__proto__",
      "DB",
    ]) {
      add(
        `inherited-owner-${name}-${binding}`,
        [
          module("src/orders/adapters/driven/store.ts", [], {
            bindingSites: [{ binding, line: 1 }],
          }),
        ],
        {
          features: { [name]: ["orders"] },
          acrossDeployables: ["binding-outside-driven-adapter"],
        },
        name,
      );
    }
  }
  for (const [id, line, rawLine] of [
    ["negative-zero", -0, "-0"],
    ["infinite", Infinity, "1e999"],
  ] as const) {
    add(
      `write-number-${id}`,
      [
        module(driving, [importEdge(writer, "./write")]),
        module(writer, [], { firstWrite: { binding: "DB", line } }),
      ],
      { ...baseRules, readAllowance: { [scope]: { driven: [writer] } } },
      scope,
      root,
      rawLine,
    );
  }
  add(
    "bad-config-shape-refusal",
    [],
    { readAllowance: { [scope]: { driven: [reader] } } },
    scope,
    bad,
  );
  add(
    "bad-config-deployable-refusal",
    [],
    { acrossDeployables: ["binding-outside-driven-adapter"] },
    scope,
    bad,
  );
  assert.equal(
    new Set(allCases.map((item) => item.id)).size,
    allCases.length,
    "unique case IDs",
  );
  function reference(input: Input): unknown {
    const rules = BoundaryRulesSchema.parse(input.rules),
      catalog = loadBindingCatalog(input.repoRoot);
    const libraries = readLibraries(rules, input.repoRoot, undefined);
    if (libraries.kind === "refused")
      return {
        kind: "refused",
        phase: "libraries",
        message: libraries.message,
      };
    const deployables = readDeployables(
      rules,
      input.repoRoot,
      undefined,
      catalog,
    );
    if (deployables.kind === "refused")
      return {
        kind: "refused",
        phase: "deployables",
        message: deployables.message,
      };
    const shape = readShape(rules, catalog);
    if (shape.kind === "refused")
      return { kind: "refused", phase: "shape", message: shape.message };
    const modules: BoundaryModule[] = input.modules.map((module) => ({
      ...module,
      importedNames: new Map(
        Object.entries(module.importedNames).map(([key, value]) => [
          key,
          { names: new Set(value.names), unreadable: value.unreadable },
        ]),
      ),
      runtimeSpecifiers: new Set(module.runtimeSpecifiers),
    }));
    try {
      const analysis = analyzeBoundaries(input.scope, modules, rules, {
        libraries: libraries.libraries,
        deployables: deployables.deployables,
        shape: shape.shape,
      });
      const writes = new Map<object, number>();
      const writeSharing = analysis.report.violations.flatMap((violation) => {
        if (violation.kind !== "driving-reaches-driven") return [];
        if (violation.write === undefined) return [null];
        let id = writes.get(violation.write);
        if (id === undefined) {
          id = writes.size;
          writes.set(violation.write, id);
        }
        return [id];
      });
      return { kind: "analyzed", analysis, writeSharing };
    } catch (error) {
      assert.ok(error instanceof Error);
      return { kind: "thrown", name: error.name, message: error.message };
    }
  }
  const parsedCases = allCases.map((item) => ({
    item,
    parsed: BoundaryRulesSchema.safeParse(item.input.rules),
  }));
  const cases = parsedCases.flatMap(({ item, parsed }) =>
    parsed.success ? [item] : [],
  );
  const invalidConfigurations = parsedCases.flatMap(({ item, parsed }) =>
    parsed.success ? [] : [{ ...item, issues: parsed.error.issues }],
  );
  const expected = cases.map((item) =>
    JSON.parse(JSON.stringify(reference(item.input))),
  );
  const invalid = [
    ...invalidConfigurations.map(({ id, input }) => ({
      id,
      operation: "code_graph.boundary-analysis",
      input,
    })),
    {
      id: "missing-modules",
      operation: "code_graph.boundary-analysis",
      input: { repoRoot: root, scope, rules: {} },
    },
    {
      id: "unknown-field",
      operation: "code_graph.boundary-analysis",
      input: { ...cases[0].input, extra: true },
    },
    {
      id: "wrong-scope",
      operation: "code_graph.boundary-analysis",
      input: { ...cases[0].input, scope: 1 },
    },
    { id: "unknown-operation", operation: "unknown", input: cases[0].input },
  ];
  const lines = cases.map((item) => {
    const text = JSON.stringify({
      id: item.id,
      operation: "code_graph.boundary-analysis",
      input: item.input,
    });
    return item.rawLine === undefined
      ? text
      : text.replace(/"line":(?:0|null)/g, `"line":${item.rawLine}`);
  });
  const child = spawnSync(binary, [], {
    encoding: "utf8",
    input: `${[...lines, ...invalid.map((item) => JSON.stringify(item))].join("\n")}\n`,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (child.error) throw child.error;
  assert.equal(child.status, 0, child.stderr);
  const response = z.object({
    id: text.nullable(),
    ok: z.boolean(),
    output: z.unknown().optional(),
    error: z.string().optional(),
    observedCalls: texts,
  });
  const answers = child.stdout
    .trim()
    .split("\n")
    .map((line) => response.parse(JSON.parse(line)));
  assert.equal(answers.length, cases.length + invalid.length);
  const failures: {
    id: string;
    reference: { ok: true; output: unknown };
    native: z.infer<typeof response>;
    message: string;
  }[] = [];
  for (const [index, item] of cases.entries()) {
    assert.equal(answers[index].id, item.id);
    assert.equal(
      answers[index].ok,
      true,
      `${item.id}: ${answers[index].error}`,
    );
    try {
      assert.deepEqual(answers[index].output, expected[index]);
    } catch (error) {
      failures.push({
        id: item.id,
        reference: { ok: true, output: expected[index] },
        native: answers[index],
        message: String(error),
      });
    }
  }
  for (const answer of answers.slice(cases.length)) {
    assert.equal(answer.ok, false);
    assert.ok(answer.error);
  }
  const report = {
    reference: { node: process.version, v8: process.versions.v8 },
    passed: cases.length - failures.length,
    attempted: cases.length,
    failures,
    rejectedInvalidInputs: invalid.length,
    rejectedConfigurations: invalidConfigurations.map(({ id, issues }) => ({
      id,
      issues,
    })),
    nativeApis: [...new Set(answers.flatMap((answer) => answer.observedCalls))],
    cases: answers,
  };
  if (process.argv[3])
    fs.writeFileSync(process.argv[3], `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    JSON.stringify({
      ...report,
      cases: undefined,
      failures: failures.map((item) => ({
        id: item.id,
        message: item.message,
      })),
    }),
  );
  if (failures.length) process.exitCode = 1;
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
