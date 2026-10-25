import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  accessOf,
  sqlAccess,
} from "../../packages/code-graph/src/data/access.js";
import { bindingSites } from "../../packages/code-graph/src/data/extract.js";
import { parseTypeScript } from "../../packages/code-graph/src/engine/oxc.js";
import { DataBindingKindSchema } from "../../packages/code-graph/src/schema.js";
import { SyntaxFile } from "../../packages/code-graph/src/syntax/file.js";

const binary = process.argv[2];
assert.ok(
  binary,
  "usage: node --import tsx graph-data-sites.mts <native-driver> [evidence.json]",
);
assert.equal(process.version, "v22.21.1");
assert.ok(process.versions.v8.startsWith("12.4."));
const repo = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const accessInput = z.strictObject({
  kind: DataBindingKindSchema,
  method: z.string().nullable(),
  sql: z.string().nullable(),
});
const declSchema = z.strictObject({
  binding: z.string(),
  kind: DataBindingKindSchema,
});
const sitesInput = z.strictObject({
  file: z.string(),
  source: z.string(),
  bindings: z.array(z.tuple([z.string(), declSchema])),
});
type Decl = z.infer<typeof declSchema>;
type Binding = [string, Decl];
type Case =
  | {
      id: string;
      operation: "code_graph.data_access";
      input: z.infer<typeof accessInput>;
    }
  | {
      id: string;
      operation: "code_graph.binding_sites";
      input: z.infer<typeof sitesInput>;
    };
const responseSchema = z.object({
  id: z.string().nullable(),
  ok: z.boolean(),
  output: z.unknown().optional(),
  error: z.object({ kind: z.string(), message: z.string() }).optional(),
  observedCalls: z.array(z.string()),
});
const cases: Case[] = [];
function access(
  id: string,
  kind: z.infer<typeof DataBindingKindSchema>,
  method: string | null,
  sql: string | null = null,
): void {
  cases.push({
    id,
    operation: "code_graph.data_access",
    input: accessInput.parse({ kind, method, sql }),
  });
}
const bindings: Binding[] = [
  ["DB", { binding: "DB", kind: "d1" }],
  ["OTHER", { binding: "OTHER", kind: "d1" }],
  ["CACHE", { binding: "CACHE", kind: "kv" }],
  ["ASSETS", { binding: "ASSETS", kind: "r2" }],
  ["EVENTS", { binding: "EVENTS", kind: "queue" }],
  ["COUNTER", { binding: "COUNTER", kind: "durable-object" }],
  ["\ud800", { binding: "\udfff", kind: "kv" }],
  ["", { binding: "", kind: "kv" }],
];
function sites(
  id: string,
  source: string,
  file = "fixture.ts",
  declared: Binding[] = bindings,
): void {
  cases.push({
    id,
    operation: "code_graph.binding_sites",
    input: sitesInput.parse({ file, source, bindings: declared }),
  });
}
for (const kind of DataBindingKindSchema.options)
  for (const [index, method] of [
    null,
    "get",
    "getWithMetadata",
    "list",
    "put",
    "delete",
    "head",
    "createMultipartUpload",
    "resumeMultipartUpload",
    "send",
    "sendBatch",
    "prepare",
    "exec",
    "dump",
    "batch",
    "GET",
    "toString",
    "constructor",
    "\ud800",
    "",
  ].entries())
    access(`method-table-${kind}-${index}`, kind, method, "SELECT 1");
const sqls = [
  null,
  "",
  "SELECT 1",
  " select 1",
  "INSERT INTO t VALUES (?)",
  "UPDATE t SET a=1",
  "DELETE FROM t",
  "REPLACE INTO t VALUES (?)",
  "CREATE TABLE t (id)",
  "DROP TABLE t",
  "ALTER TABLE t ADD b",
  "WITH x AS (SELECT 1) SELECT * FROM x",
  "PRAGMA table_list",
  "-- comment\nSELECT 1",
  "/* comment */SELECT 1",
  ";SELECT 1",
  "123SELECT",
  "SELECT_ignored",
  "SELECTing",
  "\ufeffselect 1",
  "\u0085SELECT 1",
  "\ud800SELECT 1",
  "\u2028\u2029INSERT INTO t VALUES (1)",
  "\t\v\f\r\n  SELECT 1",
];
for (const [index, sql] of sqls.entries())
  for (const method of ["prepare", "exec"])
    access(`sql-leading-keyword-${method}-${index}`, "d1", method, sql);
