import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  loadDataReport,
  scanDataSites,
} from "../../packages/code-graph/src/data/extract.js";
import { discoverFunctions } from "../../packages/code-graph/src/extract/functions.js";
import { loadCheapProject } from "../../packages/code-graph/src/extract/project.js";
import { loadBindingCatalog } from "../../packages/code-graph/src/extract/wrangler-config.js";
import { DataReportSchema } from "../../packages/code-graph/src/schema.js";

const binary = process.argv[2];
assert.ok(
  binary,
  "usage: node --import tsx graph-data.mts <native-driver> [evidence.json]",
);
assert.equal(process.version, "v22.21.1");
assert.ok(process.versions.v8.startsWith("12.4."));
const repo = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const inputSchema = z.strictObject({
  root: z.string(),
  repoRoot: z.string().optional(),
  omitFunctions: z.boolean().default(false),
  foreignFunctions: z.boolean().default(false),
  duplicateUnits: z.boolean().default(false),
});
type Input = z.infer<typeof inputSchema>;
type Case = { id: string; operation: "code_graph.data_report"; input: Input };
const responseSchema = z.object({
  id: z.string().nullable(),
  ok: z.boolean(),
  output: z.unknown().optional(),
  error: z.object({ kind: z.string(), message: z.string() }).optional(),
  observedCalls: z.array(z.string()),
});
const outputSchema = z.object({
  functions: z.number(),
  parseFailures: z.array(z.string()),
  scan: DataReportSchema.pick({ edges: true, unattributed: true }),
  report: DataReportSchema,
});
type Response = z.infer<typeof responseSchema>;
const root = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "demlik-data-parity-")),
);
const cases: Case[] = [];
function write(file: string, text: string): void {
  const absolute = path.join(root, file);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, text);
}
function add(id: string, dir: string, options: Partial<Input> = {}): void {
  cases.push({
    id,
    operation: "code_graph.data_report",
    input: inputSchema.parse({ root: path.join(root, dir), ...options }),
  });
}
function copyFixture(source: string, destination: string): void {
  fs.cpSync(source, path.join(root, destination), { recursive: true });
  const pending = [path.join(root, destination)];
  for (
    let directory = pending.pop();
    directory !== undefined;
    directory = pending.pop()
  )
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
function reference(item: Case): Response {
  try {
    const input = item.input,
      repoRoot = input.repoRoot ?? input.root;
    const loaded = loadCheapProject(input.root);
    const own = input.foreignFunctions ? loadCheapProject(input.root) : loaded;
    const functions = input.omitFunctions
      ? []
      : discoverFunctions(own.sourceFiles).functions;
    const units = input.duplicateUnits
      ? [...loaded.sourceFiles, ...loaded.sourceFiles]
      : loaded.sourceFiles;
    const catalog = loadBindingCatalog(repoRoot);
    const scan = scanDataSites({ units, functions, catalog, repoRoot });
    const report = loadDataReport(units, functions, repoRoot);
    return {
      id: item.id,
      ok: true,
      output: {
        functions: functions.length,
        parseFailures: loaded.parseFailures,
        scan,
        report,
      },
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
  copyFixture(path.join(repo, "packages/code-graph/test/data/fixture"), "real");
  write(
    "real/unowned.ts",
    'export function unowned(env: any) {env.DB.prepare("SELECT 1");}\n',
  );
  add("existing-two-worker-data-fixture", "real");
  add(
    "repeated-units-keep-one-row-per-holder-line-column-binding-method",
    "real",
    { duplicateUnits: true },
  );
  add("omitted-functions-leave-all-sites-unattributed", "real", {
    omitFunctions: true,
  });
  add("same-filename-and-spans-from-another-parse-do-not-own-sites", "real", {
    foreignFunctions: true,
  });
  add(
    "selected-worker-keeps-repo-configs-and-scope-relative-function-ids",
    "real/workers/api",
    { repoRoot: path.join(root, "real") },
  );
  add("selected-source-directory-keeps-catalog-owner", "real/workers/api/src", {
    repoRoot: path.join(root, "real"),
  });
  copyFixture(
    path.join(repo, "packages/code-graph/test/data/alias-scope"),
    "aliases",
  );
  add("existing-alias-scope-fixture-held-and-unattributed-sites", "aliases");
  write(
    "nested/wrangler.json",
    '{"name":"parent","d1_databases":[{"binding":"DB"}]}',
  );
  write(
    "nested/entry.ts",
    'export function parent(env: any) {env.DB.prepare("SELECT 1");}',
  );
  write(
    "nested/child/wrangler.json",
    '{"name":"child","kv_namespaces":[{"binding":"DB"}]}',
  );
  write(
    "nested/child/entry.ts",
    'export function child(env: any) {env.DB.put("k","v");}',
  );
  add("nearest-worker-owns-a-shared-binding-name", "nested");
  write(
    "raw/wrangler.json",
    String.raw`{"name":"\udfff","d1_databases":[{"binding":"\ud800"}],"kv_namespaces":[{"binding":""},{"binding":"DB"}]}`,
  );
  write(
    "raw/entry.ts",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: The source fixture must retain its template expression.
    'export function raw(env: any) {env["\\ud800"]["\\udfff"](`SELECT ${column}`); env[""].put("k","v"); consume(env.DB); env.DB[""]();}',
  );
  add("raw-owner-binding-and-method-strings-survive-data-json", "raw");
  write(
    "duplicate-binding/wrangler.json",
    '{"name":"duplicate","d1_databases":[{"binding":"DB"}],"kv_namespaces":[{"binding":"DB"}]}',
  );
  write(
    "duplicate-binding/entry.ts",
    'export function duplicate(env: any) {env.DB.prepare("SELECT 1"); env.DB.put("k","v");}',
  );
  add(
    "catalog-order-selects-last-binding-declaration-per-name",
    "duplicate-binding",
  );
  write(
    "two-configs/wrangler.json",
    '{"name":"a","d1_databases":[{"binding":"DB"}]}',
  );
  write(
    "two-configs/wrangler.toml",
    "name='b'\n[[kv_namespaces]]\nbinding='DB'\n",
  );
  write(
    "two-configs/entry.ts",
    'export function first(env: any) {env.DB.prepare("SELECT 1");}',
  );
  add("same-directory-worker-selection-retains-first-manifest", "two-configs");
  write(
    "service-only/wrangler.json",
    '{"name":"service","services":[{"binding":"SVC","service":"other"}],"workflows":[{"binding":"FLOW","class_name":"Flow"}]}',
  );
  write(
    "service-only/entry.ts",
    'export function nondata(env: any) {env.SVC.fetch("url"); env.FLOW.create({});}',
  );
  add("nondata-bindings-do-not-invent-data-edges", "service-only");
  write(
    "holders/wrangler.json",
    '{"name":"holders","d1_databases":[{"binding":"DB"}],"kv_namespaces":[{"binding":"CACHE"}]}',
  );
  write(
    "holders/entry.ts",
    'declare const env: any;\nexport class Store {\n constructor() {env.DB.prepare("SELECT 1");}\n get value() {return env.CACHE.get("k");}\n set value(v: unknown) {env.CACHE.put("k",v);}\n run() {function nested() {env.DB.exec("DELETE FROM t");} consume(() => env.CACHE.get("k")); nested();}\n}\nconst arrow = () => env.DB.prepare("SELECT 2");\nconst object = { method() {env.CACHE.delete("k");}, field: () => env.DB.prepare("SELECT 3") };\nconsume(() => env.DB.prepare("SELECT 4"));\nexport default function defaults(db=env.DB) {db.prepare("SELECT 5");}\n',
  );
  add(
    "nearest-discovered-constructor-accessor-method-arrow-and-nested-holder",
    "holders",
  );
  write(
    "malformed/wrangler.json",
    '{"name":"malformed","d1_databases":[{"binding":"DB"}]}',
  );
  write(
    "malformed/good.ts",
    'export function good(env: any) {env.DB.prepare("SELECT 1");}',
  );
  write("malformed/bad.ts", "export const = ;");
  add(
    "malformed-source-is-parse-failure-and-good-units-are-scanned",
    "malformed",
  );
  write("broken/wrangler.jsonc", '{"d1_databases":[{"binding":"DB"}');
  write(
    "broken/entry.ts",
    'export function wouldBeData(env: any) {env.DB.prepare("SELECT 1");}',
  );
  add("malformed-config-stays-unparsed-and-has-no-owner", "broken");
  write(
    "unsafe/wrangler.toml",
    "name='unsafe'\nvalue=9007199254740992\n[[d1_databases]]\nbinding='DB'\n",
  );
  write(
    "unsafe/entry.ts",
    'export function wouldBeData(env: any) {env.DB.prepare("SELECT 1");}',
  );
  add("unsafe-toml-config-remains-unparsed", "unsafe");
  write("throwing/wrangler.json", '{"vars":{"constructor":null}}');
  write(
    "throwing/entry.ts",
    'export function wouldBeData(env: any) {env.DB.prepare("SELECT 1");}',
  );
  add("catalog-type-error-propagates-through-data-report", "throwing");
  write("no-bindings/wrangler.json", '{"name":"empty"}');
  write(
    "no-bindings/entry.ts",
    'export function unbound(env: any) {env.DB.prepare("SELECT 1");}',
  );
  add("measured-empty-report-for-config-without-data-bindings", "no-bindings");
  fs.mkdirSync(path.join(root, "empty"));
  add("empty-directory-is-a-measured-empty-report", "empty");
  add("missing-directory-is-a-measured-empty-report", "missing");
  cases.push({
    id: "actual-code-graph-source-data-scan",
    operation: "code_graph.data_report",
    input: inputSchema.parse({
      root: path.join(repo, "packages/code-graph/src"),
    }),
  });
  const expected = cases.map(reference);
  for (const [index, item] of cases.entries())
    assert.equal(
      expected[index].ok,
      item.id !== "catalog-type-error-propagates-through-data-report",
      item.id,
    );
  const first = outputSchema.parse(expected[0].output);
  assert.equal(first.report.edges.length, 18);
  assert.equal(first.report.unattributed.length, 2);
  assert.deepEqual(
    first.report.edges
      .filter(
        (row) =>
          row.functionId === "workers/api/src/routes.ts:purgeOrganizations",
      )
      .map((row) => [row.line, row.column, row.method, row.access]),
    [
      [20, 10, "batch", "unknown"],
      [20, 20, "prepare", "read"],
      [20, 55, "prepare", "write"],
    ],
  );
  assert.deepEqual(outputSchema.parse(expected[1].output).report, first.report);
  for (const index of [2, 3]) {
    const report = outputSchema.parse(expected[index].output).report;
    assert.equal(report.edges.length, 0);
    assert.equal(report.unattributed.length, 20);
  }
  const alias = outputSchema.parse(expected[6].output).report;
  assert.equal(alias.edges.length, 7);
  assert.equal(alias.unattributed.length, 2);
  const raw = outputSchema.parse(
    expected[
      cases.findIndex(
        (item) =>
          item.id === "raw-owner-binding-and-method-strings-survive-data-json",
      )
    ].output,
  ).report;
  assert.equal(raw.edges[0].ownerService, "\udfff");
  assert.equal(raw.edges[0].binding, "\ud800");
  assert.equal(raw.edges[0].method, "\udfff");
  const invalid = [
    "not json",
    JSON.stringify({ id: "unsupported", operation: "invented", input: {} }),
    JSON.stringify({
      id: "missing-root",
      operation: "code_graph.data_report",
      input: {},
    }),
    JSON.stringify({
      id: "bad-option",
      operation: "code_graph.data_report",
      input: { root, omitFunctions: "yes" },
    }),
    JSON.stringify({
      id: "unknown-option",
      operation: "code_graph.data_report",
      input: { root, data: true },
    }),
  ];
  const native = spawnSync(binary, [], {
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
    if (answer.ok) {
      outputSchema.parse(returned.output);
      assert.deepEqual(returned.output, answer.output, cases[index].id);
      assert.ok(
        returned.observedCalls.includes(
          "demlik_code_graph::data::extract::scan_data_sites",
        ),
      );
      assert.ok(
        returned.observedCalls.includes(
          "demlik_code_graph::data::extract::load_data_report",
        ),
      );
    } else assert.deepEqual(returned.error, answer.error, cases[index].id);
  }
  for (const answer of actual.slice(cases.length)) {
    assert.equal(answer.ok, false);
    assert.ok(answer.error?.message);
    assert.deepEqual(answer.observedCalls, []);
  }
  const outputs = expected
    .filter((answer) => answer.ok)
    .map((answer) => outputSchema.parse(answer.output));
  const evidence = {
    reference: {
      node: process.version,
      v8: process.versions.v8,
      parser: "OXC 0.151.0",
      profile:
        "syntax-only data report; actual AST identity for function holders",
    },
    passed: cases.length,
    rejectedInvalidInputs: invalid.length,
    functions: outputs.reduce((sum, output) => sum + output.functions, 0),
    sites: outputs.reduce(
      (sum, output) =>
        sum + output.report.edges.length + output.report.unattributed.length,
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
