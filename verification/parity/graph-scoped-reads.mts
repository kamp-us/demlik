import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { readLibraries } from "../../packages/code-graph/src/boundaries/libraries/libraries.js";
import { BoundaryRulesSchema } from "../../packages/code-graph/src/boundaries/rules.js";
import {
  readShape,
  shapeFactsOf,
} from "../../packages/code-graph/src/boundaries/shape/shape.js";
import {
  drivenReadsOf,
  firstWrite,
  readAllowanceOf,
  scopeReadsOf,
  unknownDriven,
} from "../../packages/code-graph/src/boundaries/zones/reads.js";
import { loadBindingCatalog } from "../../packages/code-graph/src/extract/wrangler-config.js";
import {
  importLiterals,
  runtimeSpecifiers,
} from "../../packages/code-graph/src/syntax/imports.js";
import { sourceUnit } from "../../packages/code-graph/src/test-helpers/source-unit.js";

const binary = process.argv[2];
assert.ok(binary, "provide the compiled scoped reads driver");
assert.equal(process.version, "v22.21.1");
assert.equal(process.versions.v8, "12.4.254.21-node.33");
const strings = z.array(z.string());
const sourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("file") }).strict(),
  z.object({ kind: z.literal("text"), text: z.string() }).strict(),
]);
const filesSchema = z.array(
  z.object({ file: z.string(), source: sourceSchema }).strict(),
);
const inputSchema = z
  .object({
    repoRoot: z.string(),
    rules: z.unknown(),
    scope: z.string(),
    files: filesSchema,
    targets: strings,
    probes: strings,
  })
  .strict();
const opaqueSchema = z
  .object({
    repoRoot: z.string(),
    rules: z.unknown(),
    scope: z.string(),
    modules: z.array(
      z
        .object({
          file: z.string(),
          firstWrite: z
            .object({
              binding: z.string(),
              line: z.custom<number>((value) => typeof value === "number"),
            })
            .strict()
            .nullable(),
        })
        .strict(),
    ),
    loaded: strings,
    importSpecifiers: strings,
    runtimeSpecifiers: strings,
    targets: strings,
  })
  .strict();
