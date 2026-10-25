import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { loadCheapProject } from "../../packages/code-graph/src/extract/project.js";
import { analyzeLayers } from "../../packages/code-graph/src/layers/analyze.js";
import {
  compileMatchers,
  directionOf,
  LayerTieError,
  layerOf,
} from "../../packages/code-graph/src/layers/classify.js";
import {
  edgeKey,
  reconcile,
} from "../../packages/code-graph/src/layers/reconcile.js";
import {
  AllowedEdgeSchema,
  LayerRulesSchema,
  LayerSchema,
} from "../../packages/code-graph/src/layers/rules.js";

const binary = z.string().min(1).parse(process.argv[2]);
assert.equal(process.version, "v22.21.1");
assert.equal(process.versions.v8, "12.4.254.21-node.33");
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const layer = z
  .object({ name: z.string(), paths: z.array(z.string()) })
  .strict();
const allowed = z
  .object({
    from: z.string(),
    to: z.string(),
    sites: count,
    reason: z.string(),
  })
  .strict();
const rank = z.object({ name: z.string(), rank: count }).strict();
const edge = z
  .object({
    from: z.string(),
    fromLine: count,
    fromLayer: z.string(),
    to: z.string(),
    toLine: count,
    toLayer: z.string(),
    specifier: z.string(),
    typeOnly: z.boolean(),
  })
  .strict();
const census = z
  .object({
    down: count,
    sideways: count,
    up: count,
    unlayered: count,
    external: count,
    unresolved: count,
  })
  .strict();
const report = z
  .object({
    layers: z.array(z.string()),
    filesScanned: count,
    census,
    violations: z.array(edge),
    unresolved: z.array(z.string()),
  })
  .strict();
