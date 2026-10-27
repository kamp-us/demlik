import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { tsgoBinary } from "../../packages/code-graph/src/engine/tsgo.js";
import { assembleGraphWithEdges } from "../../packages/code-graph/src/extract/assemble.js";
import { loadEdgeProject } from "../../packages/code-graph/src/extract/project.js";
import { NodeKindRulesSchema } from "../../packages/code-graph/src/kinds/rules.js";
import {
  GraphSchema,
  ThresholdsSchema,
} from "../../packages/code-graph/src/schema.js";

const repository = fileURLToPath(new URL("../..", import.meta.url));
const inputSchema = z.strictObject({
  mode: z.enum(["callback", "default-text", "default-path"]),
  root: z.string(),
  repoRoot: z.string(),
  nativePreviewManifest: z.string(),
  kindRules: z.unknown(),
  afterLoad: z
    .array(z.strictObject({ file: z.string(), text: z.string() }))
    .default([]),
  crossRuntime: z.boolean(),
  kinds: z.boolean(),
});
type Input = z.infer<typeof inputSchema>;
const thrownSchema = z.strictObject({
  stage: z.enum(["load", "assembly"]),
  name: z.string(),
  message: z.string(),
  backendMethod: z.string().optional(),
});
const outcomeSchema = z.union([
  z.strictObject({ graph: GraphSchema }),
  z.strictObject({ thrown: thrownSchema }),
]);
const responseSchema = z
  .strictObject({
    graph: GraphSchema.optional(),
    thrown: thrownSchema.optional(),
    warnings: z.array(z.string()),
    order: z.array(z.enum(["warning", "graph", "throw"])),
    call: z.string(),
  })
  .refine((row) => (row.graph === undefined) !== (row.thrown === undefined));
const hash = (data: string | Buffer) =>
  createHash("sha256").update(data).digest("hex");
const backendMethod = (message: string) => {
  if (
    message.startsWith(
      "api: invalid request: failed to unmarshal *api.ParseConfigFileParams:",
    )
  )
    return "parseConfigFile";
  if (
    message.startsWith(
      "api: invalid request: failed to unmarshal *api.GetSourceFileParams:",
    )
  )
    return "getSourceFile";
  return undefined;
};
const terminal = (outcome: z.infer<typeof outcomeSchema>) =>
  "graph" in outcome ? "graph" : "throw";