type Input = z.infer<typeof inputSchema>;
type Opaque = z.infer<typeof opaqueSchema>;
type Case = {
  id: string;
  operation:
    | "code_graph.read-sites"
    | "code_graph.shape-reads"
    | "code_graph.scoped-reads";
  input: Input | Opaque;
  rawLine?: string;
};
const directory = fs.mkdtempSync(path.join(tmpdir(), "demlik-scoped-reads-"));
try {
  const root = path.join(directory, "repo");
  function put(file: string, content: string | Buffer, repo = root) {
    const absolute = path.join(repo, file);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content);
  }
  put("package.json", '{"private":true}');
  put("wrangler.jsonc", '{"name":"root","kv_namespaces":[{"binding":"ROOT"}]}');
  put(
    "services/api/wrangler.jsonc",
    JSON.stringify({
      name: "api",
      main: "src/main.ts",
      d1_databases: [{ binding: "DB" }, { binding: "DUP" }],
      kv_namespaces: [{ binding: "CACHE" }, { binding: "DUP" }],
      r2_buckets: [{ binding: "ASSETS" }],
      queues: { producers: [{ binding: "EVENTS" }, { binding: "DUP" }] },
      durable_objects: {
        bindings: [{ name: "COUNTER", class_name: "Counter" }],
      },
    }),
  );
  put(
    "services/api/nested/wrangler.toml",
    "name='nested'\n[[kv_namespaces]]\nbinding='ONLY'\n",
  );
  put("services/empty/wrangler.jsonc", '{"name":"empty"}');
  for (const [dir, name] of [
    ["packages/kernel", "@shop/kernel"],
    ["packages/util", "@shop/util"],
    ["packages/free", "@shop/free"],
  ]) {
    put(`${dir}/package.json`, JSON.stringify({ name }));
    put(`${dir}/src/index.ts`, "export const decide=1;");
  }
  const badRoot = path.join(directory, "bad");
  put("a/wrangler.jsonc", "{", badRoot);
  put("z/wrangler.toml", "name = [", badRoot);
  const noWorker = path.join(directory, "no-worker");
  put("package.json", "{}", noWorker);
  const scope = "services/api";
  const file = "src/orders/adapters/driven/read.ts";
  const writeFile = "src/orders/adapters/driven/write.ts";
  const kernel = {
    libraryTypes: {
      kernel: { imports: [], pure: true },
      util: { imports: [], pure: true },
    },
    libraries: { "packages/kernel": "kernel", "packages/util": "util" },
  };
  const rules = {
    ...kernel,
    applicationShape: ["index-not-exports-only"],
    applicationMayImport: ["kernel", "kernel", "util"],
    pureDependencies: ["@shop/{kernel,contracts}", "node:*"],
    testFiles: ["**/*.test.ts", "services/api/spec/**"],
    compositionRoots: ["services/api/src/main.ts"],
    readAllowance: {
      [scope]: { driven: [file, writeFile, "gone.ts"], decidedBy: ["kernel"] },
    },
  };
  const probes = [
    "@shop/kernel",
    "@shop/contracts",
    "@shop/util",
    "node:fs",
    "src/a.test.ts",
    "services/api/spec/a.ts",
    "services/api/src/main.ts",
    "src/main.ts",
    "x\ud800.test.ts",
  ];
  const base: Input = {
    repoRoot: root,
    rules,
    scope,
    files: [],
    targets: [file, writeFile, "other.ts", file],
    probes,
  };
  const cases: Case[] = [];
  function add(
    id: string,
    input: Input,
    operation: Case["operation"] = "code_graph.read-sites",
  ) {
    cases.push({ id, operation, input });
  }
  function text(source: string, name = file): Input["files"][number] {
    return { file: name, source: { kind: "text", text: source } };
  }
  const calls = [
    ["d1-select", 'env.DB.prepare("SELECT 1")'],
    ["d1-insert", 'env.DB.prepare("INSERT INTO t VALUES (1)")'],
    ["d1-update", 'env.DB.prepare("update t set a=1")'],
    ["d1-delete", 'env.DB.prepare("DELETE FROM t")'],
    ["d1-replace", 'env.DB.prepare("REPLACE INTO t VALUES (1)")'],
    ["d1-create", 'env.DB.exec("CREATE TABLE t(a)")'],
    ["d1-drop", 'env.DB.prepare("DROP TABLE t")'],
    ["d1-alter", 'env.DB.prepare("ALTER TABLE t ADD b")'],
    ["d1-leading-space", 'env.DB.exec("\\ufeff\\t DELETE FROM t")'],
    ["d1-with-unknown", 'env.DB.exec("WITH q AS (SELECT 1) DELETE FROM t")'],
    ["d1-comment-unknown", 'env.DB.exec("-- head\\nDELETE FROM t")'],
    ["d1-nonliteral", "env.DB.prepare(sql)"],
    ["d1-dump", "env.DB.dump()"],
    ["d1-unrecognized-method", "env.DB.batch([])"],
    ["kv-get", 'env.CACHE.get("k")'],
    ["kv-metadata", 'env.CACHE.getWithMetadata("k")'],
    ["kv-list", "env.CACHE.list()"],
    ["kv-put", 'env.CACHE.put("k","v")'],
    ["kv-delete", 'env.CACHE.delete("k")'],
    ["r2-head", 'env.ASSETS.head("k")'],
    ["r2-get", 'env.ASSETS.get("k")'],
    ["r2-list", "env.ASSETS.list()"],
    ["r2-put", 'env.ASSETS.put("k","v")'],
    ["r2-delete", 'env.ASSETS.delete("k")'],
    ["r2-create-multipart", 'env.ASSETS.createMultipartUpload("k")'],
    ["r2-resume-multipart", 'env.ASSETS.resumeMultipartUpload("k","id")'],
    ["queue-send", "env.EVENTS.send({id:1})"],
    ["queue-send-batch", "env.EVENTS.sendBatch([])"],
    ["do-unknown", "env.COUNTER.get(env.COUNTER.idFromName('a'))"],
    ["not-declared", 'env.UNKNOWN.put("k","v")'],
    ["other-object", 'bindings.CACHE.put("k","v")'],
    ["computed-binding", 'env["CACHE"].put("k","v")'],
    ["computed-method", 'env.CACHE["put"]("k","v")'],
    ["optional", 'env.CACHE?.put("k","v")'],
    ["template-literal", "env.DB.prepare(`DELETE FROM t`)"],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal TypeScript source exercises a SQL template with a hole.
    ["template-with-hole", "env.DB.prepare(`DELETE FROM ${table}`)"],
    ["constant-alias", "env.DB.prepare(SQL)"],
    ["duplicate-declaration-last-queue", "env.DUP.send({})"],
    ["duplicate-declaration-not-kv", "env.DUP.put('k','v')"],
  ];
  for (const [id, call] of calls) {
    add(id, {
      ...base,
      files: [
        text(
          `declare const SQL = 'DELETE FROM t';\nexport const read=(env:Env)=>${call};`,
        ),
      ],
    });
  }
  for (const [id, source] of [
    [
      "alias",
      "export const read=(env:Env)=>{const db=env.DB; return db.exec('DELETE FROM t')};",
    ],
    [
      "destructure",
      "export const read=(env:Env)=>{const {CACHE: cache}=env; return cache.put('k','v')};",
    ],
    [
      "this-env",
      "export class Store { constructor(private env:Env){} read(){return this.env.CACHE.put('k','v')} }",
    ],
    [
      "shadow-alias",
      "const db=env.DB; function read(db:unknown){return db.exec('DELETE FROM t')}",
    ],
    [
      "shadow-block",
      "const cache=env.CACHE; {const cache={put(){}}; cache.put()}",
    ],
    [
      "source-order",
      "export function read(env:Env){\n env.DB.prepare('SELECT 1');\n env.CACHE.put('k','v'); env.DB.exec('DELETE FROM t');\n}",
    ],
    ["same-line-order", "env.EVENTS.send({}); env.CACHE.put('k','v');"],
    [
      "nested-source-order",
      "outer(env.CACHE.put('a','b'), env.EVENTS.send({}));",
    ],
    [
      "utf16-column",
      "const emoji='😀'; env.CACHE.put('k','v'); env.DB.exec('DELETE FROM t');",
    ],
    ["empty", "// nothing to write\n"],
  ])
    add(id, { ...base, files: [text(source)] });
  add("unlisted", {
    ...base,
    files: [text("env.CACHE.put('k','v');", "not-listed.ts")],
  });
  add("missing-scope", {
    ...base,
    scope: "services/other",
    files: [text("env.CACHE.put('k','v');")],
  });
  add("no-worker", {
    ...base,
    repoRoot: noWorker,
    rules: { readAllowance: { [scope]: { driven: [file] } } },
    files: [text("env.CACHE.put('k','v');")],
  });
  add("no-data-bindings", {
    ...base,
    scope: "services/empty",
    rules: { readAllowance: { "services/empty": { driven: [file] } } },
    files: [text("env.CACHE.put('k','v');")],
  });
  add("nearest-worker", {
    ...base,
    rules: {
      ...rules,
      readAllowance: { [scope]: { driven: ["nested/read.ts"] } },
    },
    files: [
      text(
        "env.DB.exec('DELETE FROM t'); env.ONLY.put('k','v');",
        "nested/read.ts",
      ),
    ],
  });
  add("root-scope", {
    ...base,
    scope: ".",
    rules: { readAllowance: { ".": { driven: ["read.ts"] } } },
    files: [text("env.ROOT.put('k','v');", "read.ts")],
  });
  add("scope-prefix-is-a-segment", {
    ...base,
    scope: "services/api-sibling",
    rules: {
      readAllowance: { "services/api-sibling": { driven: ["read.ts"] } },
    },
    files: [text("env.CACHE.put('k','v');", "read.ts")],
  });
  const real: Record<string, string> = {
    [file]:
      "export const read=(env:Env)=>env.DB.prepare('SELECT * FROM orders');",
    [writeFile]:
      "export const write=(env:Env)=>\n env.DB.prepare('UPDATE orders SET sent=1');",
    "src/orders/adapters/driving/http.ts":
      "import { decide } from '@shop/kernel'; export {read} from '../driven/read';",
    "src/orders/adapters/driving/types.ts":
      "import type { Decision } from '@shop/kernel'; export {read} from '../driven/read';",
    "src/orders/adapters/driving/mixed.ts":
      "import { type Decision, decide } from '@shop/kernel'; export {read} from '../driven/read';",
    "src/orders/adapters/driving/side-effect.ts":
      "import '@shop/kernel'; export {read} from '../driven/read';",
    "src/orders/adapters/driving/dynamic.ts":
      "export const load=()=>import('@shop/kernel');",
    "src/orders/adapters/driving/util.ts":
      "import { value } from '@shop/util';",
    "src/orders/adapters/driving/free.ts": "import '@shop/free';",
    "src/orders/index.ts":
      "export {read} from './adapters/driven/read'; export const local=1;",
  };
  for (const [name, source] of Object.entries(real))
    put(`${scope}/${name}`, source);
  const realInput: Input = {
    ...base,
    files: Object.keys(real).map((file) => ({
      file,
      source: { kind: "file" },
    })),
  };
  add("real-worker-and-handlers", realInput, "code_graph.shape-reads");
  add(
    "real-omitted-decided-by",
    {
      ...realInput,
      rules: {
        ...rules,
        readAllowance: { [scope]: { driven: [file, writeFile] } },
      },
    },
    "code_graph.shape-reads",
  );
  add(
    "real-empty-decided-by",
    {
      ...realInput,
      rules: {
        ...rules,
        readAllowance: {
          [scope]: { driven: [file, writeFile], decidedBy: [] },
        },
      },
    },
    "code_graph.shape-reads",
  );
  add("real-disabled", { ...realInput, rules: {} }, "code_graph.shape-reads");
  for (const name of [
    "index.ts",
    "src/orders/index.ts/",
    "index.ts///",
    "/index.ts",
    "Index.ts",
    "index.tsx",
    "src\\index.ts",
    "x\ud800/index.ts",
    "index.ts?",
    "src/orders.ts",
  ]) {
    add(
      `entry-${JSON.stringify(name)}`,
      { ...base, files: [text("export const local=1;", name)] },
      "code_graph.shape-reads",
    );
  }
  add(
    "entry-disabled",
    {
      ...base,
      rules: { ...rules, applicationShape: [] },
      files: [text("export const local=1;", "index.ts")],
    },
    "code_graph.shape-reads",
  );
  add(
    "entry-clean",
    { ...base, files: [text("export { name } from './a';", "index.ts")] },
    "code_graph.shape-reads",
  );
  for (const [key, value] of [
    ["pureDependencies", ["{"]],
    ["testFiles", ["a}"]],
    ["compositionRoots", ["{"]],
  ]) {
    add(
      `invalid-glob-${key}`,
      { ...base, rules: { ...rules, [key as string]: value }, files: [] },
      "code_graph.shape-reads",
    );
  }
  add(
    "unparsed-with-allowance",
    {
      ...base,
      repoRoot: badRoot,
      rules: { readAllowance: { [scope]: { driven: [file] } } },
    },
    "code_graph.shape-reads",
  );
  add(
    "unparsed-disabled",
    { ...base, repoRoot: badRoot, rules: {} },
    "code_graph.shape-reads",
  );
  add(
    "refusal-before-glob",
    {
      ...base,
      repoRoot: badRoot,
      rules: {
        readAllowance: { [scope]: { driven: [] } },
        pureDependencies: ["{"],
      },
    },
    "code_graph.shape-reads",
  );
  const opaqueBase: Opaque = {
    repoRoot: root,
    rules,
    scope,
    modules: [
      { file, firstWrite: null },
      { file: writeFile, firstWrite: { binding: "DB", line: 2 } },
    ],
    loaded: [file, writeFile],
    importSpecifiers: ["@shop/kernel"],
    runtimeSpecifiers: ["@shop/kernel"],
    targets: ["not-listed.ts", file, writeFile, file, writeFile],
  };
  function opaque(id: string, input: Opaque) {
    cases.push({ id, operation: "code_graph.scoped-reads", input });
  }
  opaque("opaque-runtime", opaqueBase);
  opaque("opaque-no-runtime", { ...opaqueBase, runtimeSpecifiers: [] });
  opaque("opaque-runtime-with-no-edge", {
    ...opaqueBase,
    importSpecifiers: [],
  });
  opaque("opaque-other-type", {
    ...opaqueBase,
    importSpecifiers: ["@shop/util"],
    runtimeSpecifiers: ["@shop/util"],
  });
  opaque("opaque-undeclared-library", {
    ...opaqueBase,
    importSpecifiers: ["@shop/free"],
    runtimeSpecifiers: ["@shop/free"],
  });
  opaque("opaque-library-subpath", {
    ...opaqueBase,
    importSpecifiers: ["@shop/kernel/money"],
    runtimeSpecifiers: ["@shop/kernel/money"],
  });
  opaque("opaque-relative-is-outside", {
    ...opaqueBase,
    importSpecifiers: ["../../packages/kernel"],
    runtimeSpecifiers: ["../../packages/kernel"],
  });
  opaque("opaque-missing-scope", { ...opaqueBase, scope: "services/other" });
  opaque("opaque-disabled", {
    ...opaqueBase,
    rules: { ...kernel, readAllowance: {} },
  });
  opaque("opaque-omitted-decided-by", {
    ...opaqueBase,
    rules: { readAllowance: { [scope]: { driven: [file, writeFile] } } },
    importSpecifiers: [],
    runtimeSpecifiers: [],
  });
  opaque("opaque-empty-decided-by", {
    ...opaqueBase,
    rules: {
      ...kernel,
      readAllowance: { [scope]: { driven: [file, writeFile], decidedBy: [] } },
    },
  });
  opaque("opaque-write-even-unloaded", { ...opaqueBase, loaded: [] });
  opaque("opaque-unlisted-write", {
    ...opaqueBase,
    modules: [
      { file: "not-listed.ts", firstWrite: { binding: "EXTRA", line: 99 } },
    ],
  });
  opaque("opaque-duplicate-last-write", {
    ...opaqueBase,
    modules: [
      { file: writeFile, firstWrite: { binding: "FIRST", line: 1 } },
      { file, firstWrite: { binding: "MIDDLE", line: 3 } },
      { file: writeFile, firstWrite: { binding: "LAST", line: 9 } },
    ],
  });
  opaque("opaque-null-does-not-erase-write", {
    ...opaqueBase,
    modules: [
      { file: writeFile, firstWrite: { binding: "KEEP", line: 5 } },
      { file: writeFile, firstWrite: null },
    ],
  });
  opaque("opaque-dot-scope", {
    ...opaqueBase,
    scope: ".",
    rules: { readAllowance: { ".": { driven: [file, writeFile] } } },
  });
  const rawFile = `driven/\ud800.ts`;
  const rawScope = `services/\udfff`;
  opaque("opaque-raw-utf16", {
    ...opaqueBase,
    scope: rawScope,
    rules: {
      readAllowance: {
        [rawScope]: {
          driven: [rawFile, rawFile, "gone\ud800.ts"],
          decidedBy: ["kernel", "kernel"],
        },
      },
    },
    modules: [{ file: rawFile, firstWrite: { binding: "B\udfff", line: 1.5 } }],
    loaded: [rawFile],
    targets: [rawFile, "gone\ud800.ts", "other"],
  });
  for (const [id, line, rawLine] of [
    ["negative-zero", -0, "-0"],
    ["positive-infinity", Number.POSITIVE_INFINITY, "1e400"],
    ["negative-infinity", Number.NEGATIVE_INFINITY, "-1e400"],
  ] as const) {
    cases.push({
      id: `opaque-${id}`,
      operation: "code_graph.scoped-reads",
      rawLine,
      input: {
        ...opaqueBase,
        modules: [{ file: writeFile, firstWrite: { binding: "DB", line } }],
      },
    });
  }
  for (const selected of ["1", "2", "03", "hasOwnProperty", "toString"]) {
    opaque(`opaque-key-order-${selected}`, {
      ...opaqueBase,
      scope: selected,
      rules: {
        readAllowance: Object.fromEntries(
          ["2", "03", "1", "hasOwnProperty", "toString"].map((scope) => [
            scope,
            {
              driven: ["b.ts", "a.ts", "b.ts"],
              decidedBy: ["kernel", "kernel"],
            },
          ]),
        ),
      },
      modules: [],
      loaded: ["a.ts"],
      targets: ["b.ts", "a.ts"],
    });
  }
  opaque("opaque-proto-scope-dropped-at-validation", {
    ...opaqueBase,
    scope: "__proto__",
    rules: JSON.parse('{"readAllowance":{"__proto__":{"driven":["a.ts"]}}}'),
  });
  const catalog = loadBindingCatalog(root);
  assert.equal(catalog.manifests.length, 4);
  function reference(item: Case): unknown {
    try {
      const rules = BoundaryRulesSchema.parse(item.input.rules);
      const libraries = readLibraries(rules, item.input.repoRoot, undefined);
      if (libraries.kind !== "read") throw new Error(libraries.message);
      const catalog = loadBindingCatalog(item.input.repoRoot);
      if (item.operation === "code_graph.scoped-reads") {
        const input = opaqueSchema.parse(item.input);
        const allowance = readAllowanceOf(rules.readAllowance, catalog);
        const reads = scopeReadsOf(allowance, input.scope, input.modules);
        const verdict = drivenReadsOf(
          reads,
          {
            importEdges: input.importSpecifiers.map((specifier) => ({
              specifier,
            })),
            runtimeSpecifiers: new Set(input.runtimeSpecifiers),
          },
          libraries.libraries,
        );
        return {
          scopes: [...allowance.scopes].map(([scope, own]) => [
            scope,
            {
              driven: [...own.driven],
              decidedBy: own.decidedBy === null ? null : [...own.decidedBy],
            },
          ]),
          unknown: unknownDriven(allowance, input.scope, new Set(input.loaded)),
          reads:
            reads === null
              ? null
              : {
                  allowance: {
                    driven: [...reads.allowance.driven],
                    decidedBy:
                      reads.allowance.decidedBy === null
                        ? null
                        : [...reads.allowance.decidedBy],
                  },
                  writes: [...reads.writes],
                },
          verdicts: input.targets.map(verdict),
        };
      }
      const input = inputSchema.parse(item.input);
      const read = readShape(rules, catalog);
      if (read.kind === "refused") return read;
      const shape = read.shape;
      const held = input.files.map((file) => {
        const source =
          file.source.kind === "text"
            ? file.source.text
            : fs.readFileSync(
                path.join(
                  input.repoRoot,
                  input.scope === "."
                    ? file.file
                    : `${input.scope}/${file.file}`,
                ),
                "utf8",
              );
        const syntax = sourceUnit(source, file.file).syntax;
        const facts =
          item.operation === "code_graph.read-sites"
            ? {
                offendingForm: null,
                firstWrite: firstWrite(
                  shape.allowance,
                  input.scope,
                  file.file,
                  syntax,
                ),
              }
            : shapeFactsOf(shape, input.scope, file.file, syntax);
        return {
          file: file.file,
          ...facts,
          importEdges: importLiterals(syntax).map(({ specifier }) => ({
            specifier,
          })),
          runtimeSpecifiers: runtimeSpecifiers(syntax),
        };
      });
      const reads = scopeReadsOf(shape.allowance, input.scope, held);
      const matches = (globs: readonly RegExp[]) =>
        globs.map((glob) => input.probes.map((probe) => glob.test(probe)));
      return {
        shape: {
          kinds: [...shape.kinds],
          mayImport: [...shape.mayImport],
          pure: matches(shape.pure),
          tests: matches(shape.tests),
          roots: matches(shape.roots),
          scopes: [...shape.allowance.scopes].map(([scope, own]) => [
            scope,
            {
              driven: [...own.driven],
              decidedBy: own.decidedBy === null ? null : [...own.decidedBy],
            },
          ]),
        },
        unknown: unknownDriven(
          shape.allowance,
          input.scope,
          new Set(input.files.map((file) => file.file)),
        ),
        facts: held.map(({ offendingForm, firstWrite }) => ({
          offendingForm,
          firstWrite,
        })),
        reads:
          reads === null
            ? null
            : {
                allowance: {
                  driven: [...reads.allowance.driven],
                  decidedBy:
                    reads.allowance.decidedBy === null
                      ? null
                      : [...reads.allowance.decidedBy],
                },
                writes: [...reads.writes],
              },
        verdicts: held.map((module) =>
          input.targets.map(drivenReadsOf(reads, module, libraries.libraries)),
        ),
      };
    } catch (error) {
      if (error instanceof Error)
        return { name: error.name, message: error.message };
      throw error;
    }
  }
  const expected = cases.map((item) =>
    JSON.parse(JSON.stringify(reference(item))),
  );
  assert.equal(new Set(cases.map((item) => item.id)).size, cases.length);
  const byId = (id: string) =>
    expected[cases.findIndex((item) => item.id === id)];
  assert.deepEqual(byId("source-order").facts[0].firstWrite, {
    binding: "CACHE",
    line: 3,
  });
  assert.deepEqual(byId("same-line-order").facts[0].firstWrite, {
    binding: "EVENTS",
    line: 1,
  });
  assert.equal(byId("d1-nonliteral").facts[0].firstWrite, null);
  assert.deepEqual(byId("nearest-worker").facts[0].firstWrite, {
    binding: "ONLY",
    line: 1,
  });
  assert.deepEqual(byId("real-worker-and-handlers").facts[1].firstWrite, {
    binding: "DB",
    line: 2,
  });
  assert.deepEqual(byId("real-worker-and-handlers").verdicts[2][0], {
    licensed: true,
  });
  assert.deepEqual(byId("real-worker-and-handlers").verdicts[3][0], {
    licensed: false,
  });
  assert.deepEqual(byId("opaque-duplicate-last-write").verdicts[2], {
    licensed: false,
    write: { file: `${scope}/${writeFile}`, binding: "LAST", line: 9 },
  });
  const invalid = [
    { id: "unknown-operation", operation: "unknown", input: base },
    {
      id: "unknown-field",
      operation: "code_graph.shape-reads",
      input: { ...base, ignored: true },
    },
    {
      id: "missing-scope",
      operation: "code_graph.shape-reads",
      input: { repoRoot: root, rules: {}, files: [], targets: [], probes: [] },
    },
    {
      id: "wrong-source-tag",
      operation: "code_graph.shape-reads",
      input: { ...base, files: [{ file, source: { kind: "mystery" } }] },
    },
    {
      id: "null-files",
      operation: "code_graph.shape-reads",
      input: { ...base, files: null },
    },
    {
      id: "missing-write-fact",
      operation: "code_graph.scoped-reads",
      input: { ...opaqueBase, modules: [{ file }] },
    },
    {
      id: "bad-write-line",
      operation: "code_graph.scoped-reads",
      input: {
        ...opaqueBase,
        modules: [{ file, firstWrite: { binding: "DB", line: "1" } }],
      },
    },
    {
      id: "unknown-write-field",
      operation: "code_graph.scoped-reads",
      input: {
        ...opaqueBase,
        modules: [
          { file, firstWrite: { binding: "DB", line: 1, extra: true } },
        ],
      },
    },
    {
      id: "null-runtime-set",
      operation: "code_graph.scoped-reads",
      input: { ...opaqueBase, runtimeSpecifiers: null },
    },
  ];
  for (const item of invalid.filter((item) => item.operation !== "unknown")) {
    assert.equal(
      (item.operation === "code_graph.scoped-reads"
        ? opaqueSchema
        : inputSchema
      ).safeParse(item.input).success,
      false,
      item.id,
    );
  }
  const requests = [...cases, ...invalid];
  const requestText = (item: (typeof requests)[number]) => {
    const rawLine = "rawLine" in item ? item.rawLine : undefined;
    const raw = JSON.stringify({
      id: item.id,
      operation: item.operation,
      input: item.input,
    });
    return rawLine === undefined
      ? raw
      : raw.replace(/"line":(?:0|null)/, `"line":${rawLine}`);
  };
  const run = spawnSync(binary, {
    input: `${requests.map(requestText).join("\n")}\n`,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(run.status, 0, run.stderr);
  const replies = run.stdout
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
      source:
        "packages/code-graph/src/boundaries/zones/reads.ts and shape/shape.ts",
      native:
        "actual public Rust scoped-read and shape calls; file cases read shared disk sources and Wrangler configs",
    },
    caseCounts: Object.fromEntries(
      [
        "code_graph.read-sites",
        "code_graph.shape-reads",
        "code_graph.scoped-reads",
      ].map((operation) => [
        operation,
        cases.filter((item) => item.operation === operation).length,
      ]),
    ),
    cases: requests.map((item, index) => ({
      id: item.id,
      operation: item.operation,
      input: item.input,
      ...("rawLine" in item ? { rawLine: item.rawLine } : {}),
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