const scalar = z.union([
  z.number(),
  z.enum(["NaN", "Infinity", "-Infinity", "-0"]),
]);
const jsonValue = z.custom<unknown>(
  (value) => value !== undefined,
  "provide a JSON value",
);
const caseSchema = z.discriminatedUnion("operation", [
  z
    .object({
      id: z.string(),
      operation: z.literal("code_graph.layer_schema"),
      input: z
        .object({
          schema: z.enum(["layer", "allowed", "rules"]),
          value: jsonValue,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      id: z.string(),
      operation: z.literal("code_graph.layer_sites_schema"),
      input: z.object({ sites: scalar }).strict(),
    })
    .strict(),
  z
    .object({
      id: z.string(),
      operation: z.literal("code_graph.layer_classify"),
      input: z
        .object({ layers: z.array(layer), files: z.array(z.string()) })
        .strict(),
    })
    .strict(),
  z
    .object({
      id: z.string(),
      operation: z.literal("code_graph.layer_direction"),
      input: z
        .object({ ranks: z.tuple([rank.nullable(), rank.nullable()]) })
        .strict(),
    })
    .strict(),
  z
    .object({
      id: z.string(),
      operation: z.literal("code_graph.layer_analyze"),
      input: z
        .object({ root: z.string(), repoRoot: z.string(), rules: jsonValue })
        .strict(),
    })
    .strict(),
  z
    .object({
      id: z.string(),
      operation: z.literal("code_graph.layer_reconcile"),
      input: z.object({ report, allowed: z.array(allowed) }).strict(),
    })
    .strict(),
  z
    .object({
      id: z.string(),
      operation: z.literal("code_graph.layer_edge_key"),
      input: z.object({ from: z.string(), to: z.string() }).strict(),
    })
    .strict(),
]);
type Case = z.infer<typeof caseSchema>;
type Edge = z.infer<typeof edge>;
const responseSchema = z
  .object({
    id: z.string().nullable(),
    ok: z.boolean(),
    output: z.unknown().optional(),
    error: z.object({ kind: z.string(), message: z.string() }).optional(),
    observedCalls: z.array(z.string()),
  })
  .strict();
const cases: Case[] = [];
function add(id: string, operation: Case["operation"], input: unknown) {
  cases.push(caseSchema.parse({ id, operation, input }));
}
function parsed(
  schema:
    | typeof LayerSchema
    | typeof AllowedEdgeSchema
    | typeof LayerRulesSchema,
  value: unknown,
) {
  const result = schema.safeParse(value);
  return result.success
    ? { valid: true, data: result.data }
    : { valid: false, issue: result.error.issues[0] };
}
function tie(error: unknown) {
  if (!(error instanceof LayerTieError)) throw error;
  return {
    thrown: {
      name: error.name,
      message: error.message,
      file: error.file,
      patterns: error.patterns,
    },
  };
}
function reference(item: Case): unknown {
  switch (item.operation) {
    case "code_graph.layer_schema":
      return parsed(
        {
          layer: LayerSchema,
          allowed: AllowedEdgeSchema,
          rules: LayerRulesSchema,
        }[item.input.schema],
        item.input.value,
      );
    case "code_graph.layer_sites_schema":
      return parsed(AllowedEdgeSchema, {
        from: "a",
        to: "b",
        reason: "why",
        sites:
          typeof item.input.sites === "string"
            ? Number(item.input.sites)
            : item.input.sites,
      });
    case "code_graph.layer_classify": {
      const matchers = compileMatchers(item.input.layers);
      return item.input.files.map((file) => {
        try {
          return layerOf(file, matchers);
        } catch (error) {
          return tie(error);
        }
      });
    }
    case "code_graph.layer_direction":
      return directionOf(...item.input.ranks);
    case "code_graph.layer_edge_key":
      return edgeKey(item.input);
    case "code_graph.layer_reconcile":
      return reconcile(item.input.report, item.input.allowed);
    case "code_graph.layer_analyze":
      try {
        return analyzeLayers(
          loadCheapProject(item.input.root),
          item.input.repoRoot,
          LayerRulesSchema.parse(item.input.rules),
        );
      } catch (error) {
        return tie(error);
      }
  }
}
function call(item: Case) {
  const child = spawnSync(binary, [], {
    input: `${JSON.stringify(item)}\n`,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stderr, "");
  const answer = responseSchema.parse(JSON.parse(child.stdout));
  assert.equal(answer.id, item.id);
  assert.equal(answer.ok, true, JSON.stringify(answer.error));
  assert.ok(answer.observedCalls.length, item.id);
  return answer;
}
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "demlik-layers-parity-"));
function tree(name: string, files: Record<string, string>) {
  const root = path.join(scratch, name);
  fs.mkdirSync(root, { recursive: true });
  for (const [file, contents] of Object.entries(files)) {
    const absolute = path.join(root, file);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, contents);
  }
  return root;
}
try {
  const values: unknown[] = [
    null,
    true,
    false,
    0,
    1.5,
    "",
    [],
    {},
    { name: "a" },
    { name: "", paths: ["x"] },
    { name: "a", paths: [] },
    { name: "a", paths: [1] },
    { name: "a", paths: [""] },
    { name: "a", paths: ["x"], extra: 1 },
    { name: "\ud800", paths: ["😀", "**"] },
    JSON.parse('{"name":"a","paths":["x"],"__proto__":{},"constructor":null}'),
    JSON.parse('{"name":"a","paths":["x"],"3":0,"1":0,"odd\\"key":0}'),
  ];
  for (const [index, value] of values.entries())
    add(`layer-schema-${index}`, "code_graph.layer_schema", {
      schema: "layer",
      value,
    });
  const goodAllowed = { from: "from", to: "to", sites: 1, reason: "why" };
  const allowedValues: unknown[] = [
    ...values,
    goodAllowed,
    { ...goodAllowed, from: "" },
    { ...goodAllowed, to: [] },
    { ...goodAllowed, sites: "1" },
    { ...goodAllowed, reason: "" },
    { ...goodAllowed, reason: [] },
    { ...goodAllowed, extra: true },
    { from: "a", to: "b", sites: 1 },
  ];
  for (const [index, value] of allowedValues.entries())
    add(`allowed-schema-${index}`, "code_graph.layer_schema", {
      schema: "allowed",
      value,
    });
  const stack = [
    { name: "surface", paths: ["apps/web", "packages/cli"] },
    { name: "service", paths: ["services"] },
    { name: "domain", paths: ["services/*/src/domain", "packages/core"] },
    { name: "contract", paths: ["packages/core-contract"] },
  ];
  const rulesValues: unknown[] = [
    null,
    false,
    1,
    "",
    [],
    {},
    { layers: [] },
    { layers: [{}] },
    { layers: [stack[0]] },
    { layers: stack },
    { layers: stack, allowed: [] },
    { layers: stack, allowed: [goodAllowed] },
    { layers: null },
    { layers: stack, allowed: {} },
    { layers: stack, allowed: [{ ...goodAllowed, sites: 0 }] },
    { layers: stack, extra: true },
    JSON.parse('{"__proto__":{},"constructor":null}'),
  ];
  for (const [index, value] of rulesValues.entries())
    add(`rules-schema-${index}`, "code_graph.layer_schema", {
      schema: "rules",
      value,
    });
  for (const [index, sites] of [
    "NaN",
    "Infinity",
    "-Infinity",
    "-0",
    0,
    -1,
    1.5,
    -1.5,
    1,
    2,
    9007199254740991,
    9007199254740992,
    -9007199254740992,
  ].entries())
    add(`sites-schema-${index}`, "code_graph.layer_sites_schema", { sites });
  const patterns = [
    "",
    "/",
    "**",
    "**/**",
    "apps/**",
    "apps/**/y",
    "pkg/*",
    "*-x.ts",
    "pkg/*-x.ts",
    "**/*-x.ts",
    "a?.ts",
    "[ab].ts",
    "{a,b}.ts",
    "!a.ts",
    "src\\x",
    "**/*\ud800.ts",
    "**/*😀.ts",
    "a//b",
    "a/**//b",
    "a.b",
    "a+$",
    "a(...)",
    "a|b",
    "a\nb",
  ];
  const files = [
    "",
    "/",
    "//",
    "a-x.ts",
    "-x.ts",
    "a/b-x.ts",
    "pkg/a",
    "pkg",
    "pkg/",
    "pkg//x",
    "pkg/a-x.ts",
    "pkg/a/b-x.ts",
    "apps/y",
    "apps/p/q/y",
    "packages/y",
    "a?.ts",
    "ab.ts",
    "[ab].ts",
    "{a,b}.ts",
    "!a.ts",
    "src\\x",
    "a/b/c/d/e-x.ts",
    "src/x\ud800.ts",
    "x😀.ts",
    "src/x😀.ts",
    "a//b",
    "a.b",
    "a+$",
    "a(...)",
    "a|b",
    "a\nb",
  ];
  for (const [index, pattern] of patterns.entries()) {
    add(`pattern-${index}`, "code_graph.layer_classify", {
      layers: [{ name: "only", paths: [pattern] }],
      files,
    });
  }
  add("empty-matchers", "code_graph.layer_classify", { layers: [], files });
  add("specific-stack", "code_graph.layer_classify", {
    layers: stack,
    files: [
      "services/billing/src/domain/a.ts",
      "services/billing/src/http.ts",
      "packages/core-contract/a.ts",
      "packages/core/a.ts",
      "tools/cli/a.ts",
    ],
  });
  for (const [id, layers] of [
    [
      "role-tie",
      [
        { name: "plumbing", paths: ["**/*-plumbing.ts"] },
        { name: "billing", paths: ["**/billing-p*.ts"] },
      ],
    ],
    [
      "same-layer",
      [{ name: "plumbing", paths: ["**/*-plumbing.ts", "**/billing-p*.ts"] }],
    ],
    [
      "deeper-role",
      [
        { name: "web", paths: ["apps/web/**/*-business-rule.ts"] },
        { name: "all", paths: ["**/*-business-rule.ts"] },
      ],
    ],
    [
      "named-file",
      [
        { name: "plumbing", paths: ["**/*-plumbing.ts"] },
        { name: "billing", paths: ["**/billing-plumbing.ts"] },
      ],
    ],
    [
      "literal-chars",
      [
        { name: "plumbing", paths: ["**/*-plumbing.ts"] },
        { name: "billing", paths: ["**/*-billing-plumbing.ts"] },
      ],
    ],
    [
      "astral-specificity",
      [
        { name: "emoji", paths: ["**/*😀.ts"] },
        { name: "ascii", paths: ["**/x*.ts"] },
      ],
    ],
    [
      "lone-specificity",
      [
        { name: "raw", paths: ["**/*\ud800.ts"] },
        { name: "ascii", paths: ["**/x*.ts"] },
      ],
    ],
    [
      "duplicate-pattern",
      [
        { name: "first", paths: ["src/*"] },
        { name: "second", paths: ["src/*"] },
      ],
    ],
  ] as const)
    add(id, "code_graph.layer_classify", {
      layers,
      files: [
        "src/billing-plumbing.ts",
        "services/eu-billing-plumbing.ts",
        "apps/web/src/a-business-rule.ts",
        "services/a-business-rule.ts",
        "x😀.ts",
        "x\ud800.ts",
        "src/a.ts",
      ],
    });
  const ranks = [
    null,
    { name: "a", rank: 0 },
    { name: "b", rank: 1 },
    { name: "c", rank: 3 },
    { name: "", rank: 0 },
  ];
  for (const [i, from] of ranks.entries()) {
    for (const [j, to] of ranks.entries()) {
      add(`direction-${i}-${j}`, "code_graph.layer_direction", {
        ranks: [from, to],
      });
    }
  }
  for (const [index, [from, to]] of [
    ["a b", "c"],
    ["a", "b c"],
    ["", ""],
    ["raw\ud800", "to\udfff"],
    ["a\nb", "c"],
    ["a\tb", "c"],
    ["😀", "é"],
  ].entries())
    add(`pair-${index}`, "code_graph.layer_edge_key", { from, to });
  const makeEdge = (
    from: string,
    to: string,
    line: number,
    typeOnly = false,
  ): Edge => ({
    from,
    to,
    fromLine: line,
    toLine: 1,
    fromLayer: "domain",
    toLayer: "service",
    specifier: "../target",
    typeOnly,
  });
  const makeAllowed = (
    from: string,
    to: string,
    sites: number,
    reason = "why",
  ) => ({ from, to, sites, reason });
  function makeReport(violations: Edge[]) {
    return {
      layers: ["service", "domain"],
      filesScanned: 5,
      census: {
        down: 2,
        sideways: 1,
        up: violations.length,
        unlayered: 0,
        external: 0,
        unresolved: 0,
      },
      violations,
      unresolved: [],
    };
  }
  const measured = [
    makeEdge("a", "target", 3),
    makeEdge("a", "target", 9, true),
    makeEdge("b", "other", 4),
  ];
  for (const [index, allowed] of [
    [],
    [makeAllowed("a", "target", 2), makeAllowed("b", "other", 1)],
    [makeAllowed("a", "target", 1)],
    [makeAllowed("a", "target", 3)],
    [makeAllowed("closed", "target", 1)],
    [
      makeAllowed("a", "target", 1, "first"),
      makeAllowed("a", "target", 2, "last"),
      makeAllowed("b", "other", 1),
    ],
    [
      makeAllowed("a", "target", 2, "first"),
      makeAllowed("a", "target", 1, "last"),
    ],
    [
      makeAllowed("closed", "target", 1, "first"),
      makeAllowed("closed", "target", 2, "last"),
    ],
    [makeAllowed("a", "target", 0, "")],
  ].entries())
    add(`reconcile-${index}`, "code_graph.layer_reconcile", {
      report: makeReport(measured),
      allowed,
    });
  add("closed-edges", "code_graph.layer_reconcile", {
    report: makeReport([]),
    allowed: [makeAllowed("a", "target", 1)],
  });
  add("pair-space-collision", "code_graph.layer_reconcile", {
    report: makeReport([makeEdge("a b", "c", 3), makeEdge("a", "b c", 4)]),
    allowed: [makeAllowed("a", "b c", 2)],
  });
  add("locale-and-stable-ties", "code_graph.layer_reconcile", {
    report: makeReport([
      makeEdge("z", "to", 2),
      makeEdge("á", "to", 3),
      makeEdge("Alpha", "z", 1),
      makeEdge("Alpha", "a", 1),
      makeEdge("raw\ud800", "x", 4),
    ]),
    allowed: [makeAllowed("😀", "stale", 1), makeAllowed("á", "stale", 2)],
  });
  const appSources = {
    "apps/web/src/ui/page.tsx":
      "import { invoice } from '@app/features/billing/invoice';\nimport { total } from '@app/features/billing/total.js';\nexport const page=invoice+total;",
    "apps/web/src/features/billing/invoice.ts":
      "import { money } from '@app/lib/money';\nimport type { Page } from '@app/ui/page';\nimport { gone } from '@app/features/billing/gone';\nexport const invoice=money+gone;",
    "apps/web/src/features/billing/total.ts":
      "// first\nimport { page } from '@app/ui/page';\nimport { money } from '../../lib/money';\nexport const total=page+money;",
    "apps/web/src/lib/money.ts":
      "import fs from 'node:fs';\nimport pad from 'left-pad';\nimport missing from 'not-installed';\nimport { env } from 'cloudflare:workers';\nexport const money=fs+pad+missing+env;",
    "node_modules/left-pad/package.json":
      '{"name":"left-pad","main":"index.js"}',
    "node_modules/left-pad/index.js": "module.exports=1;",
  };
  const appRules = {
    layers: [
      { name: "ui", paths: ["apps/web/src/ui"] },
      { name: "features", paths: ["apps/web/src/features"] },
      { name: "lib", paths: ["apps/web/src/lib"] },
    ],
  };
  for (const [name, extra] of [
    [
      "own",
      {
        "apps/web/tsconfig.json":
          '{"compilerOptions":{"paths":{"@app/*":["./src/*"]}}}',
      },
    ],
    [
      "inherited",
      {
        "apps/web/tsconfig.json": '{"extends":"../../base.json"}',
        "base.json":
          '{\n// shared aliases\n"compilerOptions":{"paths":{"@app/*":["./apps/web/src/*"]}},\n}',
      },
    ],
    ["no-alias", {}],
  ] as const) {
    const root = tree(name, { ...appSources, ...extra });
    add(`analyze-${name}`, "code_graph.layer_analyze", {
      root,
      repoRoot: root,
      rules: appRules,
    });
  }
  const packages = tree("packages", {
    "apps/ui/package.json": '{"name":"ui","exports":"./src/page.tsx"}',
    "apps/ui/src/page.tsx":
      "import { core } from 'core/private';\nimport missing from 'empty/gone';\nexport const page=core+missing;",
    "packages/core/package.json": '{"name":"core","main":"dist/index.js"}',
    "packages/core/src/index.ts":
      "import type { Page } from 'ui';\nexport const core=1;",
    "packages/empty/package.json": '{"name":"empty"}',
    "tools/free.ts":
      "import { core } from 'core';\nimport missing from './missing';\nexport const free=core+missing;",
  });
  add("analyze-packages", "code_graph.layer_analyze", {
    root: packages,
    repoRoot: packages,
    rules: {
      layers: [
        { name: "surface", paths: ["apps/ui"] },
        { name: "domain", paths: ["packages/core", "packages/empty"] },
      ],
    },
  });
  const tieRoot = tree("tie", {
    "src/billing-plumbing.ts": "export const b=1;",
  });
  add("analyze-tie-with-no-imports", "code_graph.layer_analyze", {
    root: tieRoot,
    repoRoot: tieRoot,
    rules: {
      layers: [
        { name: "plumbing", paths: ["**/*-plumbing.ts"] },
        { name: "billing", paths: ["**/billing-p*.ts"] },
      ],
    },
  });
  const empty = tree("empty", { "invalid.ts": "export const broken = ;" });
  add("analyze-empty-default-stack", "code_graph.layer_analyze", {
    root: empty,
    repoRoot: empty,
    rules: {},
  });
  const unicode = tree("unicode", {
    "src/top/�.ts": "export type High=unknown;",
    "src/low/😀.ts": [
      "const emoji='😀';",
      String.raw`import type { High } from '../top/\ud800';`,
      String.raw`type Imported=typeof import('../top/\ud800');`,
      "export const low=1;",
    ].join("\n"),
  });
  add("analyze-utf16-and-typeof-import", "code_graph.layer_analyze", {
    root: unicode,
    repoRoot: unicode,
    rules: {
      layers: [
        { name: "top\udfff", paths: ["src/top"] },
        { name: "low", paths: ["src/low"] },
      ],
    },
  });
  const repo = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../..",
  );
  add("analyze-real-source-tree", "code_graph.layer_analyze", {
    root: path.join(repo, "packages/code-graph/src"),
    repoRoot: repo,
    rules: {
      layers: [
        { name: "layers", paths: ["packages/code-graph/src/layers"] },
        { name: "extract", paths: ["packages/code-graph/src/extract"] },
        { name: "syntax", paths: ["packages/code-graph/src/syntax"] },
        { name: "engine", paths: ["packages/code-graph/src/engine"] },
      ],
    },
  });
  const answers: z.infer<typeof responseSchema>[] = [];
  let failures = 0;
  for (const item of cases) {
    const source = reference(item);
    const answer = call(item);
    try {
      assert.deepEqual(answer.output, source, item.id);
    } catch (error) {
      failures++;
      console.error(`${item.id}: ${String(error)}`);
    }
    answers.push(answer);
  }
  const byId = (id: string) =>
    answers[cases.findIndex((item) => item.id === id)];
  assert.equal(report.parse(byId("analyze-own").output).census.up, 2);
  assert.equal(report.parse(byId("analyze-own").output).census.down, 4);
  assert.equal(report.parse(byId("analyze-own").output).census.external, 4);
  assert.equal(
    report.parse(byId("analyze-utf16-and-typeof-import").output).violations[0]
      .to,
    "src/top/\ud800.ts",
  );
  assert.equal(
    report.parse(byId("analyze-utf16-and-typeof-import").output).census.up,
    2,
  );
  assert.ok(
    report.parse(byId("analyze-real-source-tree").output).filesScanned > 40,
  );
  const invalid = [
    "not json",
    JSON.stringify({ id: "unsupported", operation: "ignored", input: {} }),
    JSON.stringify({
      id: "missing-value",
      operation: "code_graph.layer_schema",
      input: { schema: "layer" },
    }),
    JSON.stringify({
      id: "unknown-schema",
      operation: "code_graph.layer_schema",
      input: { schema: "unknown", value: {} },
    }),
    JSON.stringify({
      id: "wrong-layer",
      operation: "code_graph.layer_classify",
      input: { layers: [{ name: 1, paths: [] }], files: [] },
    }),
    JSON.stringify({
      id: "ignored-nested",
      operation: "code_graph.layer_classify",
      input: { layers: [{ name: "a", paths: [], ignored: true }], files: [] },
    }),
    JSON.stringify({
      id: "wrong-direction",
      operation: "code_graph.layer_direction",
      input: { ranks: [null] },
    }),
    JSON.stringify({
      id: "missing-rules",
      operation: "code_graph.layer_analyze",
      input: { root: scratch, repoRoot: scratch },
    }),
    JSON.stringify({
      id: "wrong-edge",
      operation: "code_graph.layer_reconcile",
      input: {
        report: {
          ...makeReport([]),
          violations: [{ ...makeEdge("a", "b", 1), typeOnly: "yes" }],
        },
        allowed: [],
      },
    }),
    JSON.stringify({
      id: "ignored-key",
      operation: "code_graph.layer_edge_key",
      input: { from: "a", to: "b", ignored: true },
    }),
    JSON.stringify({
      id: "unknown-number",
      operation: "code_graph.layer_sites_schema",
      input: { sites: "infinite" },
    }),
  ];
  const bad = spawnSync(binary, [], {
    input: `${invalid.join("\n")}\n`,
    encoding: "utf8",
  });
  assert.equal(bad.status, 0, bad.stderr);
  assert.equal(bad.stderr, "");
  const rejected = bad.stdout
    .trim()
    .split("\n")
    .map((line) => responseSchema.parse(JSON.parse(line)));
  assert.equal(rejected.length, invalid.length);
  for (const answer of rejected) {
    assert.equal(answer.ok, false);
    assert.equal(answer.error?.kind, "driver-error");
    assert.ok(answer.error.message);
    assert.deepEqual(answer.observedCalls, []);
  }
  const evidence = {
    passed: cases.length - failures,
    failures,
    rejectedInvalidInputs: invalid.length,
    reference: {
      node: process.version,
      v8: process.versions.v8,
      parser: "OXC 0.151.0",
      resolver: "OXC 11.24.2",
      profile:
        "canonical first Zod issue; actual public pure functions and shared physical projects; valid typed report/count inputs",
    },
    classifications: cases.reduce(
      (sum, item) =>
        sum +
        (item.operation === "code_graph.layer_classify"
          ? item.input.files.length
          : 0),
      0,
    ),
    analyzedFilesAcrossCases: answers.reduce((sum, answer) => {
      const parsed = report.safeParse(answer.output);
      return sum + (parsed.success ? parsed.data.filesScanned : 0);
    }, 0),
    nativeApis: [
      ...new Set(answers.flatMap((answer) => answer.observedCalls)),
    ].sort(),
    cases: [...answers, ...rejected],
  };
  if (process.argv[3])
    fs.writeFileSync(process.argv[3], `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify({ ...evidence, cases: undefined }, null, 2));
  assert.equal(failures, 0, "source/native layers mismatches");
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
