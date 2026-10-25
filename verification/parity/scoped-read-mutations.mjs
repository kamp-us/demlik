import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
} from "../../packages/code-graph/src/boundaries/zones/reads.js";
import { loadBindingCatalog } from "../../packages/code-graph/src/extract/wrangler-config.js";
import { sourceUnit } from "../../packages/code-graph/src/test-helpers/source-unit.js";

const baseline = process.argv[2];
assert.ok(
  baseline,
  "usage: node --import tsx scoped-read-mutations.mjs <baseline-driver> [evidence.json]",
);
assert.ok(process.argv.length <= 4);
assert.equal(process.version, "v22.21.1");
assert.equal(process.versions.v8, "12.4.254.21-node.33");
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const directory = await mkdtemp(
  path.join(tmpdir(), "demlik-scoped-read-faults-"),
);
const project = path.join(directory, "project"),
  workspace = path.join(directory, "workspace");
const cargo = process.env.CARGO ?? "cargo";
const targetDirectory = path.join(
  root,
  "target/parity/scoped-read-mutation-build",
);
const owner = "crates/code-graph/src/boundaries/zones/reads.rs";
const shapeOwner = "crates/code-graph/src/boundaries/shape/model.rs";
const violationOwner = "crates/code-graph/src/boundaries/violation.rs";
const scope = "services/api",
  file = "read.ts";
