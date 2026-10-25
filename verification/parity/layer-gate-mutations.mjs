import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveLayerRules } from "../../packages/code-graph/src/config.js";
import { runLayerGate } from "../../packages/code-graph/src/layers/gate.js";
import { renderLayers } from "../../packages/code-graph/src/layers/render.js";

const baseline = process.argv[2];
assert.ok(
  baseline,
  "usage: node --import tsx layer-gate-mutations.mjs <baseline-layer-gate-driver> [evidence.json]",
);
assert.ok(process.argv.length <= 4);
assert.equal(process.version, "v22.21.1");
assert.equal(process.versions.v8, "12.4.254.21-node.33");
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const directory = await mkdtemp(
  path.join(tmpdir(), "demlik-layer-gate-faults-"),
);
const workspace = path.join(directory, "workspace"),
  project = path.join(directory, "project");
const cargo = process.env.CARGO ?? "cargo";
const targetDirectory = path.join(
  root,
  "target/parity/layer-gate-mutation-build",
);
const owner = "crates/code-graph/src/layers/";
const common = "crates/code-graph/src/config.rs";
const item = (id, operation, input) => ({
  id,
  operation: `code_graph.layer_${operation}`,
  input,
});
function reference(item) {
  switch (item.operation) {
    case "code_graph.layer_config": {
      const reports = [];
      return {
        rules: resolveLayerRules(item.input.file, (message) =>
          reports.push(message),
        ),
        reports,
      };
    }
    case "code_graph.layer_render":
      return renderLayers(
        item.input.report,
        item.input.allowed,
        item.input.json,
        item.input.pretty,
      );
    case "code_graph.layer_gate": {
      const emitted = [],
        reports = [];
      const exitCode = runLayerGate({
        ...item.input,
        layerRulesFile: item.input.layerRulesFile,
        emit: (payload) => emitted.push(payload),
        report: (message) => reports.push(message),
      });
      return { exitCode, emitted, reports };
    }
    default:
      throw Error("unknown operation");
  }
}
function call(binary, item, ok = true) {
  const child = spawnSync(binary, [], {
    input: `${JSON.stringify(item)}\n`,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stderr, "");
  const answer = JSON.parse(child.stdout);
  assert.equal(answer.id, item.id);
  assert.equal(answer.ok, ok, JSON.stringify(answer.error));
  const method = {
    "code_graph.layer_config": "resolve_layer_rules",
    "code_graph.layer_render": "render_layers",
    "code_graph.layer_gate": "run_layer_gate",
  }[item.operation];
  assert.ok(method);
  assert.ok(answer.observedCalls.includes(method));
  return answer;
}
const controls = [];
try {
  await mkdir(path.join(project, "src/domain"), { recursive: true });
  await writeFile(
    path.join(project, "src/service.ts"),
    "export type Service=unknown;",
  );
  await writeFile(
    path.join(project, "src/domain/rule.ts"),
    "import type { Service } from '../service.js';\nexport const x=1;",
  );
  const stack = [
    { name: "service", paths: ["src"] },
    { name: "domain", paths: ["src/domain"] },
  ];
  const valid = path.join(directory, "valid.json");
  await writeFile(valid, JSON.stringify({ layers: stack }));
  const own = path.join(directory, "own.json");
  await writeFile(
    own,
    JSON.stringify({
      layers: [{ ...stack[0], paths: ["src", "src"] }, stack[1]],
    }),
  );
  const utf8 = path.join(directory, "invalid-utf8.json");
  await writeFile(
    utf8,
    Buffer.concat([
      Buffer.from('{"layers":[{"name":"'),
      Buffer.from([0xff]),
      Buffer.from(
        '","paths":["src"]},{"name":"domain","paths":["src/domain"]}]}',
      ),
    ]),
  );
  const bom = path.join(directory, "bom.json");
  await writeFile(bom, `\ufeff${JSON.stringify({ layers: stack })}`);
  const raw = path.join(directory, "raw-\ud800.json");
  await writeFile(raw, "{");
  const tieRoot = path.join(directory, "tie"),
    tieRules = path.join(directory, "tie.json");
  await mkdir(path.join(tieRoot, "src"), { recursive: true });
  await writeFile(
    path.join(tieRoot, "src/billing-plumbing.ts"),
    "export const x=1;",
  );
  await writeFile(
    tieRules,
    JSON.stringify({
      layers: [
        { name: "plumbing", paths: ["**/*-plumbing.ts"] },
        { name: "billing", paths: ["**/billing-p*.ts"] },
      ],
    }),
  );
  const report = {
    layers: ["service", "domain"],
    filesScanned: 0,
    census: {
      down: 0,
      sideways: 0,
      up: 0,
      unlayered: 0,
      external: 0,
      unresolved: 0,
    },
    violations: [],
    unresolved: [],
  };
  const gate = (id, root = project, file = valid) =>
    item(id, "gate", {
      rootAbsolute: root,
      repoRoot: root,
      layerRulesFile: file,
      json: true,
      pretty: false,
    });
  const mutations = [
    {
      name: "missing-stack-is-admitted",
      file: `${owner}config.rs`,
      before: "if rules.layers.is_empty() {",
      after: "if false && rules.layers.is_empty() {",
      item: item("absent-stack-refuses-before-analysis", "config", {}),
      beforeCheck: (answer) => assert.equal(answer.output.rules, null),
      afterCheck: (answer) =>
        assert.deepEqual(answer.output.rules, { layers: [], allowed: [] }),
    },
    {
      name: "same-layer-duplicate-path-is-admitted",
      file: `${owner}config.rs`,
      before: "if let Some(owner) = patterns.get(pattern) {",
      after:
        "if let Some(owner) = patterns.get(pattern).filter(|owner| *owner != &layer.name) {",
      item: item("duplicate-own-path-is-refused", "config", { file: own }),
      beforeCheck: (answer) => assert.equal(answer.output.rules, null),
      afterCheck: (answer) => assert.ok(answer.output.rules),
    },
    {
      name: "invalid-utf8-is-refused-instead-of-decoded",
      file: common,
      before: "JsValue::parse(&String::from_utf8_lossy(&bytes))",
      after: 'JsValue::parse(std::str::from_utf8(&bytes).unwrap_or(""))',
      item: item("node-byte-decoding-is-retained", "config", { file: utf8 }),
      beforeCheck: (answer) =>
        assert.equal(answer.output.rules.layers[0].name, "�"),
      afterCheck: (answer) => {
        assert.equal(answer.output.rules, null);
        assert.ok(answer.output.reports[0].includes("not valid JSON"));
      },
    },
    {
      name: "json-config-bom-is-stripped",
      file: common,
      before: "JsValue::parse(&String::from_utf8_lossy(&bytes))",
      after: String.raw`JsValue::parse(String::from_utf8_lossy(&bytes).trim_start_matches('\u{feff}'))`,
      item: item("bom-is-invalid-json", "config", { file: bom }),
      beforeCheck: (answer) => assert.equal(answer.output.rules, null),
      afterCheck: (answer) => assert.ok(answer.output.rules),
    },
    {
      name: "raw-filename-label-is-lost",
      file: common,
      before:
        "ConfigFile::Text(text) => (text.clone(), fs::read(text.to_lossy())),",
      after:
        "ConfigFile::Text(text) => (JsString::from(text.to_lossy()), fs::read(text.to_lossy())),",
      item: item("raw-refusal-filename-is-retained", "config", { file: raw }),
      beforeCheck: (answer) =>
        assert.ok(answer.output.reports[0].includes("\ud800")),
      afterCheck: (answer) => {
        assert.ok(!answer.output.reports[0].includes("\ud800"));
        assert.ok(answer.output.reports[0].includes("�"));
      },
    },
    {
      name: "json-render-option-is-ignored",
      file: `${owner}render.rs`,
      before: "if json {",
      after: "if json && false {",
      item: item("json-output-is-requested", "render", {
        report,
        allowed: [],
        json: true,
        pretty: false,
      }),
      beforeCheck: (answer) => assert.ok(answer.output.stdout.startsWith("{")),
      afterCheck: (answer) =>
        assert.ok(answer.output.stdout.startsWith("layers:")),
    },
    {
      name: "pretty-render-option-is-ignored",
      file: `${owner}render.rs`,
      before: "stable_stringify(&output, pretty)?",
      after: "stable_stringify(&output, false)?",
      item: item("pretty-json-is-requested", "render", {
        report,
        allowed: [],
        json: true,
        pretty: true,
      }),
      beforeCheck: (answer) => assert.ok(answer.output.stdout.includes("\n")),
      afterCheck: (answer) => assert.ok(!answer.output.stdout.includes("\n")),
    },
    {
      name: "tie-refusal-message-is-dropped",
      file: `${owner}gate.rs`,
      before: "reports: vec![error.message()],",
      after: "reports: Vec::new(),",
      item: gate("tie-is-reported", tieRoot, tieRules),
      beforeCheck: (answer) => {
        assert.equal(answer.output.exitCode, 2);
        assert.equal(answer.output.reports.length, 1);
      },
      afterCheck: (answer) => {
        assert.equal(answer.output.exitCode, 2);
        assert.deepEqual(answer.output.reports, []);
      },
    },
    {
      name: "emitted-newline-is-dropped",
      file: `${owner}gate.rs`,
      before: 'payload.push_str("\\n");',
      after: 'payload.push_str("");',
      item: gate("emit-includes-one-trailing-newline"),
      beforeCheck: (answer) =>
        assert.ok(answer.output.emitted[0].endsWith("\n")),
      afterCheck: (answer) =>
        assert.ok(!answer.output.emitted[0].endsWith("\n")),
    },
    {
      name: "root-io-precedes-config-refusal",
      file: `${owner}gate.rs`,
      before: "let rules = match resolve_layer_rules(args.layer_rules_file) {",
      after:
        "let _ = std::fs::canonicalize(args.repo_root).map_err(|error| LayerGateError::Analysis(LayerAnalysisError::Io(error)))?;\n    let rules = match resolve_layer_rules(args.layer_rules_file) {",
      item: item("no-stack-precedes-root-io", "gate", {
        rootAbsolute: path.join(directory, "missing"),
        repoRoot: path.join(directory, "missing"),
        json: true,
        pretty: false,
      }),
      beforeCheck: (answer) => assert.equal(answer.output.exitCode, 2),
      mutatedOk: false,
      afterCheck: (answer) => {
        assert.equal(answer.error.kind, "io-error");
        assert.equal(answer.error.ioKind, "not-found");
      },
    },
  ];
  await mkdir(workspace);
  for (const file of [
    "Cargo.toml",
    "Cargo.lock",
    "rust-toolchain.toml",
    "crates",
  ])
    await cp(path.join(root, file), path.join(workspace, file), {
      recursive: true,
    });
  for (const mutation of mutations) {
    const expected = reference(mutation.item),
      original = call(baseline, mutation.item);
    assert.deepEqual(original.output, expected, mutation.name);
    mutation.beforeCheck(original);
    const file = path.join(workspace, mutation.file),
      source = await readFile(file, "utf8");
    assert.equal(
      source.split(mutation.before).length,
      2,
      `${mutation.name}: exactly one owner edit`,
    );
    await writeFile(file, source.replace(mutation.before, mutation.after));
    process.stderr.write(
      `building disposable native fault: ${mutation.name}\n`,
    );
    execFileSync(
      cargo,
      [
        "build",
        "--locked",
        "--offline",
        "--package",
        "demlik-code-graph",
        "--example",
        "layer_gate_driver",
      ],
      {
        cwd: workspace,
        env: { ...process.env, CARGO_TARGET_DIR: targetDirectory },
        stdio: "pipe",
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    const changed = call(
      path.join(targetDirectory, "debug/examples/layer_gate_driver"),
      mutation.item,
      mutation.mutatedOk ?? true,
    );
    assert.notDeepEqual(
      { ok: changed.ok, output: changed.output, error: changed.error },
      { ok: original.ok, output: original.output, error: original.error },
      mutation.name,
    );
    mutation.afterCheck(changed);
    controls.push({
      name: mutation.name,
      detected: true,
      witness: mutation.item.id,
      baseline: original,
      mutated: changed,
    });
    await writeFile(file, source);
  }
  const evidence = {
    passed: controls.length,
    reference: {
      node: process.version,
      v8: process.versions.v8,
      profile:
        "actual source/baseline/disposable compiled native calls; intended data/exit/string changes, including explicit IO-error precedence witness",
    },
    controls,
  };
  if (process.argv[3])
    await writeFile(process.argv[3], `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(
    JSON.stringify(
      {
        ...evidence,
        controls: controls.map(({ name, detected, witness }) => ({
          name,
          detected,
          witness,
        })),
      },
      null,
      2,
    ),
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