const marker = "@@demlik-assembly-warning:";
function source(input: Input): z.infer<typeof outcomeSchema> {
  let stage: "load" | "assembly" = "load";
  try {
    const loaded = loadEdgeProject(input.root, "package", input.repoRoot);
    for (const change of input.afterLoad)
      fs.writeFileSync(
        path.join(loaded.rootAbsolute, change.file),
        change.text,
      );
    stage = "assembly";
    const graph = assembleGraphWithEdges(
      loaded,
      ThresholdsSchema.parse({}),
      "package",
      loaded.tsConfigPath,
      {
        crossRuntime: input.crossRuntime,
        kinds: input.kinds,
        reach: false,
        clusters: false,
        interfaceWidth: false,
        kindRules: NodeKindRulesSchema.parse(input.kindRules),
        repoRoot: input.repoRoot,
      },
    );
    return { graph };
  } catch (error) {
    assert.ok(error instanceof Error);
    const method = backendMethod(error.message);
    return {
      thrown: {
        stage,
        name: error.name,
        message: error.message,
        ...(method ? { backendMethod: method } : {}),
      },
    };
  }
}
if (process.argv[2] === "--reference") {
  const request = inputSchema.parse(
    JSON.parse(fs.readFileSync(process.argv[3], "utf8")),
  );
  const outcome = source(request);
  process.stderr.write(`${marker}${terminal(outcome)}\n`);
  fs.writeFileSync(process.argv[4], JSON.stringify(outcome));
} else {
  const binary = process.argv[2],
    reportFile = process.argv[3];
  assert.ok(
    binary && reportFile,
    "usage: graph-assembly-warning.mts <unit-test-executable> <report> [--ids names]",
  );
  assert.equal(process.version, "v22.21.1");
  assert.ok(process.versions.v8.startsWith("12.4."));
  assert.equal(
    process.env.CARGO_TARGET_DIR,
    undefined,
    "checks use their worktree's default target",
  );
  const idAt = process.argv.indexOf("--ids");
  const selected =
    idAt < 0 ? null : new Set(process.argv[idAt + 1]?.split(","));
  const directory = fs.mkdtempSync(
    path.join(path.dirname(reportFile), "assembly-warning-corpus-"),
  );
  const manifest = createRequire(
    path.join(repository, "packages/code-graph/package.json"),
  ).resolve("@typescript/native-preview/package.json");
  const compiler = await tsgoBinary();
  const loader = createRequire(import.meta.url).resolve("tsx");
  const config = '{"compilerOptions":{"strict":true,"types":[]}}\n';
  const plain = "export function run(){ return 1; }\n";
  const escaped =
    "export interface \\u0055 { value:number }\nexport const \\u0056=1;\nexport function run(){return 1;}\n";
  type Case = {
    id: string;
    input: Input;
    regexBackend?: true;
    rawBackend?: true;
  };
  const cases: Case[] = [];
  function fixture(
    id: string,
    files: Record<string, string>,
    mode: Input["mode"] = "callback",
  ) {
    const root = path.join(directory, "fixtures", id);
    fs.mkdirSync(root, { recursive: true });
    for (const [file, text] of Object.entries({
      "tsconfig.json": config,
      ...files,
    }))
      fs.writeFileSync(path.join(root, file), text);
    const row: Case = {
      id,
      input: {
        mode,
        root,
        repoRoot: root,
        nativePreviewManifest: manifest,
        kindRules: {},
        afterLoad: [],
        crossRuntime: true,
        kinds: true,
      },
    };
    cases.push(row);
    return row;
  }
  for (const mode of ["callback", "default-text", "default-path"] as const) {
    fixture(`quiet.${mode}`, { "ordinary.ts": plain }, mode);
    fixture(`declarations.${mode}`, { "escaped.ts": escaped }, mode);
    const both = fixture(`both.${mode}`, { "escaped.ts": escaped }, mode);
    both.input.afterLoad.push({
      file: "escaped.ts",
      text: `// edited after load\n${escaped}`,
    });
    const failed = fixture(
      `function-before-error.${mode}`,
      {
        "case.ts": plain,
        "wrangler.json": '{"name":"worker","vars":{"constructor":null}}\n',
      },
      mode,
    );
    failed.input.afterLoad.push({
      file: "case.ts",
      text: `// edited after load\n${plain}`,
    });
  }
  for (const count of [1, 5, 6, 9]) {
    const functions = Array.from(
      { length: count },
      (_, i) => `export function f${i}(){return ${i};}`,
    ).join("\n");
    const declarations = Array.from(
      { length: count },
      (_, i) => `export const \\u00${(65 + i).toString(16)}=${i};`,
    ).join("\n");
    const fn = fixture(`function-count-${count}`, {
      "functions.ts": `${functions}\n`,
    });
    fn.input.afterLoad.push({
      file: "functions.ts",
      text: `// edited after load\n${functions}\n`,
    });
    fixture(`declaration-count-${count}`, {
      "declarations.ts": `${declarations}\n`,
    });
  }
  fixture("three-module-decision-graph", {
    "limits.ts":
      "export const LIMIT=3;\nexport interface \\u0055 { value:number }\n",
    "helpers.ts":
      "export function choose(n:number,max:number) { return n>=max?'stop':'retry'; }\n",
    "entry.ts":
      "import {LIMIT} from './limits.js';\nimport {choose} from './helpers.js';\nexport function run() { return choose(1,LIMIT); }\n",
  });
  const unicode = fixture("unicode-order", {
    "Ω-𐀀.ts": escaped,
    "a.ts": escaped,
  });
  unicode.input.afterLoad.push({
    file: "Ω-𐀀.ts",
    text: `// edited after load\n${escaped}`,
  });
  fixture("raw-warning-newline-tab-file", { "line\n\tΩ.ts": escaped });
  const disabled = fixture("disabled-analysis", {
    "escaped.ts": escaped,
    "wrangler.json": '{"name":"worker","vars":{"constructor":null}}\n',
  });
  disabled.input.crossRuntime = false;
  disabled.input.kinds = false;
  const late = fixture("declaration-before-kind-error", {
    "escaped.ts": escaped,
  });
  late.input.kindRules = { entryNames: { invalid: ["["] } };
  late.regexBackend = true;
  const raw = fixture("raw-config", { "case.ts": plain });
  const rawRoot = path.join(raw.input.root, "raw�");
  fs.mkdirSync(rawRoot);
  fs.writeFileSync(path.join(rawRoot, "tsconfig.json"), config);
  fs.writeFileSync(path.join(rawRoot, "case.ts"), plain);
  raw.input.root = path.join(raw.input.root, "raw\ud800");
  raw.rawBackend = true;
  const replaced = fixture("replacement-config", { "case.ts": plain });
  const replacedRoot = path.join(replaced.input.root, "raw�");
  fs.mkdirSync(replacedRoot);
  fs.writeFileSync(path.join(replacedRoot, "tsconfig.json"), config);
  fs.writeFileSync(path.join(replacedRoot, "case.ts"), plain);
  replaced.input.root = replacedRoot;
  const rawSource = fixture("raw-source", { "case.ts": plain });
  const child = path.join(rawSource.input.root, "raw�");
  fs.mkdirSync(child);
  fs.writeFileSync(path.join(child, "case.ts"), plain);
  rawSource.input.root = path.join(rawSource.input.root, "raw\ud800");
  rawSource.rawBackend = true;
  const rawReplacement = fixture("replacement-source", { "case.ts": plain });
  const replacementChild = path.join(rawReplacement.input.root, "raw�");
  fs.mkdirSync(replacementChild);
  fs.writeFileSync(path.join(replacementChild, "case.ts"), plain);
  rawReplacement.input.root = replacementChild;
  const missing = fixture("missing-config", { "case.ts": plain });
  fs.unlinkSync(path.join(missing.input.root, "tsconfig.json"));
  function snapshot(
    root: string,
  ): Record<string, { bytes: string; mode: number }> {
    const out: Record<string, { bytes: string; mode: number }> = {};
    function visit(dir: string) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) visit(file);
        else if (entry.isFile())
          out[path.relative(root, file)] = {
            bytes: fs.readFileSync(file).toString("base64"),
            mode: fs.statSync(file).mode & 0o777,
          };
      }
    }
    visit(root);
    return out;
  }
  function restore(root: string, before: ReturnType<typeof snapshot>) {
    for (const [file, row] of Object.entries(before)) {
      fs.writeFileSync(path.join(root, file), Buffer.from(row.bytes, "base64"));
      fs.chmodSync(path.join(root, file), row.mode);
    }
  }
  function native(request: unknown, name: string) {
    const folder = path.join(directory, "runs", name);
    fs.mkdirSync(folder, { recursive: true });
    const input = path.join(folder, "request.json"),
      output = path.join(folder, "native.json");
    fs.writeFileSync(input, JSON.stringify(request));
    const run = spawnSync(
      binary,
      [
        "--exact",
        "extract::assemble::warning_tests::observes_requested_assembly",
        "--nocapture",
      ],
      {
        cwd: repository,
        env: {
          ...process.env,
          DEMLIK_ASSEMBLY_WARNING_REQUEST: input,
          DEMLIK_ASSEMBLY_WARNING_REPORT: output,
        },
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
      },
    );
    fs.writeFileSync(
      path.join(folder, "native-process.json"),
      JSON.stringify(
        {
          status: run.status,
          signal: run.signal,
          error: run.error?.message,
          stdout: run.stdout,
          stderr: run.stderr,
        },
        null,
        2,
      ),
    );
    assert.equal(
      run.status,
      0,
      `native observer process: ${name}: ${run.stderr}`,
    );
    return {
      value: JSON.parse(fs.readFileSync(output, "utf8")),
      stderr: run.stderr,
      folder,
      input,
    };
  }
  const rows = [],
    failures = [];
  for (const test of cases.filter(
    (test) => selected === null || selected.has(test.id),
  )) {
    const before = snapshot(test.input.repoRoot);
    const folder = path.join(directory, "runs", test.id);
    fs.mkdirSync(folder, { recursive: true });
    const request = path.join(folder, "source-request.json"),
      output = path.join(folder, "source.json");
    fs.writeFileSync(request, JSON.stringify(test.input));
    const reference = spawnSync(
      process.execPath,
      [
        "--import",
        loader,
        fileURLToPath(import.meta.url),
        "--reference",
        request,
        output,
      ],
      {
        cwd: repository,
        env: { ...process.env, TSX_DISABLE_CACHE: "1" },
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
      },
    );
    assert.equal(
      reference.status,
      0,
      `Source child: ${test.id}: ${reference.stderr}`,
    );
    const expected = outcomeSchema.parse(
      JSON.parse(fs.readFileSync(output, "utf8")),
    );
    const end = `${marker}${terminal(expected)}\n`;
    assert.ok(reference.stderr.endsWith(end));
    const sourceWarnings = reference.stderr.slice(0, -end.length);
    const sourceAfter = snapshot(test.input.repoRoot);
    restore(test.input.repoRoot, before);
    const nativeBefore = snapshot(test.input.repoRoot);
    assert.deepEqual(nativeBefore, before);
    const run = native(test.input, test.id);
    const response = responseSchema.parse(run.value);
    const actual = outcomeSchema.parse(
      response.graph === undefined
        ? { thrown: response.thrown }
        : { graph: response.graph },
    );
    const nativeWarnings =
      test.input.mode === "callback" ? response.warnings.join("") : run.stderr;
    const count = [
      ...sourceWarnings.matchAll(
        /code-graph: warning: \d+ (?:function|declaration)\(s\)/g,
      ),
    ].length;
    const expectedOrder = [
      ...Array.from({ length: count }, () => "warning"),
      terminal(expected),
    ];
    const nativeOrder =
      test.input.mode === "callback"
        ? response.order
        : [
            ...Array.from(
              {
                length: [
                  ...nativeWarnings.matchAll(
                    /code-graph: warning: \d+ (?:function|declaration)\(s\)/g,
                  ),
                ].length,
              },
              () => "warning",
            ),
            terminal(actual),
          ];
    const nativeAfter = snapshot(test.input.repoRoot);
    let failure: string | undefined, qualification: string | undefined;
    try {
      assert.deepEqual(
        nativeAfter,
        sourceAfter,
        "real fixture byte/mode deltas",
      );
      assert.equal(
        nativeWarnings,
        sourceWarnings,
        "complete warning bytes/order",
      );
      assert.deepEqual(
        nativeOrder,
        expectedOrder,
        "callback before completion/error",
      );
      try {
        assert.deepEqual(actual, expected);
      } catch (error) {
        if (test.rawBackend && "thrown" in actual && "thrown" in expected) {
          assert.equal(actual.thrown.stage, expected.thrown.stage);
          assert.equal(actual.thrown.name, expected.thrown.name);
          assert.equal(
            actual.thrown.backendMethod,
            expected.thrown.backendMethod,
          );
          const suffix = (text: string) =>
            text.replace(/after offset \d+$/, "after offset <backend>");
          assert.deepEqual(
            { ...actual.thrown, message: suffix(actual.thrown.message) },
            { ...expected.thrown, message: suffix(expected.thrown.message) },
          );
          qualification =
            "actual Go request byte offset differs; operation/raw error retained";
        } else if (
          test.regexBackend &&
          "thrown" in actual &&
          "thrown" in expected
        ) {
          assert.equal(actual.thrown.stage, expected.thrown.stage);
          assert.equal(actual.thrown.name, "SyntaxError");
          assert.equal(expected.thrown.name, "SyntaxError");
          assert.ok(
            actual.thrown.message.length && expected.thrown.message.length,
          );
          qualification =
            "established native/JS regex backend diagnostic wording; warning bytes/order exact";
        } else throw error;
      }
    } catch (error) {
      failure = String(error);
      failures.push({ id: test.id, message: failure });
    }
    rows.push({
      id: test.id,
      input: test.input,
      passed: failure === undefined,
      qualification,
      failure,
      source: expected,
      native: actual,
      sourceWarnings,
      nativeWarnings,
      expectedOrder,
      nativeOrder,
      nativeCall: response.call,
      before,
      sourceAfter,
      nativeBefore,
      nativeAfter,
    });
    fs.writeFileSync(
      path.join(folder, "source-process.json"),
      JSON.stringify(
        {
          status: reference.status,
          stdout: reference.stdout,
          stderr: reference.stderr,
        },
        null,
        2,
      ),
    );
  }
  const controls: [string, unknown][] = [
    ["missing-root", { mode: "callback" }],
    ["unknown-field", { ...cases[0].input, unknown: true }],
    ["wrong-mode", { ...cases[0].input, mode: "invented" }],
    ["wrong-kind-flag", { ...cases[0].input, kinds: "true" }],
    [
      "unsafe-after-load",
      {
        ...cases[0].input,
        afterLoad: [{ file: "../outside.ts", text: "never" }],
      },
    ],
  ];
  const rejected = controls.map(([name, request]) => ({
    id: name,
    response: native(request, `invalid-${name}`).value,
  }));
  for (const row of rejected)
    assert.ok(
      z
        .strictObject({
          protocol: z.strictObject({ message: z.string().min(1) }),
        })
        .safeParse(row.response).success,
    );
  const validThrownResponse = {
    thrown: { stage: "assembly", name: "Error", message: "refused" },
    warnings: [],
    order: ["throw"],
    call: "consumer",
  };
  const malformed = [
    { warnings: [], order: ["graph"], call: "consumer" },
    { ...validThrownResponse, unknown: true },
    {
      ...validThrownResponse,
      thrown: { stage: "invented", name: "Error", message: "bad" },
    },
    { ...validThrownResponse, order: ["invented"] },
  ];
  for (const value of malformed)
    assert.equal(responseSchema.safeParse(value).success, false);
  const report = {
    sourcePin: "75de37ea01a81cd7949e6275b7ee9cfdeb4e312d",
    reference: {
      node: process.version,
      v8: process.versions.v8,
      compiler: { ...compiler, sha256: hash(fs.readFileSync(compiler.path)) },
    },
    passed: rows.filter((row) => row.passed).length,
    unqualifiedPairs: rows.filter(
      (row) => row.passed && row.qualification === undefined,
    ).length,
    qualifiedPairs: rows.filter(
      (row) => row.passed && row.qualification !== undefined,
    ).length,
    rejectedInvalidInputs: rejected.length,
    responseGuards: malformed.length,
    failures,
    cases: rows,
    protocol: rejected,
    directory,
    nativeExecutable: { path: binary, sha256: hash(fs.readFileSync(binary)) },
    scope:
      "in-crate intended-visibility assembly warning consumer; default text/Path public controls; no CLI dispatch/capability closure",
  };
  fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    JSON.stringify({
      passed: report.passed,
      qualified: report.qualifiedPairs,
      failures: failures.length,
      rejected: rejected.length,
    }),
  );
  if (failures.length) process.exitCode = 1;
}