for (const space of [
  "\t",
  "\n",
  "\v",
  "\f",
  "\r",
  " ",
  "\u00a0",
  "\u1680",
  "\u2000",
  "\u2001",
  "\u2002",
  "\u2003",
  "\u2004",
  "\u2005",
  "\u2006",
  "\u2007",
  "\u2008",
  "\u2009",
  "\u200a",
  "\u2028",
  "\u2029",
  "\u202f",
  "\u205f",
  "\u3000",
  "\ufeff",
])
  access(
    `sql-js-whitespace-${space.charCodeAt(0)}`,
    "d1",
    "prepare",
    `${space}SELECT 1`,
  );
sites(
  "direct-env-kinds-and-same-line-sites",
  'const emoji = "😀"; env.DB.prepare("SELECT 1"); env.DB.prepare("DELETE FROM t");\nenv.CACHE.get("k"); this.env.CACHE.put("k","v"); c.env.ASSETS.head("k"); c.env.EVENTS.send({}); c.env.COUNTER.get("id");',
);
sites(
  "raw-member-sql-and-empty-binding",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: This parser fixture must retain the template expression.
  'env["\\ud800"]["\\udfff"](`\\ud800${value}`); env[""].put("k","v");',
);
const sources = [
  'env.DB.prepare("SELECT 1");',
  'this.env.DB.prepare("SELECT 1"); c.env.DB.exec("DROP TABLE t"); get().env.CACHE.get("k");',
  'env["DB"]["prepare"]("SELECT 1"); env.DB[method]("SELECT 1"); env[name].prepare("SELECT 1");',
  'c["env"].DB.prepare("SELECT 1"); (env).DB.prepare("SELECT 1"); (env.DB).prepare("SELECT 1");',
  'env?.DB?.prepare?.("SELECT 1");',
  'const db = env.DB; db.prepare("SELECT 1");',
  'const db = env.DB; const copy = db; copy.prepare("SELECT 1"); db.prepare("SELECT 2");',
  'const db = env.DB; db = env.OTHER; db.prepare("SELECT 1");',
  'const {DB: db, CACHE} = env; db.prepare("SELECT 1"); CACHE.get("k");',
  'const {DB: db = fallback} = c.env; db.prepare("SELECT 1");',
  'const {DB: db = env.OTHER} = env; db.prepare("SELECT 1");',
  'const {"DB": db} = env; db.prepare("SELECT 1");',
  'const {["DB"]: db} = env; db.prepare("SELECT 1");',
  'const {DB: {nested: db}} = env; db.prepare("SELECT 1");',
  'const [db] = env; db.prepare("SELECT 1");',
  'const db = env.DB; ({DB: db} = env); db.prepare("SELECT 1");',
  "consume(env.DB); new Wrapper(env.DB); const {x} = env.DB;",
  "const db = env.DB; consume(db); new Wrapper(db); consume(...db); const copy = db;",
  "const db = env.DB; const method = db.prepare; const member = env.DB.prepare;",
  'const db = env.DB; (() => db.prepare("SELECT 1"))(); (() => {const db = env.OTHER; db.prepare("SELECT 2");})(); db.prepare("SELECT 3");',
  'const db = env.DB; function fn(db) { db.prepare("SELECT 1"); } function other() {db.prepare("SELECT 2");}',
  'const db = env.DB; const named = function db() {db.prepare("SELECT 1");}; db.prepare("SELECT 2");',
  'const db = env.DB; const C = class db { method() {db.prepare("SELECT 1");} };',
  'const db = env.DB; { db.prepare("SELECT 1"); const db = local; db.prepare("SELECT 2"); } db.prepare("SELECT 3");',
  'const db = env.DB; { let db; db.prepare("SELECT 1"); } db.prepare("SELECT 2");',
  'const db = env.DB; function fn() { db.prepare("SELECT 1"); if (true) {var db = env.OTHER;} db.prepare("SELECT 2"); } db.prepare("SELECT 3");',
  'const db = env.DB; function fn() {if (true) {var db = env.DB;} else {var db = env.OTHER;} db.prepare("SELECT 1");}',
  'const db = env.DB; for(let db = local; check(); next()) {db.prepare("SELECT 1");} db.prepare("SELECT 2");',
  'const db = env.DB; for(const db of values) {db.prepare("SELECT 1");} db.prepare("SELECT 2");',
  'const db = env.DB; for(const db in values) {db.prepare("SELECT 1");} db.prepare("SELECT 2");',
  'function fn() {for(var db = env.DB; check(); next()) {} db.prepare("SELECT 1");}',
  'const db = env.DB; switch(kind) {case 0: db.prepare("SELECT 1"); break; case 1: const db = local; db.prepare("SELECT 2");} db.prepare("SELECT 3");',
  'const db = env.DB; try {db.prepare("SELECT 1");} catch(db) {db.prepare("SELECT 2");} db.prepare("SELECT 3");',
  'const db = env.DB; class C { static {var db = env.OTHER; db.prepare("SELECT 1");} method(){db.prepare("SELECT 2");} } db.prepare("SELECT 3");',
  'const db = env.DB; class C {static {db.prepare("SELECT 1");} constructor(db) {db.prepare("SELECT 2");} get value(){return db.prepare("SELECT 3");}}',
  'function fn() {db.prepare("SELECT 1");} const db = env.DB; fn();',
  'export const db = env.DB; db.prepare("SELECT 1"); export function fn() {db.prepare("SELECT 2");}',
  'export default function fn(env) {const db = env.DB; db.prepare("SELECT 1");}',
  'const db = env.DB; namespace N {const alias = env.OTHER; alias.prepare("SELECT 1");} db.prepare("SELECT 2");',
  'const db = env.DB; using value = local; db.prepare("SELECT 1");',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: These parser fixtures must retain both template expressions.
  'const query = "SELECT 1"; env.DB.prepare(query); env.DB.prepare(`SELECT ${column}`); env.DB.prepare(`INSERT ${column}`);',
  "env.DB.prepare(tag`SELECT 1`); env.DB.prepare(1); env.DB.prepare(/SELECT/); env.DB.prepare();",
  String.raw`const d\u0062 = env.\u0044B; db.\u0070repare("SELECT 1");`,
  'const db = env.DB; type T = typeof db.prepare; db.prepare("SELECT 1");',
  'const db = env.DB; db?.prepare?.("SELECT 1"); (db).prepare("SELECT 2");',
  'const db = env.DB; { function db() {} db.prepare("SELECT 1"); } db.prepare("SELECT 2");',
  'const db = env.DB; { class db {} db.prepare("SELECT 1"); } db.prepare("SELECT 2");',
  'const db = env.DB; function fn({db = local}) {db.prepare("SELECT 1");} function other(...db) {db.prepare("SELECT 2");}',
  'const db = env.DB; (()=>{const {DB: db} = env; db.prepare("SELECT 1");})(); db.prepare("SELECT 2");',
  '/*😀*/ env.DB.prepare("SELECT 1");\r\nenv.DB.prepare("SELECT 2");\u2028env.DB.prepare("SELECT 3");\u2029env.DB.prepare("SELECT 4");',
];
for (const [index, source] of sources.entries())
  sites(`lexical-and-reference-shape-${index}`, source);
