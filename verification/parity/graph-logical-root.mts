import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  assembleGraph,
  assembleGraphWithEdges,
} from "../../packages/code-graph/src/extract/assemble.js";
import {
  loadCheapProject,
  loadEdgeProject,
} from "../../packages/code-graph/src/extract/project.js";
import { NodeKindRulesSchema } from "../../packages/code-graph/src/kinds/rules.js";
import { stableStringify } from "../../packages/code-graph/src/render/json.js";
import {
  GraphSchema,
  ThresholdsSchema,
} from "../../packages/code-graph/src/schema.js";

const repository = fileURLToPath(new URL("../..", import.meta.url));
const hash = (value: Buffer | string) =>
  createHash("sha256").update(value).digest("hex");
const inputSchema = z.strictObject({
  mode: z.enum(["text", "path", "cheap"]),
  root: z.string(),
  repoRoot: z.string(),
  nativePreviewManifest: z.string(),
});
type Input = z.infer<typeof inputSchema>;
const responseSchema = z.strictObject({
  graph: GraphSchema,
  loadedFiles: z.number().int().nonnegative(),
  direct: z.string(),
  pretty: z.string(),
  stable: z.string(),
  stablePretty: z.string(),
  valueError: z.string().nullable(),
  observedCalls: z.array(z.string()),
});
function source(input: Input) {
  const thresholds = ThresholdsSchema.parse({});
  if (input.mode === "cheap") {
    const loaded = loadCheapProject(input.root);
    return {
      graph: assembleGraph(loaded, thresholds),
      loadedFiles: loaded.sourceFiles.length,
    };
  }
  const loaded = loadEdgeProject(input.root, "package", input.repoRoot);
  const graph = assembleGraphWithEdges(
    loaded,
    thresholds,
    "package",
    loaded.tsConfigPath,
    {
      crossRuntime: false,
      kinds: false,
      reach: false,
      clusters: false,
      interfaceWidth: false,
      kindRules: NodeKindRulesSchema.parse({}),
      repoRoot: input.repoRoot,
    },
  );
  return { graph, loadedFiles: loaded.sourceFiles.length };
}
if (process.argv[2] === "--reference") {
  const input = inputSchema.parse(
    JSON.parse(fs.readFileSync(process.argv[3], "utf8")),
  );
  fs.writeFileSync(process.argv[4], JSON.stringify(source(input)));
} else {
  const binary = process.argv[2],
    reportFile = process.argv[3];
  assert.ok(
    binary && reportFile,
    "usage: graph-logical-root.mts <native-executable> <report> [--ids names]",
  );
  assert.equal(process.version, "v22.21.1");
  assert.equal(process.versions.v8, "12.4.254.21-node.33");
  assert.equal(process.env.CARGO_TARGET_DIR, undefined);
  const selectedAt = process.argv.indexOf("--ids");
  const selected =
    selectedAt < 0 ? null : new Set(process.argv[selectedAt + 1]?.split(","));
  fs.mkdirSync(path.dirname(reportFile), { recursive: true });
  const directory = fs.mkdtempSync(
    path.join(path.dirname(reportFile), "graph-root-corpus-"),
  );
  execFileSync("git", ["init", "--quiet", "--template=", directory]);
  const loader = createRequire(import.meta.url).resolve("tsx");
  const manifest = createRequire(
    path.join(repository, "packages/code-graph/package.json"),
  ).resolve("@typescript/native-preview/package.json");
  const config = '{"compilerOptions":{"strict":true,"types":[]}}\n';
  type Case = {
    id: string;
    input: Input;
    cwd: string;
    expectedFiles: number;
    raw: boolean;
    sentinel?: string;
  };
  const cases: Case[] = [];
  function add(
    id: string,
    root: string,
    repoRoot: string,
    mode: Input["mode"],
    expectedFiles: number,
    cwd = repository,
    sentinel?: string,
  ) {
    cases.push({
      id,
      input: { mode, root, repoRoot, nativePreviewManifest: manifest },
      cwd,
      expectedFiles,
      raw: /[\ud800-\udfff]/u.test(root),
      sentinel,
    });
  }
  const ordinary = path.join(directory, "ordinary");
  fs.mkdirSync(ordinary);
  for (const [name, content] of Object.entries({
    "tsconfig.json": config,
    "limits.ts": "export const LIMIT=3;\n",
    "helpers.ts":
      "export function choose(n:number,max:number){return n>=max?'stop':'retry';}\n",
    "entry.ts":
      "import {LIMIT} from './limits.js';import {choose} from './helpers.js';export function run(){return choose(1,LIMIT);}\n",
  }))
    fs.writeFileSync(path.join(ordinary, name), content);
  for (const mode of ["text", "path", "cheap"] as const) {
    add(`ordinary.${mode}`, ordinary, ordinary, mode, 3);
    add(`cwd.${mode}`, ordinary, ordinary, mode, 3, ordinary);
    if (mode === "cheap")
      add(
        "relative.cheap",
        path.relative(repository, ordinary),
        ordinary,
        mode,
        3,
      );
  }
  fs.mkdirSync(path.join(ordinary, "empty"));
  add("dot-segments.text", `${ordinary}/empty/../`, ordinary, "text", 3);
  for (const [id, suffix] of [
    ["high", "raw\ud800"],
    ["low", "raw\udfff"],
    ["pair", "raw𐀀"],
    ["replacement", "raw�"],
  ] as const) {
    const base = path.join(directory, id);
    fs.mkdirSync(base);
    fs.writeFileSync(path.join(base, "tsconfig.json"), config);
    fs.writeFileSync(path.join(base, ".gitignore"), "ignored/\n");
    const root = path.join(base, "ignored", suffix);
    fs.mkdirSync(root, { recursive: true });
    const sentinel = path.join(root, "must-not-load.ts");
    fs.writeFileSync(sentinel, "export function ignored(){return 9;}\n");
    assert.equal(
      execFileSync("git", ["rev-parse", "--show-toplevel"], {
        cwd: root,
        encoding: "utf8",
      }).trim(),
      directory,
    );
    assert.equal(
      execFileSync(
        "git",
        ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
        { cwd: root },
      ).length,
      0,
    );
    add(
      `ignored-empty-${id}.text`,
      root,
      base,
      "text",
      0,
      repository,
      sentinel,
    );
    if (id === "replacement" || id === "pair")
      add(
        `ignored-empty-${id}.path`,
        root,
        base,
        "path",
        0,
        repository,
        sentinel,
      );
  }
  // The two logical strings address the same existing native directory.
  const raw = cases.find((test) => test.id === "ignored-empty-high.text");
  assert.ok(raw);
  add(
    "same-native-replacement.text",
    raw.input.root.replace("\ud800", "�"),
    raw.input.repoRoot,
    "text",
    0,
    repository,
    raw.sentinel,
  );
  add(
    "same-native-replacement.path",
    raw.input.root.replace("\ud800", "�"),
    raw.input.repoRoot,
    "path",
    0,
    repository,
    raw.sentinel,
  );
  function snapshot() {
    const out: Record<
      string,
      { base64: string; sha256: string; mode: number }
    > = {};
    function walk(folder: string) {
      for (const name of fs.readdirSync(folder).sort()) {
        const file = path.join(folder, name),
          stat = fs.lstatSync(file);
        if (stat.isDirectory()) walk(file);
        else if (stat.isFile()) {
          const bytes = fs.readFileSync(file);
          out[path.relative(directory, file)] = {
            base64: bytes.toString("base64"),
            sha256: hash(bytes),
            mode: stat.mode & 0o777,
          };
        }
      }
    }
    walk(directory);
    return out;
  }
  const rows = [],
    failures = [];
  for (const test of cases.filter(
    (test) => selected === null || selected.has(test.id),
  )) {
    // Process reports stay outside the fixture snapshot.
    const observationFolder = `${directory}-observations/${test.id}`;
    fs.mkdirSync(observationFolder, { recursive: true });
    const request = path.join(observationFolder, "input.json"),
      sourceFile = path.join(observationFolder, "source.json");
    fs.writeFileSync(request, JSON.stringify(test.input));
    const before = snapshot();
    const reference = spawnSync(
      process.execPath,
      [
        "--import",
        loader,
        fileURLToPath(import.meta.url),
        "--reference",
        request,
        sourceFile,
      ],
      {
        cwd: test.cwd,
        encoding: "utf8",
        env: { ...process.env, TSX_DISABLE_CACHE: "1" },
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    const sourceAfter = snapshot();
    const native = spawnSync(binary, [], {
      cwd: test.cwd,
      input: JSON.stringify(test.input),
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    const nativeAfter = snapshot();
    fs.writeFileSync(
      path.join(observationFolder, "processes.json"),
      JSON.stringify({ reference, native }, null, 2),
    );
    let expected: ReturnType<typeof source> | undefined,
      actual: z.infer<typeof responseSchema> | undefined,
      failure: string | undefined;
    try {
      assert.equal(reference.status, 0, reference.stderr);
      assert.equal(native.status, 0, native.stderr);
      assert.equal(reference.stderr, "");
      assert.equal(native.stderr, "");
      expected = z
        .strictObject({
          graph: GraphSchema,
          loadedFiles: z.number().int().nonnegative(),
        })
        .parse(JSON.parse(fs.readFileSync(sourceFile, "utf8")));
      actual = responseSchema.parse(JSON.parse(native.stdout));
      assert.equal(
        expected.loadedFiles,
        test.expectedFiles,
        "independent listed-file count",
      );
      assert.equal(
        actual.loadedFiles,
        test.expectedFiles,
        "native listed-file count",
      );
      assert.equal(actual.graph.stats.fileCount, test.expectedFiles);
      assert.equal(
        actual.graph.root,
        path.relative(test.cwd, path.resolve(test.cwd, test.input.root)) || ".",
        "logical root before UTF8 encoding",
      );
      assert.deepEqual(actual.graph, expected.graph);
      for (const wire of [
        actual.direct,
        actual.pretty,
        actual.stable,
        actual.stablePretty,
      ])
        assert.deepEqual(GraphSchema.parse(JSON.parse(wire)), expected.graph);
      assert.ok(
        actual.direct.startsWith(
          `{"root":${JSON.stringify(expected.graph.root)},`,
        ),
        "exact raw root JSON scalar bytes",
      );
      assert.equal(actual.stable, stableStringify(expected.graph, false));
      assert.equal(actual.stablePretty, stableStringify(expected.graph, true));
      assert.equal(
        actual.valueError !== null,
        test.raw,
        "serde_json::Value cannot hold lone UTF16",
      );
      if (test.sentinel)
        assert.ok(fs.readFileSync(test.sentinel, "utf8").includes("ignored"));
      assert.deepEqual(
        sourceAfter,
        before,
        "Source byte/mode snapshot is unchanged",
      );
      assert.deepEqual(
        nativeAfter,
        sourceAfter,
        "native byte/mode snapshot is unchanged",
      );
      assert.ok(
        actual.observedCalls.includes(
          test.input.mode === "text"
            ? "demlik_code_graph::extract::assemble::assemble_graph_with_analysis_text"
            : test.input.mode === "path"
              ? "demlik_code_graph::extract::assemble::assemble_graph_with_analysis"
              : "demlik_code_graph::extract::assemble::assemble_graph",
        ),
      );
    } catch (error) {
      failure = String(error);
      failures.push({ id: test.id, message: failure });
    }
    rows.push({
      id: test.id,
      input: test.input,
      cwd: test.cwd,
      expectedFiles: test.expectedFiles,
      raw: test.raw,
      passed: failure === undefined,
      failure,
      source: expected,
      native: actual,
      before,
      sourceAfter,
      nativeAfter,
      observationFolder,
    });
  }
  const invalid = [
    "not JSON",
    "{}",
    JSON.stringify({ ...raw.input, extra: true }),
    JSON.stringify({ ...raw.input, root: 7 }),
  ].map((input) => {
    const run = spawnSync(binary, [], {
      cwd: repository,
      input,
      encoding: "utf8",
    });
    assert.notEqual(run.status, 0);
    assert.equal(run.stdout, "");
    assert.ok(run.stderr.length);
    return { input, status: run.status, stderr: run.stderr };
  });
  fs.writeFileSync(
    reportFile,
    JSON.stringify(
      {
        sourceRevision: "75de37ea01a81cd7949e6275b7ee9cfdeb4e312d",
        reference: { node: process.version, v8: process.versions.v8 },
        nativeExecutable: {
          path: binary,
          sha256: hash(fs.readFileSync(binary)),
        },
        directory,
        passed: rows.filter((row) => row.passed).length,
        unqualifiedPairs: rows.filter((row) => row.passed).length,
        qualifiedPairs: 0,
        rejectedInvalidInputs: invalid.length,
        cases: rows,
        failures,
        invalid,
      },
      null,
      2,
    ),
  );
  if (failures.length) process.exitCode = 1;
}
