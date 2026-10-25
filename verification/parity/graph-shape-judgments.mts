import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type ShapeJudgmentInput,
  shapeJudgmentReference,
  shapeJudgmentSchema,
} from "./shape-judgment-reference.mjs";

const binary = process.argv[2];
assert.ok(binary, "provide the compiled shape judgment driver");
assert.equal(process.version, "v22.21.1");
assert.equal(process.versions.v8, "12.4.254.21-node.33");
type Case = {
  id: string;
  operation: "code_graph.shape-judgment";
  input: ShapeJudgmentInput;
};
const directory = fs.mkdtempSync(
  path.join(tmpdir(), "demlik-shape-judgments-"),
);
try {
  const repoRoot = path.join(directory, "repo"),
    scope = "services/api",
    file = "src/orders/application/use.ts";
  function put(file: string, source: string, root = repoRoot) {
    const absolute = path.join(root, file);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, source);
  }
  put(
    "tsconfig.json",
    JSON.stringify({
      compilerOptions: {
        module: "ESNext",
        moduleResolution: "Bundler",
        baseUrl: ".",
        paths: { "~generated/*": ["services/api/src/generated/*"] },
      },
    }),
  );
  put("package.json", '{"private":true}');
  put("pnpm-workspace.yaml", "packages:\n - packages/*\n - services/*\n");
  const libraryTypes = {
    core: { imports: [], pure: true },
    contract: { imports: [], pure: true },
    util: { imports: [], pure: true },
    ui: { imports: [], pure: true },
    adapter: { imports: [], pure: false, importedFrom: ["driven"] },
    configurator: { imports: [], pure: false, importedFrom: ["configurator"] },
    any: { imports: [], pure: false, importedFrom: ["any"] },
  };
  const libraries = Object.fromEntries(
    Object.keys(libraryTypes).map((kind) => [`packages/${kind}`, kind]),
  );
  for (const kind of [...Object.keys(libraryTypes), "stray"]) {
    put(
      `packages/${kind}/package.json`,
      JSON.stringify({ name: `@shop/${kind}` }),
    );
    put(`packages/${kind}/src/index.ts`, "export const value=1;");
  }
  const rules = {
    features: {
      [scope]: [
        "orders",
        "billing",
        ...Array.from({ length: 8 }, (_, n) => `entry${n}`),
      ],
      "services/port": ["application", "driving-adapters", "driven-adapters"],
      "packages/core": ["orders"],
    },
    libraryTypes,
    libraries,
    applicationShape: [
      "index-not-exports-only",
      "application-import-outside-allowlist",
    ],
    applicationMayImport: ["core", "contract", "util"],
    pureDependencies: ["zod", "@pure/*"],
  };
  const targets = {
    "src/orders/ports.ts": "export type Port=unknown;",
    "src/orders/index.ts": "export { value } from './application/helpers';",
    "src/orders/application/helpers.ts": "export const value=1;",
    "src/orders/helpers.ts": "export const value=1;",
    "src/orders/adapters/driven/db.ts": "export const value=1;",
    "src/orders/adapters/driving/http.ts": "export const value=1;",
    "src/billing/index.ts": "export const value=1;",
    "src/billing/application/charge.ts": "export const value=1;",
    "src/lib/format.ts": "export const value=1;",
    "src/generated/client.ts": "export const value=1;",
    "src/index.ts": "export const value=1;",
  };
  for (const [name, source] of Object.entries(targets))
    put(`${scope}/${name}`, source);
  const base: ShapeJudgmentInput = {
    repoRoot,
    rules,
    scope,
    file,
    facts: {
      kind: "opaque",
      edges: [],
      runtimeSpecifiers: [],
      offendingForm: null,
    },
    action: { kind: "judge", placeFile: file },
    judged: [],
  };
  const cases: Case[] = [];
  function add(id: string, input: ShapeJudgmentInput) {
    shapeJudgmentSchema.parse(input);
    cases.push({ id, operation: "code_graph.shape-judgment", input });
  }
  let next = 0;
  function disk(id: string, source: string, ownRules: unknown = rules) {
    const file = `src/orders/application/case${next++}.ts`;
    put(`${scope}/${file}`, source);
    add(id, {
      ...base,
      rules: ownRules,
      file,
      facts: { kind: "disk" },
      action: { kind: "judge", placeFile: file },
    });
  }
  const sourceCases = [
    ["own-ports", 'import type {Port} from "../ports"; export type P=Port;'],
    ["own-application", 'import {value} from "./helpers"; export {value};'],
    [
      "other-feature-index",
      'import {value} from "../../billing/index"; export {value};',
    ],
    [
      "other-feature-internal",
      'import {value} from "../../billing/application/charge"; export {value};',
    ],
    ["lib-folder", 'import {value} from "../../lib/format"; export {value};'],
    ["listed-library", 'import {value} from "@shop/core"; export {value};'],
    [
      "listed-library-subpath",
      'import {value} from "@shop/core/money"; export {value};',
    ],
    ["pure-package", 'import {z} from "zod"; export {z};'],
    ["pure-subpath", 'import {z} from "zod/v4"; export {z};'],
    ["pure-scoped-package", 'import {x} from "@pure/codec/extra"; export {x};'],
    ["orm", 'import {drizzle} from "drizzle-orm"; export {drizzle};'],
    ["framework", 'import {Hono} from "hono"; export {Hono};'],
    ["sdk", 'import * as SDK from "@sentry/node"; export {SDK};'],
    [
      "generated",
      'import {value} from "../../generated/client"; export {value};',
    ],
    ["unlisted-library", 'import {value} from "@shop/ui"; export {value};'],
    [
      "undeclared-package",
      'import {value} from "@shop/stray"; export {value};',
    ],
    [
      "own-index",
      'import type {value} from "../index"; export type P=typeof value;',
    ],
    ["own-unknown-zone", 'import {value} from "../helpers"; export {value};'],
    ["missing-path", 'import {x} from "./missing"; export {x};'],
    [
      "technology-type",
      'import type {D1Database} from "@cloudflare/workers-types"; export type D=D1Database;',
    ],
    ["node-path", 'import {join} from "node:path"; export {join};'],
    ["runtime-impure", 'import {readFile} from "node:fs"; export {readFile};'],
    [
      "type-only-impure",
      'import type {Stats} from "node:fs"; export type S=Stats;',
    ],
    [
      "named-type-impure",
      'import {type Stats} from "node:fs"; export type S=Stats;',
    ],
    [
      "unprefixed-impure",
      'import {readFile} from "fs/promises"; export {readFile};',
    ],
    ["dynamic-impure", 'export const read=()=>import("node:child_process");'],
    ["dynamic-outside", 'export const read=()=>import("drizzle-orm");'],
    ["export-from", 'export {value} from "hono";'],
    [
      "fold-package-mixed",
      'import type {A} from "hono"; import {b} from "hono"; export const value=b;',
    ],
    [
      "fold-all-type-only",
      'import type {A} from "hono"; import type {B} from "hono"; export type P=[A,B];',
    ],
    [
      "fold-file-aliases",
      'import {value as a} from "../../generated/client"; import {value as b} from "../../generated/../generated/client"; export const value=[a,b];',
    ],
    [
      "tsconfig-alias",
      'import {value} from "~generated/client"; export {value};',
    ],
    [
      "package-subpaths-separate",
      'import "drizzle-orm"; import "drizzle-orm/d1";',
    ],
    ["adapter-library", 'import {value} from "@shop/adapter"; export {value};'],
    [
      "configurator-library",
      'import {value} from "@shop/configurator"; export {value};',
    ],
    ["any-library", 'import {value} from "@shop/any"; export {value};'],
    ["nothing", "export const value=1;"],
  ];
  for (const [id, source] of sourceCases) disk(`disk-${id}`, source);
  disk("disk-kind-disabled", 'import "hono";', {
    ...rules,
    applicationShape: [],
  });
  disk("disk-no-library-types-allowed", 'import "@shop/core";', {
    ...rules,
    applicationMayImport: [],
  });
  disk("disk-library-covered-by-pure-glob", 'import "@shop/ui/sub";', {
    ...rules,
    pureDependencies: ["@shop/ui"],
  });
  for (const [name, source] of [
    ["index.ts", "export const value=1;"],
    ["application/index.ts", "export const value=1;"],
    ["ports.ts", 'import "hono";'],
    ["adapters/driven/x.ts", 'import "hono";'],
    ["adapters/driving/x.ts", 'import "hono";'],
  ]) {
    const file = `src/billing/${name}`;
    put(`${scope}/${file}`, source);
    add(`disk-eligibility-${name}`, {
      ...base,
      file,
      facts: { kind: "disk" },
      action: { kind: "judge", placeFile: file },
    });
  }
  for (const [index, source] of [
    "",
    'export {value} from "./other";',
    "export * from './other';",
    "export default {};",
    "export {value};",
    "import './other';",
    "export const value=1;",
    "run();",
  ].entries()) {
    const file = `src/entry${index}/index.ts`;
    put(`${scope}/${file}`, source);
    add(`disk-entry-form-${index}`, {
      ...base,
      file,
      facts: { kind: "disk" },
      action: { kind: "judge", placeFile: file },
    });
  }
  add("disk-library-entry-does-not-belong-to-api", {
    ...base,
    file: "src/index.ts",
    facts: { kind: "disk" },
    action: { kind: "judge", placeFile: "src/index.ts" },
  });
  put("packages/core/src/schema/index.ts", "export default {};");
  for (const file of ["src/index.ts", "src/schema/index.ts"]) {
    add(`disk-library-${file}`, {
      ...base,
      scope: "packages/core",
      file,
      facts: { kind: "disk" },
      action: { kind: "judge", placeFile: file },
    });
  }
  for (const [name, source] of Object.entries({
    "src/application/use.ts":
      'import {value} from "./driven-ports/port"; import {value as b} from "../driven-adapters/db";',
    "src/application/driven-ports/port.ts": "export const value=1;",
    "src/driven-adapters/db.ts": "export const value=1;",
  }))
    put(`services/port/${name}`, source);
  add("disk-port-layout", {
    ...base,
    scope: "services/port",
    file: "src/application/use.ts",
    facts: { kind: "disk" },
    action: { kind: "judge", placeFile: "src/application/use.ts" },
  });
  type Edge = Extract<
    ShapeJudgmentInput["facts"],
    { kind: "opaque" }
  >["edges"][number];
  const edge = (
    specifier: string,
    target: string | null = null,
    typeOnly = false,
  ): Edge => ({ specifier, kind: "static", typeOnly, target });
  function opaque(
    id: string,
    edges: Edge[],
    extra: Partial<ShapeJudgmentInput> = {},
    runtimeSpecifiers = edges
      .filter((edge) => !edge.typeOnly)
      .map((edge) => edge.specifier),
    offendingForm: string | null = null,
  ) {
    add(id, {
      ...base,
      facts: { kind: "opaque", edges, runtimeSpecifiers, offendingForm },
      ...extra,
    });
  }
  for (const specifier of [
    "hono",
    "hono/sub",
    "./missing",
    "../missing",
    ".\\missing",
    "/absolute",
    "node:path",
    "node:fs",
    "fs/promises",
    "node:child_process/sub",
    "@shop/core",
    "@shop/ui",
    "@shop/adapter",
    "@shop/any",
    "@shop/stray",
    "x\ud800",
    "__proto__",
    "",
  ]) {
    opaque(`opaque-package-${JSON.stringify(specifier)}`, [edge(specifier)]);
  }
  opaque("opaque-pure-glob", [edge("@shop/ui/sub")], {
    rules: { ...rules, pureDependencies: ["@shop/ui"] },
  });
  opaque(
    "opaque-relative-never-pure",
    [edge("./missing"), edge(".\\missing"), edge("/absolute")],
    { rules: { ...rules, pureDependencies: ["**"] } },
  );
  opaque(
    "opaque-dot-package-glob-exclusion",
    [edge(".hidden"), edge("\\absolute"), edge("")],
    { rules: { ...rules, pureDependencies: ["**"] } },
  );
  opaque("opaque-type-only-impure", [edge("node:fs", null, true)], {}, []);
  opaque("opaque-named-type-impure", [edge("node:fs")], {}, []);
  opaque(
    "opaque-runtime-flag-still-type-only",
    [edge("node:fs", null, true)],
    {},
    ["node:fs"],
  );
  opaque("opaque-loaded-impure-spelling-is-file", [
    edge("node:fs", "src/generated/client.ts"),
  ]);
  opaque("opaque-original-judged", [edge("hono")], {
    judged: [{ kind: "original", index: 0 }],
  });
  opaque("opaque-equal-copy-not-judged", [edge("hono")], {
    judged: [{ kind: "copy", index: 0 }],
  });
  opaque(
    "opaque-equal-edges-distinct",
    [edge("hono", null, true), edge("hono", null, false)],
    { judged: [{ kind: "original", index: 0 }] },
  );
  opaque(
    "opaque-skip-before-fold",
    [edge("hono", null, false), edge("hono", null, true)],
    { judged: [{ kind: "original", index: 0 }] },
  );
  opaque("opaque-first-specifier", [
    edge("z-alias", "src/generated/client.ts", true),
    edge("a-alias", "src/generated/client.ts", false),
  ]);
  opaque("opaque-all-type-only", [
    edge("z-alias", "src/generated/client.ts", true),
    edge("a-alias", "src/generated/client.ts", true),
  ]);
  opaque("opaque-first-empty-specifier", [
    edge("", "src/generated/client.ts", true),
    edge("later", "src/generated/client.ts", false),
  ]);
  const collision = `${scope}/src/generated/client.ts`;
  opaque("opaque-package-file-key-collision", [
    edge(collision),
    edge("alias", "src/generated/client.ts", true),
  ]);
  opaque("opaque-file-package-key-collision", [
    edge("alias", "src/generated/client.ts", true),
    edge(collision),
  ]);
  opaque("opaque-empty-key-collision", [edge(""), edge("alias", "", true)], {
    scope: ".",
  });
  opaque("opaque-empty-key-reversed", [edge("alias", "", true), edge("")], {
    scope: ".",
  });
  for (const target of [
    "src/orders/ports.ts",
    "src/orders/application/helpers.ts",
    "src/orders/index.ts",
    "src/orders/helpers.ts",
    "src/orders/adapters/driven/db.ts",
    "src/billing/index.ts",
    "src/billing/application/charge.ts",
    "src/lib/format.ts",
    "src/generated/client.ts",
    "",
  ]) {
    opaque(`opaque-target-${JSON.stringify(target)}`, [edge("to", target)]);
  }
  opaque("opaque-disabled-b16", [edge("hono")], {
    rules: { ...rules, applicationShape: [] },
  });
  opaque(
    "opaque-disabled-b15",
    [],
    {
      rules: { ...rules, applicationShape: [] },
      file: "src/orders/index.ts",
      action: { kind: "judge", placeFile: "src/orders/index.ts" },
    },
    [],
    "declaration",
  );
  opaque(
    "opaque-empty-entry-form",
    [],
    {
      file: "src/orders/index.ts",
      action: { kind: "judge", placeFile: "src/orders/index.ts" },
    },
    [],
    "",
  );
  opaque(
    "opaque-raw-entry-form",
    [],
    {
      file: "src/orders/index.ts",
      action: { kind: "judge", placeFile: "src/orders/index.ts" },
    },
    [],
    "form\ud800",
  );
  opaque("opaque-raw-scope", [edge("hono")], {
    scope: "services/\udfff",
    rules: { ...rules, features: { "services/\udfff": ["orders"] } },
  });
  opaque(
    "opaque-library-entry-before-application",
    [edge("hono")],
    {
      scope: "packages/core",
      file: "src/index.ts",
      action: { kind: "judge", placeFile: "src/orders/application/use.ts" },
    },
    [],
    "declaration",
  );
  opaque("opaque-missing-inherited-scope", [], {
    scope: "constructor",
    rules: {},
  });
  for (const own of [
    [],
    ["application"] as const,
    ["ports", "application"] as const,
    ["index", "unknown"] as const,
  ]) {
    opaque(
      `application-own-${own.join("-")}`,
      [
        edge("index", "src/orders/index.ts"),
        edge("ports", "src/orders/ports.ts"),
        edge("app", "src/orders/application/helpers.ts"),
        edge("unknown", "src/orders/helpers.ts"),
      ],
      { action: { kind: "application", feature: "orders", own: [...own] } },
    );
  }
  opaque("application-ignores-kind-toggle", [edge("hono")], {
    rules: { ...rules, applicationShape: [] },
    action: {
      kind: "application",
      feature: "orders",
      own: ["ports", "application"],
    },
  });
  opaque(
    "application-feature-fact-differs",
    [edge("index", "src/orders/index.ts")],
    { action: { kind: "application", feature: "other", own: [] } },
  );
  opaque(
    "application-port-layout",
    [
      edge("port", "src/application/driven-ports/port.ts"),
      edge("adapter", "src/driven-adapters/db.ts"),
    ],
    {
      scope: "services/port",
      action: {
        kind: "application",
        feature: "services/port",
        own: ["ports", "application"],
      },
    },
  );
  const bad = path.join(directory, "bad");
  put("wrangler.jsonc", "{", bad);
  opaque("refusal-before-judgment", [edge("hono")], {
    repoRoot: bad,
    rules: { readAllowance: { [scope]: { driven: ["read.ts"] } } },
  });
  const expected = cases.map((item) =>
    JSON.parse(JSON.stringify(shapeJudgmentReference(item.input))),
  );
  assert.equal(new Set(cases.map((item) => item.id)).size, cases.length);
  const answer = (id: string) =>
    expected[cases.findIndex((item) => item.id === id)];
  assert.ok(
    "violations" in answer("opaque-original-judged"),
    JSON.stringify(answer("opaque-original-judged")),
  );
  assert.equal(answer("opaque-original-judged").violations.length, 0);
  assert.equal(answer("opaque-equal-copy-not-judged").violations.length, 1);
  assert.equal(
    answer("opaque-first-specifier").violations[0].specifier,
    "z-alias",
  );
  assert.equal(answer("opaque-first-specifier").violations[0].typeOnly, false);
  assert.equal(
    answer("opaque-file-package-key-collision").violations[0].to,
    null,
  );
  assert.deepEqual(
    answer("opaque-library-entry-before-application").violations.map(
      (row: { kind: string }) => row.kind,
    ),
    ["index-not-exports-only", "application-import-outside-allowlist"],
  );
  assert.equal(answer("disk-adapter-library").violations.length, 0);
  assert.equal(answer("disk-type-only-impure").violations[0].typeOnly, true);
  assert.equal(answer("disk-named-type-impure").violations[0].typeOnly, false);
  const invalid = [
    { id: "unknown-operation", operation: "unknown", input: base },
    {
      id: "unknown-input-field",
      operation: "code_graph.shape-judgment",
      input: { ...base, ignored: true },
    },
    {
      id: "unknown-action-field",
      operation: "code_graph.shape-judgment",
      input: {
        ...base,
        action: { kind: "judge", placeFile: file, ignored: true },
      },
    },
    {
      id: "unknown-facts-kind",
      operation: "code_graph.shape-judgment",
      input: { ...base, facts: { kind: "guess" } },
    },
    {
      id: "missing-offending-form",
      operation: "code_graph.shape-judgment",
      input: {
        ...base,
        facts: { kind: "opaque", edges: [], runtimeSpecifiers: [] },
      },
    },
    {
      id: "missing-edge-target",
      operation: "code_graph.shape-judgment",
      input: {
        ...base,
        facts: {
          kind: "opaque",
          edges: [{ specifier: "hono", kind: "static", typeOnly: false }],
          runtimeSpecifiers: [],
          offendingForm: null,
        },
      },
    },
    {
      id: "unknown-edge-field",
      operation: "code_graph.shape-judgment",
      input: {
        ...base,
        facts: {
          kind: "opaque",
          edges: [{ ...edge("hono"), extra: true }],
          runtimeSpecifiers: [],
          offendingForm: null,
        },
      },
    },
    {
      id: "bad-judged-index",
      operation: "code_graph.shape-judgment",
      input: { ...base, judged: [{ kind: "original", index: 1 }] },
    },
    {
      id: "wrong-judged-kind",
      operation: "code_graph.shape-judgment",
      input: { ...base, judged: [{ kind: "value", index: 0 }] },
    },
    {
      id: "unknown-own-zone",
      operation: "code_graph.shape-judgment",
      input: {
        ...base,
        action: { kind: "application", feature: "orders", own: ["future"] },
      },
    },
  ];
  for (const item of invalid.filter((item) => item.operation !== "unknown"))
    assert.equal(
      shapeJudgmentSchema.safeParse(item.input).success,
      false,
      item.id,
    );
  const requests = [...cases, ...invalid],
    child = spawnSync(binary, {
      input: `${requests.map((item) => JSON.stringify(item)).join("\n")}\n`,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  assert.equal(child.status, 0, child.stderr);
  const replies = child.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(replies.length, requests.length);
  for (const [index, item] of cases.entries()) {
    const reply = replies[index];
    assert.equal(reply.id, item.id);
    assert.equal(reply.ok, true, `${item.id}: ${JSON.stringify(reply)}`);
    assert.deepEqual(reply.output, expected[index], item.id);
    assert.ok(reply.observedCalls.length > 0, item.id);
  }
  for (const [index, item] of invalid.entries()) {
    const reply = replies[cases.length + index];
    assert.equal(reply.id, item.id);
    assert.equal(reply.ok, false, item.id);
    assert.equal(reply.error.tag, "driver-error", item.id);
    assert.ok(reply.error.message.length > 0, item.id);
    assert.deepEqual(reply.observedCalls, [], item.id);
  }
  const report = {
    passed: cases.length,
    rejectedInvalidInputs: invalid.length,
    reference: {
      runtime: process.version,
      v8: process.versions.v8,
      source: "shape/application.ts and shape/judge.ts",
      native:
        "actual public native application_violations / judge_shape calls with shared filesystem imports and borrowed edge identities",
    },
    caseCounts: {
      disk: cases.filter((item) => item.input.facts.kind === "disk").length,
      opaque: cases.filter((item) => item.input.facts.kind === "opaque").length,
      application: cases.filter(
        (item) => item.input.action.kind === "application",
      ).length,
      judge: cases.filter((item) => item.input.action.kind === "judge").length,
    },
    cases: requests.map((item, index) => ({
      id: item.id,
      operation: item.operation,
      input: item.input,
      expected: index < cases.length ? expected[index] : { rejected: true },
      ...replies[index],
    })),
  };
  if (process.argv[3])
    fs.writeFileSync(process.argv[3], `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(
    `${JSON.stringify({ passed: report.passed, rejectedInvalidInputs: report.rejectedInvalidInputs, caseCounts: report.caseCounts })}\n`,
  );
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