const rules = {
  libraryTypes: { kernel: { imports: [], pure: true } },
  libraries: { "packages/kernel": "kernel" },
  readAllowance: {
    [scope]: { driven: [file, "write.ts"], decidedBy: ["kernel"] },
  },
};
const normal = (value) => JSON.parse(JSON.stringify(value));
function request(
  id,
  source,
  name = file,
  operation = "code_graph.read-sites",
  ownRules = rules,
) {
  return {
    id,
    operation,
    input: {
      repoRoot: project,
      rules: ownRules,
      scope,
      files: [{ file: name, source: { kind: "text", text: source } }],
      targets: [name],
      probes: [],
    },
  };
}
function opaque(id, ownRules = rules, site = null, rawLine) {
  return {
    id,
    operation: "code_graph.scoped-reads",
    rawLine,
    input: {
      repoRoot: project,
      rules: ownRules,
      scope,
      modules: [{ file, firstWrite: site }],
      loaded: [file],
      importSpecifiers: ["@shop/kernel"],
      runtimeSpecifiers: ["@shop/kernel"],
      targets: [file],
    },
  };
}
function text(item) {
  const { rawLine, ...request } = item;
  const raw = JSON.stringify(request);
  return rawLine === undefined
    ? raw
    : raw.replace(/"line":(?:0|null)/, `"line":${rawLine}`);
}
function call(binary, item) {
  const child = spawnSync(binary, [], {
    input: `${text(item)}\n`,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stderr, "");
  const answer = JSON.parse(child.stdout);
  assert.equal(answer.id, item.id);
  assert.equal(answer.ok, true, JSON.stringify(answer.error));
  assert.ok(
    answer.observedCalls.some((method) =>
      method.endsWith(
        item.operation === "code_graph.scoped-reads"
          ? "DrivenReads::verdict"
          : item.operation === "code_graph.read-sites"
            ? "first_write"
            : "read_shape",
      ),
    ),
  );
  return answer.output;
}
function reference(item, part) {
  const rules = BoundaryRulesSchema.parse(item.input.rules),
    catalog = loadBindingCatalog(item.input.repoRoot);
  if (item.operation === "code_graph.scoped-reads") {
    const own = readLibraries(rules, item.input.repoRoot, undefined);
    assert.equal(own.kind, "read");
    const reads = scopeReadsOf(
      readAllowanceOf(rules.readAllowance, catalog),
      item.input.scope,
      item.input.modules,
    );
    return drivenReadsOf(
      reads,
      {
        importEdges: item.input.importSpecifiers.map((specifier) => ({
          specifier,
        })),
        runtimeSpecifiers: new Set(item.input.runtimeSpecifiers),
      },
      own.libraries,
    )(file);
  }
  const prepared = readShape(rules, catalog);
  if (prepared.kind === "refused") return prepared;
  const held = item.input.files[0],
    syntax = sourceUnit(held.source.text, held.file).syntax;
  return part === "offendingForm"
    ? shapeFactsOf(prepared.shape, scope, held.file, syntax).offendingForm
    : firstWrite(prepared.shape.allowance, scope, held.file, syntax);
}
const controls = [];
try {
  await mkdir(path.join(project, scope), { recursive: true });
  await mkdir(path.join(project, "packages/kernel"), { recursive: true });
  await writeFile(
    path.join(project, "packages/kernel/package.json"),
    '{"name":"@shop/kernel"}',
  );
  await writeFile(
    path.join(project, scope, "wrangler.jsonc"),
    '{"name":"api","d1_databases":[{"binding":"DB"}],"kv_namespaces":[{"binding":"CACHE"}]}',
  );
  const bad = path.join(directory, "bad");
  await mkdir(bad);
  await writeFile(path.join(bad, "wrangler.jsonc"), "{");
  const noDecision = { readAllowance: { [scope]: { driven: [file] } } };
  const typeOnly = opaque("type-only-stays-unlicensed");
  typeOnly.input.runtimeSpecifiers = [];
  const duplicate = opaque("later-write-owns-the-fact");
  duplicate.input.modules = [
    { file, firstWrite: { binding: "FIRST", line: 1 } },
    { file, firstWrite: { binding: "LAST", line: 9 } },
  ];
  const refusal = request(
    "unread-catalog-refuses",
    "",
    file,
    "code_graph.shape-reads",
    noDecision,
  );
  refusal.input.repoRoot = bad;
  const mutations = [
    {
      name: "unlisted-file-is-scanned",
      file: owner,
      before: "if !allowance.scopes.get(scope)?.driven.contains(file) {",
      after:
        "if false && !allowance.scopes.get(scope)?.driven.contains(file) {",
      item: request(
        "unlisted-is-not-a-grant",
        "env.CACHE.put('k','v');",
        "unlisted.ts",
      ),
      select: (output) => output.facts[0].firstWrite,
      beforeCheck: (value) => assert.equal(value, null),
      afterCheck: (value) =>
        assert.deepEqual(value, { binding: "CACHE", line: 1 }),
    },
    {
      name: "last-write-replaces-first",
      file: owner,
      before: ".min_by_key(|site| (site.line, site.column))",
      after: ".max_by_key(|site| (site.line, site.column))",
      item: request(
        "first-visible-write",
        "env.CACHE.put('k','v'); env.DB.exec('DELETE FROM t');",
      ),
      select: (output) => output.facts[0].firstWrite,
      beforeCheck: (value) =>
        assert.deepEqual(value, { binding: "CACHE", line: 1 }),
      afterCheck: (value) =>
        assert.deepEqual(value, { binding: "DB", line: 1 }),
    },
    {
      name: "unknown-access-becomes-write",
      file: owner,
      before: "== DataAccess::Write",
      after: "!= DataAccess::Read",
      item: request("nonliteral-sql-is-unknown", "env.DB.prepare(sql);"),
      select: (output) => output.facts[0].firstWrite,
      beforeCheck: (value) => assert.equal(value, null),
      afterCheck: (value) =>
        assert.deepEqual(value, { binding: "DB", line: 1 }),
    },
    {
      name: "type-import-decides",
      file: owner,
      before: "module.runtime_specifiers.contains(&edge.specifier)",
      after: "true",
      item: typeOnly,
      select: (output) => output.verdicts[0],
      beforeCheck: (value) => assert.deepEqual(value, { licensed: false }),
      afterCheck: (value) => assert.deepEqual(value, { licensed: true }),
    },
    {
      name: "write-fact-is-ignored",
      file: owner,
      before: "if let Some(write) = reads.writes.get(target) {",
      after:
        "if let Some(write) = reads.writes.get(target).filter(|_| false) {",
      item: opaque("write-before-omitted-decision", noDecision, {
        binding: "DB",
        line: 4,
      }),
      select: (output) => output.verdicts[0],
      beforeCheck: (value) =>
        assert.deepEqual(value, {
          licensed: false,
          write: { file: `${scope}/${file}`, binding: "DB", line: 4 },
        }),
      afterCheck: (value) => assert.deepEqual(value, { licensed: true }),
    },
    {
      name: "omitted-decision-refuses",
      file: owner,
      before:
        "let Some(types) = &reads.allowance.decided_by else {\n            return DrivenVerdict::Licensed;\n        };",
      after:
        "let Some(types) = &reads.allowance.decided_by else {\n            return DrivenVerdict::Unlicensed;\n        };",
      item: opaque("omitted-decision-licenses", noDecision),
      select: (output) => output.verdicts[0],
      beforeCheck: (value) => assert.deepEqual(value, { licensed: true }),
      afterCheck: (value) => assert.deepEqual(value, { licensed: false }),
    },
    {
      name: "first-duplicate-write-wins",
      file: owner,
      before: "writes: modules\n            .iter()",
      after: "writes: modules\n            .iter().rev()",
      item: duplicate,
      select: (output) => output.verdicts[0],
      beforeCheck: (value) => assert.equal(value.write.binding, "LAST"),
      afterCheck: (value) => assert.equal(value.write.binding, "FIRST"),
    },
    {
      name: "disabled-entry-kind-runs",
      file: shapeOwner,
      before: "shape.kinds.contains(&ShapeKind::IndexNotExportsOnly)",
      after: "true",
      item: request(
        "entry-kind-is-opt-in",
        "export const local=1;",
        "index.ts",
        "code_graph.shape-reads",
        {},
      ),
      part: "offendingForm",
      select: (output) => output.facts[0].offendingForm,
      beforeCheck: (value) => assert.equal(value, null),
      afterCheck: (value) => assert.equal(value, "declaration"),
    },
    {
      name: "unread-catalog-is-admitted",
      file: shapeOwner,
      before:
        "if declares_read_allowance(rules) && !catalog.unparsed_configs.is_empty() {",
      after:
        "if false && declares_read_allowance(rules) && !catalog.unparsed_configs.is_empty() {",
      item: refusal,
      select: (output) =>
        output.kind === "refused" ? output : { kind: "read" },
      beforeCheck: (value) => assert.equal(value.kind, "refused"),
      afterCheck: (value) => assert.deepEqual(value, { kind: "read" }),
    },
    {
      name: "borrowed-write-retains-negative-zero-json",
      file: violationOwner,
      before:
        'pub struct WriteSite {\n    pub file: JsString,\n    #[serde(serialize_with = "crate::text::serialize_number")]\n    pub line: f64,',
      after:
        "pub struct WriteSite {\n    pub file: JsString,\n    pub line: f64,",
      item: opaque(
        "borrowed-write-json-number",
        noDecision,
        { binding: "DB", line: -0 },
        "-0",
      ),
      select: (output) => output.verdicts[0],
      beforeCheck: (value) =>
        assert.equal(Object.is(value.write.line, 0), true),
      afterCheck: (value) =>
        assert.equal(Object.is(value.write.line, -0), true),
    },
  ];
  // Every witness must match the actual source before any altered native build is counted.
  for (const mutation of mutations) {
    const expected = normal(reference(mutation.item, mutation.part));
    const answer = mutation.select(call(baseline, mutation.item));
    assert.deepEqual(
      answer,
      expected,
      `${mutation.name}: baseline/source mismatch`,
    );
    mutation.beforeCheck(answer);
    mutation.expected = expected;
  }
  await mkdir(workspace);
  for (const file of ["Cargo.toml", "Cargo.lock", "crates"]) {
    await cp(path.join(root, file), path.join(workspace, file), {
      recursive: true,
    });
  }
  const originals = new Map();
  for (const mutation of mutations) {
    if (!originals.has(mutation.file))
      originals.set(
        mutation.file,
        await readFile(path.join(root, mutation.file), "utf8"),
      );
  }
  for (const mutation of mutations) {
    for (const [file, original] of originals)
      await writeFile(path.join(workspace, file), original);
    const original = originals.get(mutation.file);
    assert.equal(
      original.split(mutation.before).length,
      2,
      `unique mutation site: ${mutation.name}`,
    );
    await writeFile(
      path.join(workspace, mutation.file),
      original.replace(mutation.before, mutation.after),
    );
    execFileSync(
      cargo,
      [
        "build",
        "--offline",
        "-p",
        "demlik-code-graph",
        "--example",
        "scoped_reads_driver",
      ],
      {
        cwd: workspace,
        env: { ...process.env, CARGO_TARGET_DIR: targetDirectory },
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        stdio: "pipe",
      },
    );
    const actual = mutation.select(
      call(
        path.join(targetDirectory, "debug/examples/scoped_reads_driver"),
        mutation.item,
      ),
    );
    assert.notDeepEqual(actual, mutation.expected, `${mutation.name}: escaped`);
    mutation.afterCheck(actual);
    controls.push({
      name: mutation.name,
      witness: mutation.item.id,
      source: mutation.expected,
      mutant: actual,
      detected: true,
      numberObservation: {
        sourceNegativeZero: Object.is(mutation.expected?.write?.line, -0),
        mutantNegativeZero: Object.is(actual?.write?.line, -0),
      },
    });
    process.stdout.write(`${JSON.stringify({ detected: mutation.name })}\n`);
  }
  const report = {
    detected: controls.length,
    escaped: 0,
    baselineMatchesSource: true,
    controls,
  };
  if (process.argv[3])
    await writeFile(process.argv[3], `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(
    `${JSON.stringify({ detected: report.detected, escaped: report.escaped })}\n`,
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
