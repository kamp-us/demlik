import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { cases as allCases, common } from "./icu77-metadata-cases.mjs";

const [binary, reportFile] = process.argv.slice(2);
assert.ok(binary && reportFile && process.argv.length === 4);
const cases = process.env.DEMLIK_D_CASES
  ? allCases.filter((c) => process.env.DEMLIK_D_CASES.split(",").includes(c.id))
  : allCases;
const failures = [],
  nativeEvidence = {},
  qualifiedNativeEvidence = {};
const root = fileURLToPath(new URL("../..", import.meta.url));
const load = (file) =>
  import(pathToFileURL(`${root}/packages/code-graph/src/${file}.ts`));
const project = await load("extract/project"),
  imports = await load("syntax/imports"),
  decl = await load("declarations/discover"),
  uses = await load("declarations/uses"),
  functions = await load("extract/functions"),
  exports = await load("extract/conventions/export-names"),
  packages = await load("extract/package-exports"),
  catalog = await load("extract/wrangler-config"),
  rules = await load("kinds/rules"),
  config = await load("config"),
  contextModule = await load("checker/context");
assert.equal(process.version, "v22.21.1");
assert.ok(process.versions.v8.startsWith("12.4."));
const temp = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "demlik-d-source-")),
);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sourceFiles = [
  "syntax/imports",
  "declarations/discover",
  "declarations/uses",
  "extract/conventions/export-names",
  "extract/package-exports",
  "extract/wrangler-config",
  "kinds/rules",
  "kinds/presets",
  "config",
  "extract/project",
  "extract/functions",
  "checker/context",
  "engine/tsgo",
];
const sourceHashes = () =>
  Object.fromEntries(
    sourceFiles.map((file) => [
      file,
      hash(
        fs.readFileSync(
          path.join(root, "packages/code-graph/src", `${file}.ts`),
        ),
      ),
    ]),
  );