sites(
  "duplicate-map-key-retains-last-declaration",
  'env.DB.prepare("SELECT 1");',
  "fixture.ts",
  [
    ["DB", { binding: "first", kind: "kv" }],
    ["DB", { binding: "last", kind: "d1" }],
  ],
);
sites(
  "empty-bindings-do-not-invent-sites",
  'env.DB.prepare("SELECT 1");',
  "fixture.ts",
  [],
);
sites(
  "tsx-handler-scope",
  'const view = <button onClick={() => {const db = env.DB; db.prepare("SELECT 1");}}/>;',
  "view.tsx",
);
sites("malformed-typescript-is-observable", "export const = ;");
for (const file of [
  "test/data/alias-scope/workers/app/src/handlers.ts",
  "test/data/fixture/workers/api/src/orgs.ts",
  "test/data/fixture/workers/api/src/routes.ts",
  "test/data/fixture/workers/api/src/storage.ts",
  "test/data/fixture/workers/billing/src/invoices.ts",
  "src/data/extract.ts",
  "src/extract/wrangler-config.ts",
]) {
  sites(
    `existing-${file}`,
    fs.readFileSync(path.join(repo, "packages/code-graph", file), "utf8"),
    file,
  );
}
function reference(item: Case) {
  if (item.operation === "code_graph.data_access")
    return {
      ok: true,
      output: {
        sqlAccess: sqlAccess(item.input.sql),
        access: accessOf(item.input.kind, item.input.method, item.input.sql),
      },
    };
  const parsed = parseTypeScript(
    path.join("/", item.input.file),
    item.input.source,
  );
  if (!parsed.ok)
    return {
      ok: false,
      error: {
        kind: "parse-error",
        message: "source parser rejected TypeScript",
      },
    };
  const syntax = new SyntaxFile(
    item.input.source,
    parsed.program,
    parsed.comments,
  );
  const found = bindingSites(syntax, new Map(item.input.bindings));
  return {
    ok: true,
    output: {
      sites: found,
      accesses: found.map((site) =>
        accessOf(site.decl.kind, site.method, site.sql),
      ),
    },
  };
}
const expected = cases.map(reference);
for (const [index, item] of cases.entries()) {
  assert.equal(
    expected[index].ok,
    item.id !== "malformed-typescript-is-observable",
    item.id,
  );
}
const foundSchema = z.object({
  sites: z.array(
    z.object({
      decl: declSchema,
      method: z.string().nullable(),
      sql: z.string().nullable(),
      line: z.number(),
      column: z.number(),
    }),
  ),
  accesses: z.array(z.enum(["read", "unknown", "write"])),
});
const first = foundSchema.parse(
  expected[
    cases.findIndex(
      (item) => item.id === "direct-env-kinds-and-same-line-sites",
    )
  ].output,
);
assert.deepEqual(
  first.sites.slice(0, 2).map((site) => [site.line, site.column]),
  [
    [1, 21],
    [1, 49],
  ],
);
assert.deepEqual(first.accesses, [
  "read",
  "write",
  "read",
  "write",
  "read",
  "write",
  "unknown",
]);
const siblings = foundSchema.parse(
  expected[
    cases.findIndex(
      (item) =>
        item.id ===
        "existing-test/data/alias-scope/workers/app/src/handlers.ts",
    )
  ].output,
);
assert.deepEqual(
  siblings.sites.map((site) => [site.line, site.decl.binding]),
  [
    [11, "DB"],
    [15, "OTHER"],
    [23, "DB"],
    [27, "OTHER"],
    [39, "DB"],
    [46, "DB"],
    [51, "DB"],
    [59, "DB"],
    [71, "DB"],
  ],
);
const invalid = [
  "not json",
  JSON.stringify({ id: "unsupported", operation: "invented", input: {} }),
  JSON.stringify({
    id: "bad-kind",
    operation: "code_graph.data_access",
    input: { kind: "service", method: "fetch", sql: null },
  }),
  JSON.stringify({
    id: "missing-source",
    operation: "code_graph.binding_sites",
    input: { file: "f.ts", bindings: [] },
  }),
  JSON.stringify({
    id: "unknown",
    operation: "code_graph.binding_sites",
    input: { file: "f.ts", source: "", bindings: [], silentlyIgnored: true },
  }),
  JSON.stringify({
    id: "bad-method",
    operation: "code_graph.data_access",
    input: { kind: "d1", method: 1, sql: null },
  }),
];
const native = spawnSync(binary, [], {
  input: `${[...cases.map((item) => JSON.stringify(item)), ...invalid].join("\n")}\n`,
  encoding: "utf8",
  maxBuffer: 32 * 1024 * 1024,
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
  else {
    assert.equal(returned.error?.kind, answer.error?.kind, cases[index].id);
    assert.ok(returned.error?.message);
  }
  assert.ok(returned.observedCalls.length > 0, cases[index].id);
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
    parser: "OXC 0.151.0",
    dataProfile:
      "source syntax-only references, one alias level, cooked first template segment; no SQL constant propagation",
  },
  passed: cases.length,
  rejectedInvalidInputs: invalid.length,
  sites: expected
    .filter((answer) => answer.ok && answer.output && "sites" in answer.output)
    .reduce(
      (sum, answer) => sum + foundSchema.parse(answer.output).sites.length,
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
