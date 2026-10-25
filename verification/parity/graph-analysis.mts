import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import * as ts from "../../packages/code-graph/src/engine/tsgo.js";
import { assembleGraphWithEdges } from "../../packages/code-graph/src/extract/assemble.js";
import {
  packageName,
  packageSourceEntry,
  publicExportPatterns,
  readManifest,
} from "../../packages/code-graph/src/extract/package-exports.js";
import { loadEdgeProject } from "../../packages/code-graph/src/extract/project.js";
import { GlobSyntaxError } from "../../packages/code-graph/src/kinds/glob.js";
import { NodeKindRulesSchema } from "../../packages/code-graph/src/kinds/rules.js";
import {
  GraphSchema,
  ThresholdsSchema,
} from "../../packages/code-graph/src/schema.js";
import { writeFakePackages } from "../../packages/code-graph/src/test-helpers/fake-packages.js";

const binary = process.argv[2];
assert.ok(
  binary,
  "usage: node --import tsx graph-analysis.mts <native-driver> [evidence.json]",
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
const analysisSchema = z.strictObject({
  crossRuntime: z.boolean().default(false),
  kinds: z.boolean().default(false),
  reach: z.boolean().default(false),
  clusters: z.boolean().default(false),
  interfaceWidth: z.boolean().default(false),
  kindRules: z.unknown().default({}),
});
const inputSchema = z.strictObject({
  root: z.string(),
  repoRoot: z.string().optional(),
  scope: z.enum(["package", "deep"]).optional(),
  headers: z.boolean().default(false),
  thresholds: ThresholdsSchema.default(() => ThresholdsSchema.parse({})),
  analysis: analysisSchema,
  packageDirs: z.array(z.string()).default([""]),
  patternFiles: z.array(z.string()).default([]),
});
type Input = z.infer<typeof inputSchema>;
type Case = { id: string; operation: "code_graph.analysis"; input: Input };
const issueSchema = z.object({
  path: z.array(z.union([z.string(), z.number()])),
  message: z.string(),
});
const responseSchema = z.object({
  id: z.string().nullable(),
  ok: z.boolean(),
  output: z.unknown().optional(),
  error: z
    .object({
      kind: z.string(),
      message: z.string(),
      issue: issueSchema.optional(),
    })
    .optional(),
  observedCalls: z.array(z.string()),
});
type Response = z.infer<typeof responseSchema>;
const outputSchema = z.object({
  graph: GraphSchema,
  packages: z.array(
    z.object({
      dir: z.string(),
      manifest: z.unknown(),
      name: z.string().nullable(),
      sourceEntry: z.string().nullable(),
    }),
  ),
  patternFiles: z.array(z.string()),
  patternMatches: z.array(z.array(z.boolean())),
});
const root = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "demlik-analysis-parity-")),
);
const cases: Case[] = [];
const all = {
  crossRuntime: true,
  kinds: true,
  reach: true,
  clusters: true,
  interfaceWidth: true,
};
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
      include: ["**/*.ts", "**/*.tsx"],
    }),
  );
}
function add(id: string, dir: string, options: Partial<Input> = {}): void {
  cases.push({
    id,
    operation: "code_graph.analysis",
    input: inputSchema.parse({
      root: path.join(root, dir),
      analysis: all,
      ...options,
    }),
  });
}
function reference(item: Case): Response {
  try {
    const input = item.input;
    const parsed = NodeKindRulesSchema.safeParse(input.analysis.kindRules);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      return {
        id: item.id,
        ok: false,
        observedCalls: [],
        error: {
          kind: "schema-issue",
          message: first.message,
          issue: {
            path: first.path.map((part) =>
              typeof part === "number" ? part : String(part),
            ),
            message: first.message,
          },
        },
      };
    }
    const repoRoot = input.repoRoot ?? input.root;
    const loaded = loadEdgeProject(
      input.root,
      input.scope ?? "package",
      repoRoot,
    );
    const graph = GraphSchema.parse(
      assembleGraphWithEdges(
        loaded,
        input.thresholds,
        loaded.scope,
        loaded.tsConfigPath,
        { ...input.analysis, kindRules: parsed.data, repoRoot },
        null,
        { headers: input.headers },
      ),
    );
    const packages = input.packageDirs.map((dir) => {
      const manifest = readManifest(repoRoot, dir);
      return {
        dir,
        manifest,
        name: manifest === null ? null : packageName(manifest),
        sourceEntry: packageSourceEntry(repoRoot, dir),
      };
    });
    const patterns = publicExportPatterns(
      repoRoot,
      input.root,
      input.packageDirs,
    );
    const patternFiles = [
      ...graph.modules.map((module) => module.file),
      ...input.patternFiles,
    ];
    const output = JSON.parse(
      JSON.stringify({
        graph,
        packages,
        patternFiles,
        patternMatches: patterns.map((pattern) =>
          patternFiles.map((file) => pattern.test(file)),
        ),
      }),
    );
    return { id: item.id, ok: true, output, observedCalls: [] };
  } catch (error) {
    return {
      id: item.id,
      ok: false,
      observedCalls: [],
      error: {
        kind:
          error instanceof GlobSyntaxError
            ? "glob-error"
            : error instanceof TypeError
              ? "type-error"
              : error instanceof SyntaxError
                ? "regex-error"
                : "backend-error",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}
try {
  config("app");
  write(
    "app/package.json",
    '{"name":"app","exports":{".":"./dist/public.js"}}',
  );
  write("app/wrangler.json", '{"name":"worker","main":"src/entry.ts"}');
  write(
    "app/src/entry.ts",
    "import { writeRecord } from './store';\nexport function fetch() { return writeRecord(); }\n",
  );
  write(
    "app/src/store.ts",
    "import { db } from 'drizzle-orm';\nexport function writeRecord() { return db.insert('t'); }\nexport function dead() { return 0; }\n",
  );
  write("app/src/public.ts", "export function apiHelper() { return 0; }\n");
  writeFakePackages(path.join(root, "app"));
  for (let mask = 0; mask < 32; mask++) {
    const flags = {
      crossRuntime: !!(mask & 1),
      kinds: !!(mask & 2),
      reach: !!(mask & 4),
      clusters: !!(mask & 8),
      interfaceWidth: !!(mask & 16),
      kindRules: {},
    };
    add(`all-analysis-flag-combinations-${mask}`, "app", {
      analysis: flags,
      headers: true,
      patternFiles: ["src/public.tsx", "src/other.ts"],
    });
  }
  fs.cpSync(path.join(root, "app"), path.join(root, "custom"), {
    recursive: true,
  });
  write(
    "custom/src/jobs.ts",
    "import { writeRecord } from './store';\nexport function dispatch() { return writeRecord(); }\n",
  );
  add("custom-rules-and-entry-reach-are-used-by-assembly", "custom", {
    analysis: {
      ...all,
      kindRules: {
        entryNames: { "custom-job": ["^dispatch$"] },
        entryReach: { "service-binding": ["^custom-job$"] },
      },
    },
  });
  config("mains");
  write("mains/wrangler.json", String.raw`{"main":"\ud800/../src/entry.ts"}`);
  write("mains/src/entry.ts", "export function entry() { return 1; }\n");
  write("mains/src/other.ts", "export function other() { return 2; }\n");
  add(
    "worker-main-normalizes-raw-utf16-before-public-surface-comparison",
    "mains",
    {
      analysis: {
        crossRuntime: true,
        kinds: false,
        reach: true,
        clusters: false,
        interfaceWidth: false,
        kindRules: {},
      },
    },
  );
  config("retained-main");
  write("retained-main/wrangler.json", String.raw`{"main":"src/\ud800.ts"}`);
  write(
    "retained-main/src/\ufffd.ts",
    "export function retained() { return 1; }\n",
  );
  add(
    "unpaired-worker-main-does-not-match-replacement-character-module",
    "retained-main",
  );
  config("manifest");
  write(
    "manifest/pkg/package.json",
    String.raw`{"__proto__":{"name":"inherited","main":"./dist/public.js"},"exports":{"10":"./dist/second.d.ts","2":"./dist/first.mjs","nested":{"__proto__":"./dist/raw.cjs"},"wildcard":"./dist/*.js","raw":"./\ud800/../src/valid.js"},"overflow":1e400}`,
  );
  for (const [index, file] of [
    "public",
    "first",
    "second",
    "raw",
    "valid",
  ].entries())
    write(
      `manifest/pkg/src/${file}.ts`,
      `export function f${index}() { return ${index}; }\n`,
    );
  write(
    "manifest/raw/package.json",
    String.raw`{"name":"\ud800","main":"src/\ud800.js","exports":{"./wild":"./dist/a[+?^$(){}]\\\\*.js","./line":"./dist/line\n*.js","./suffix":"./dist/no.js\n"}}`,
  );
  write("manifest/raw/src/\ufffd.ts", "export function raw() { return 0; }\n");
  for (const [dir, text] of [
    ["bad", "{"],
    ["array", "[]"],
    ["null", "null"],
    ["primitive", "1"],
    ["bom", "\ufeff{}"],
    ["empty", "{}"],
    ["null-proto", '{"__proto__":null,"name":"ok"}'],
    ["primitive-proto", '{"__proto__":1,"name":"ok"}'],
    ["plain", '{"name":"","main":"src/missing.js"}'],
  ] as const)
    write(`manifest/${dir}/package.json`, text);
  add(
    "package-reader-root-copy-numeric-key-order-raw-paths-and-malformed-manifests",
    "manifest",
    {
      packageDirs: [
        "pkg",
        "raw",
        "bad",
        "array",
        "null",
        "primitive",
        "bom",
        "empty",
        "null-proto",
        "primitive-proto",
        "plain",
        "missing",
      ],
      patternFiles: [
        "pkg/src/other.tsx",
        "raw/src/\ud800.ts",
        "raw/src/\ufffd.ts",
        "raw/src/a[+?^$(){}]\\\\tail.ts",
        "raw/src/line\nnext.ts",
        "raw/src/no.ts\n",
      ],
    },
  );
  config("workspace");
  write("workspace/package.json", '{"name":"workspace"}');
  write(
    "workspace/apps/app/package.json",
    '{"name":"app","exports":"./dist/public.js"}',
  );
  write(
    "workspace/apps/app/src/entry.ts",
    "import { helper } from '../../../packages/lib/src/index';\nexport function fetch() { return helper(); }\n",
  );
  write("workspace/apps/app/src/public.ts", "export function publicApi() {}\n");
  write(
    "workspace/packages/lib/package.json",
    '{"name":"lib","main":"./dist/index.js"}',
  );
  write("workspace/packages/lib/src/index.ts", "export function helper() {}\n");
  add(
    "workspace-scope-package-patterns-and-consumer-width",
    "workspace/apps/app",
    {
      repoRoot: path.join(root, "workspace"),
      scope: "deep",
      packageDirs: ["", "apps/app", "packages/lib"],
    },
  );
  config("next");
  write("next/package.json", '{"devDependencies":{"next":"*"}}');
  write(
    "next/app/[slug]/page.tsx",
    "function Home() { return <div/>; }\nexport default Home;\nexport function generateMetadata() { return {}; }\nexport function helper() {}\n",
  );
  add("framework-preset-entries-flow-through-complete-analysis", "next");
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
  writeFakePackages(path.join(root, "existing-worker"));
  add(
    "existing-worker-fixture-cross-runtime-reach-kinds-and-effects",
    "existing-worker",
    { headers: true },
  );
  config("malformed");
  write("malformed/good.ts", "export function fetch() {}\n");
  write("malformed/bad.ts", "export const = ;\n");
  add("malformed-typescript-remains-a-measured-parse-failure", "malformed");
  config("empty");
  add("empty-project-analysis-reports-remain-measured", "empty");
  config("throwing");
  write("throwing/wrangler.json", '{"vars":{"constructor":null}}');
  write("throwing/entry.ts", "export function fetch() {}\n");
  add(
    "cross-runtime-catalog-type-error-is-not-an-unmeasured-report",
    "throwing",
  );
  add("unrequested-cross-runtime-does-not-read-invalid-catalog", "throwing", {
    analysis: { ...all, crossRuntime: false, kindRules: {} },
  });
  add(
    "catalog-error-precedes-invalid-kind-regex-after-context-opens",
    "throwing",
    { analysis: { ...all, kindRules: { authNames: { bad: ["["] } } } },
  );
  add("kind-pattern-errors-remain-observable-with-all-flags-disabled", "app", {
    analysis: {
      crossRuntime: false,
      kinds: false,
      reach: false,
      clusters: false,
      interfaceWidth: false,
      kindRules: { authNames: { bad: ["["] } },
    },
  });
  add("unrequested-conventions-do-not-compile-invalid-glob", "app", {
    analysis: {
      crossRuntime: false,
      kinds: false,
      reach: false,
      clusters: false,
      interfaceWidth: false,
      kindRules: {
        entryExportConventions: { bad: { files: "{", exports: ["run"] } },
      },
    },
  });
  add("requested-convention-invalid-glob-remains-observable", "app", {
    analysis: {
      ...all,
      kindRules: {
        entryExportConventions: { bad: { files: "{", exports: ["run"] } },
      },
    },
  });
  add("invalid-kind-rules-report-first-schema-issue", "app", {
    analysis: { ...all, kindRules: { entryNames: [] } },
  });
  add("kind-record-constructor-null-remains-thrown-type-error", "app", {
    analysis: { ...all, kindRules: { entryNames: { constructor: null } } },
  });
  add("missing-project-configuration-remains-observable", "missing");
  for (const [id, directory] of [
    [
      "existing-core-fixture-complete-analysis",
      "test/parity/fixture/apps/core",
    ],
    ["actual-code-graph-source-complete-analysis", "src"],
  ] as const)
    cases.push({
      id,
      operation: "code_graph.analysis",
      input: inputSchema.parse({
        root: path.join(repo, "packages/code-graph", directory),
        analysis: all,
      }),
    });
  const expected = cases.map(reference);
  const full = outputSchema.parse(expected[31].output).graph;
  assert.equal(full.stats.functionCount, 4);
  assert.equal(full.stats.fileCount, 3);
  assert.equal(full.crossRuntime?.configFiles.length, 1);
  assert.equal(full.reachability?.reachableCount, 2);
  assert.deepEqual(
    full.reachability?.unreachable.map((row) => row.id),
    ["src/store.ts:dead"],
  );
  assert.deepEqual(
    full.reachability?.withheld.map((row) => row.id),
    ["src/public.ts:apiHelper"],
  );
  assert.equal(full.reachability?.unguarded.length, 1);
  assert.equal(full.interfaceWidth?.totalExports, 4);
  assert.equal(full.clusters?.clusteredFileCount, 2);
  for (let mask = 0; mask < 32; mask++) {
    const graph = outputSchema.parse(expected[mask].output).graph;
    assert.equal(graph.crossRuntime !== null, !!(mask & 1));
    assert.equal(
      graph.functions.every((node) => node.nodeKind !== null),
      !!(mask & 2),
    );
    assert.equal(graph.reachability !== null, !!(mask & 4));
    assert.equal(graph.clusters !== null, !!(mask & 8));
    assert.equal(graph.interfaceWidth !== null, !!(mask & 16));
    assert.equal(graph.data, null);
  }
  const manifestCase = outputSchema.parse(
    expected[
      cases.findIndex(
        (item) =>
          item.id ===
          "package-reader-root-copy-numeric-key-order-raw-paths-and-malformed-manifests",
      )
    ].output,
  );
  assert.equal(manifestCase.packages[0].name, "inherited");
  assert.equal(manifestCase.packages[0].sourceEntry, "pkg/src/first.ts");
  assert.equal(manifestCase.packages[1].sourceEntry, "raw/src/\ud800.ts");
  const invalid = [
    "not json",
    JSON.stringify({
      id: "missing-root",
      operation: "code_graph.analysis",
      input: { analysis: {} },
    }),
    JSON.stringify({
      id: "missing-analysis",
      operation: "code_graph.analysis",
      input: { root },
    }),
    JSON.stringify({
      id: "bad-flag",
      operation: "code_graph.analysis",
      input: { root, analysis: { reach: "yes" } },
    }),
    JSON.stringify({
      id: "unknown-analysis",
      operation: "code_graph.analysis",
      input: { root, analysis: { silentlyIgnored: true } },
    }),
    JSON.stringify({
      id: "unsupported",
      operation: "invented",
      input: { root, analysis: {} },
    }),
    JSON.stringify({
      id: "unknown-input",
      operation: "code_graph.analysis",
      input: { root, analysis: {}, silentlyIgnored: true },
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
    const returned = actual[index];
    assert.equal(
      returned.ok,
      answer.ok,
      `${cases[index].id}: ${JSON.stringify(returned.error)} / ${JSON.stringify(answer.error)}`,
    );
    if (answer.ok) {
      outputSchema.parse(returned.output);
      assert.deepEqual(returned.output, answer.output, cases[index].id);
      assert.ok(
        returned.observedCalls.includes(
          "demlik_code_graph::extract::assemble::assemble_graph_with_analysis",
        ),
      );
    } else {
      assert.equal(returned.error?.kind, answer.error?.kind, cases[index].id);
      assert.ok(returned.error?.message);
      if (answer.error?.kind !== "regex-error")
        assert.deepEqual(returned.error, answer.error, cases[index].id);
    }
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
      regexErrors:
        "category and nonempty backend detail compared; engine messages differ",
    },
    passed: cases.length,
    rejectedInvalidInputs: invalid.length,
    functions: expected
      .filter((answer) => answer.ok)
      .reduce(
        (sum, answer) =>
          sum + outputSchema.parse(answer.output).graph.stats.functionCount,
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