const frozenSourceHashes = sourceHashes();
const observed = [];
const manifest = createRequire(
  path.join(root, "packages/code-graph/package.json"),
).resolve("@typescript/native-preview/package.json");
const { z } = createRequire(
  path.join(root, "verification/parity/package.json"),
)("zod");
const responseSchema = z.strictObject({
  id: z.string().nullable(),
  ok: z.boolean(),
  output: z.unknown().optional(),
  error: z
    .strictObject({ stage: z.string(), name: z.string(), message: z.string() })
    .optional(),
  observedCalls: z.array(z.string()),
});
const snapshotCalls = [
  "demlik_code_graph::declarations::discover::discover_declarations",
  "demlik_code_graph::syntax::imports::resolve_imports",
  "demlik_code_graph::syntax::imports::import_declaration_specifiers",
  "demlik_code_graph::extract::conventions::export_names_by_id",
];
const callByOp = {
  rules: "demlik_code_graph::kinds::rules::compile_group",
  catalog: "demlik_code_graph::extract::wrangler_config::load_binding_catalog",
  entry: "demlik_code_graph::extract::package_exports::package_source_entry",
  presets: "demlik_code_graph::config::with_entry_presets",
};
let rejectedInvalidInputs = 0;
function filesAt(dir) {
  return Object.fromEntries(
    fs
      .readdirSync(dir, { recursive: true })
      .map((f) => [f, path.join(dir, f)])
      .filter(([, f]) => fs.statSync(f).isFile())
      .map(([f, p]) => [
        f,
        {
          base64: fs.readFileSync(p).toString("base64"),
          mode: fs.statSync(p).mode & 0o777,
        },
      ]),
  );
}
try {
  for (const item of cases) {
    const fixture = path.join(temp, item.id);
    fs.mkdirSync(fixture);
    for (const [file, bytes] of Object.entries({ ...common, ...item.files })) {
      const target = path.join(fixture, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, bytes);
    }
    const before = filesAt(fixture);
    let output,
      error,
      stage = item.operation;
    try {
      if (item.operation === "rules")
        output = rules.compileGroup(item.group).map((r) => r.key);
      else if (item.operation === "catalog")
        output = catalog.loadBindingCatalog(fixture);
      else if (item.operation === "entry")
        output = item.dirs.map((dir) =>
          packages.packageSourceEntry(fixture, dir),
        );
      else if (item.operation === "presets") {
        const defaults = rules.NodeKindRulesSchema.parse({
          entryExportPresets: item.filePresets,
        });
        const messages = [];
        const result = config.withEntryPresets(
          defaults,
          item.names,
          (message) => messages.push(message),
        );
        output = { presets: result?.entryExportPresets ?? null, messages };
      } else {
        const loaded = project.loadCheapProject(fixture);
        const discovered = functions.discoverFunctions(
          loaded.sourceFiles,
        ).functions;
        const declarations = decl.discoverDeclarations(loaded.sourceFiles);
        const graph = imports.resolveImports(
          loaded.rootAbsolute,
          loaded.sourceFiles,
          path.join(fixture, "tsconfig.json"),
        );
        output = {
          declarationSpecifiers: Object.fromEntries(
            loaded.sourceFiles.map((u) => [
              u.file,
              imports.importDeclarationSpecifiers(u.syntax),
            ]),
          ),
          imports: {
            importsByFile: Object.fromEntries(graph.importsByFile),
            importedByFile: Object.fromEntries(graph.importedByFile),
            importEdgesByFile: Object.fromEntries(graph.importEdgesByFile),
          },
          declarations,
          exportNames: Object.fromEntries(exports.exportNamesById(discovered)),
          uses: null,
        };
        if (item.go) {
          stage = "uses";
          const context = contextModule.TypeContext.open({
            rootAbsolute: loaded.rootAbsolute,
            sourceFiles: loaded.sourceFiles,
            tsConfigPath: path.join(fixture, "tsconfig.json"),
            functions: discovered,
          });
          try {
            const found = uses.resolveDeclarationUses(context, declarations);
            output.uses = {
              usesById: Object.fromEntries(found.usesById),
              unjoined: found.unjoined,
            };
          } finally {
            context.close();
          }
        }
      }
    } catch (caught) {
      error = { stage, name: caught.name, message: caught.message };
    }
    assert.deepEqual(filesAt(fixture), before);
    const request = {
      id: item.id,
      operation: item.operation,
      root: fixture,
      ...(item.go ? { go: true } : {}),
      ...(item.group ? { group: item.group } : {}),
      ...(item.dirs ? { dirs: item.dirs } : {}),
      ...(item.names ? { names: item.names } : {}),
      ...(item.filePresets ? { filePresets: item.filePresets } : {}),
    };
    const row = {
      id: item.id,
      input: item,
      before,
      expected: error ? { error } : { output },
      qualifications: [],
      passed: false,
    };
    try {
      const run = spawnSync(binary, [manifest], {
        input: `${JSON.stringify(request)}\n`,
        encoding: "utf8",
        maxBuffer: 32 << 20,
      });
      row.process = {
        status: run.status,
        signal: run.signal,
        stdout: run.stdout,
        stderr: run.stderr,
      };
      assert.ifError(run.error);
      assert.equal(run.signal, null);
      assert.equal(run.status, 0);
      assert.equal(run.stderr, "");
      row.actual = responseSchema.parse(JSON.parse(run.stdout));
      row.nativeTrace = { observedCalls: row.actual.observedCalls };
      assert.equal(row.actual.id, item.id);
      assert.equal(row.actual.ok, !error);
      const actualCalls = row.actual.observedCalls;
      if (item.operation === "snapshot") {
        for (const call of snapshotCalls) assert.ok(actualCalls.includes(call));
        assert.equal(
          actualCalls.includes(
            "demlik_code_graph::declarations::uses::resolve_declaration_uses",
          ),
          item.go === true,
        );
        assert.ok(
          actualCalls.every(
            (call) =>
              snapshotCalls.includes(call) ||
              call ===
                "demlik_code_graph::declarations::uses::resolve_declaration_uses",
          ),
        );
      } else
        assert.ok(
          actualCalls.length > 0 &&
            actualCalls.every((call) => call === callByOp[item.operation]),
        );
      if (error) {
        assert.equal(row.actual.error.stage, error.stage);
        assert.equal(row.actual.error.name, error.name);
        if (
          item.id === "rule-regex-error-retained" &&
          row.actual.error.message !== error.message
        )
          row.qualifications.push("regex-backend-diagnostic-qualified");
        else assert.deepEqual(row.actual.error, error);
      } else assert.deepEqual(row.actual.output, output);
      assert.deepEqual(filesAt(fixture), before);
      row.after = filesAt(fixture);
      row.passed = true;
      (row.qualifications.length ? qualifiedNativeEvidence : nativeEvidence)[
        item.id
      ] = { observedCalls: actualCalls };
    } catch (caught) {
      row.failure = {
        message: caught.message,
        actual: caught.actual,
        expected: caught.expected,
      };
      failures.push({ id: item.id, ...row.failure });
    }
    observed.push(row);
  }
  if (!process.env.DEMLIK_D_CASES) {
    assert.equal(observed.length, 24);
    const base = { id: "bad", operation: "rules", root: temp };
    for (const [id, request] of [
      ["missing-id", {}],
      ["unknown-field", { ...base, unknown: true }],
      ["numeric-root", { ...base, root: 1 }],
      ["bad-group", { ...base, group: { x: 1 } }],
      ["bad-names", { ...base, names: [1] }],
    ]) {
      const run = spawnSync(binary, [manifest], {
        input: `${JSON.stringify(request)}\n`,
        encoding: "utf8",
      });
      assert.ifError(run.error);
      assert.equal(run.status, 0);
      assert.equal(run.stderr, "");
      const actual = responseSchema.parse(JSON.parse(run.stdout));
      assert.equal(actual.ok, false);
      assert.equal(actual.id, null);
      assert.equal(actual.error.stage, "protocol");
      assert.deepEqual(actual.observedCalls, []);
      observed.push({
        id: `protocol.${id}`,
        protocol: true,
        passed: true,
        actual,
        process: { status: run.status, stdout: run.stdout, stderr: run.stderr },
      });
      rejectedInvalidInputs++;
    }
  }
  const record = {
    passed: observed.filter((c) => !c.protocol && c.passed).length,
    attempted: cases.length,
    unqualifiedPairs: Object.keys(nativeEvidence).length,
    qualifiedPairs: Object.keys(qualifiedNativeEvidence).length,
    rejectedInvalidInputs,
    failures,
    reference: {
      Source: "75de37ea01a81cd7949e6275b7ee9cfdeb4e312d",
      node: process.version,
      v8: process.versions.v8,
      sourceHashes: frozenSourceHashes,
    },
    rustBinarySha256: hash(fs.readFileSync(binary)),
    cases: observed,
    nativeEvidence,
    qualifiedNativeEvidence,
  };
  fs.writeFileSync(reportFile, `${JSON.stringify(record, null, 2)}\n`);
  console.log(
    JSON.stringify({
      passed: record.passed,
      qualified: record.qualifiedPairs,
      failures: failures.length,
    }),
  );
  if (!process.env.DEMLIK_MUTATION_ALLOW_FAILURES)
    assert.deepEqual(failures, []);
} finally {
  assert.deepEqual(
    sourceHashes(),
    frozenSourceHashes,
    "Source product stayed immutable",
  );
  fs.rmSync(temp, { recursive: true, force: true });
}
