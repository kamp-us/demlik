import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createCheckWorktree,
  checkedSpawnSync as spawnSync,
} from "./check-worktree.mjs";

const baseline = process.argv[2];
assert.ok(baseline);
assert.ok(process.argv.length <= 4);
assert.equal(process.version, "v22.21.1");
assert.equal(process.versions.v8, "12.4.254.21-node.33");
const root = fileURLToPath(new URL("../..", import.meta.url));
const mutationCheck = createCheckWorktree(
  process.cwd(),
  "cli-config-mutations",
);
let mutationFailure;
try {
  const directory = mutationCheck.root;
  const workspace = mutationCheck.root;
  const target = mutationCheck.target;
  const binary = path.join(target, "debug/examples/cli_config_driver");
  const files = [
    "collapse/settings.rs",
    "schema.rs",
    "validation.rs",
    "config.rs",
  ];
  const original = new Map(
    files.map((file) => [
      file,
      fs.readFileSync(path.join(root, "crates/code-graph/src", file), "utf8"),
    ]),
  );
  const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const baselineHash = hash(fs.readFileSync(baseline));
  const environment = {
    ...process.env,
    CARGO_PROFILE_DEV_DEBUG: "0",
    CARGO_PROFILE_TEST_DEBUG: "0",
    CARGO_INCREMENTAL: "0",
    CARGO_BUILD_JOBS: "1",
  };
  const controls = [];
  function pairs(executable, name) {
    const report = path.join(directory, `${name}.json`);
    const run = spawnSync(
      process.execPath,
      [
        "--import",
        createRequire(import.meta.url).resolve("tsx"),
        path.join(root, "verification/parity/graph-cli-config.mts"),
        executable,
        report,
      ],
      {
        cwd: root,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        env: environment,
      },
    );
    assert.ok(fs.existsSync(report), run.stdout + run.stderr);
    return { run, report: JSON.parse(fs.readFileSync(report, "utf8")) };
  }
  const mutations = [
    {
      name: "collapse-default-loc-changed",
      file: "collapse/settings.rs",
      before: 'min_loc, "minLoc", 5.0,',
      after: 'min_loc, "minLoc", 6.0,',
      witness: "resolve.collapse.default",
    },
    {
      name: "collapse-signal-upper-bound-relaxed",
      file: "collapse/settings.rs",
      before: "maximum: Some(4.0)",
      after: "maximum: Some(5.0)",
      witness: "schema.collapse.minSignals.value-13",
    },
    {
      name: "real-effect-weight-treated-as-integer",
      file: "collapse/settings.rs",
      before:
        'cost_effect_weight, "costEffectWeight", 1.0, NumberCheck::Number',
      after:
        'cost_effect_weight, "costEffectWeight", 1.0, NumberCheck::Integer',
      witness: "schema.collapse.costEffectWeight.value-8",
    },
    {
      name: "integer-safe-endpoint-rejected",
      file: "validation.rs",
      before: "if number.abs() > MAX_SAFE {",
      after: "if number.abs() >= MAX_SAFE {",
      witness: "schema.collapse.minLoc.value-14",
    },
    {
      name: "nonfinite-base-check-omitted",
      file: "validation.rs",
      before: "if !number.is_finite() {",
      after: "if false {",
      witness: "schema.collapse.costEffectWeight.value-18",
    },
    {
      name: "signed-zero-fact-erased",
      file: "validation.rs",
      before: "return Ok(*number);",
      after: "return Ok(if *number == 0.0 { 0.0 } else { *number });",
      witness: "schema.collapse.shapeLocRatio.value-6",
    },
    {
      name: "collapse-strict-keys-ignored",
      file: "collapse/settings.rs",
      before: "if !keys.is_empty() {",
      after: "if false {",
      witness: "schema.collapse.root-6",
    },
    {
      name: "regexp-validation-skipped",
      file: "config.rs",
      before: "for source in rules.regex_sources() {",
      after: "for source in Vec::<JsString>::new() {",
      witness: "resolve.rules.regexp-before-glob",
    },
    {
      name: "glob-validation-skipped",
      file: "config.rs",
      before: "for name in object_keys(&rules.entry_export_conventions) {",
      after: "for name in std::iter::empty::<&JsString>() {",
      witness: "resolve.rules.glob",
    },
    {
      name: "record-throw-reclassified-as-refusal",
      file: "config.rs",
      before: "Err(error) => return Err(NodeKindConfigError::Rules(error)),",
      after:
        "Err(error) => return Ok(ConfigResolution::Refused {message: error.to_string().into()}),",
      witness: "resolve.rules.record-constructor",
    },
    {
      name: "unknown-entry-preset-ignored",
      file: "config.rs",
      before:
        'message.push_str(".");\n            return ConfigResolution::Refused { message };',
      after: 'message.push_str(".");\n            continue;',
      witness: "presets.default-3",
    },
    {
      name: "entry-preset-dedup-disabled",
      file: "config.rs",
      before: "if !presets.contains(&preset) {",
      after: "if true {",
      replacements: 2,
      witness: "presets.file-and-cli-dedupe",
    },
    {
      name: "raw-regexp-report-replaced",
      file: "config.rs",
      before: "message.extend(&source);",
      after: "message.push_str(&source.to_lossy());",
      witness: "resolve.rules.raw-regexp",
    },
    {
      name: "config-json-bom-stripped",
      file: "config.rs",
      before: "JsValue::parse(&String::from_utf8_lossy(&bytes))",
      after:
        "JsValue::parse(String::from_utf8_lossy(&bytes).trim_start_matches('\\u{feff}'))",
      witness: "resolve.thresholds.refusal-5",
    },
  ];
  try {
    const before = pairs(baseline, "baseline");
    assert.equal(before.run.status, 0, before.run.stdout + before.run.stderr);
    assert.equal(before.report.passed, before.report.attempted);
    assert.equal(before.report.rejectedInvalidInputs, 8);

    for (const mutation of mutations) {
      for (const [file, text] of original)
        fs.writeFileSync(
          path.join(workspace, "crates/code-graph/src", file),
          text,
        );
      const source = original.get(mutation.file);
      assert.equal(
        source.split(mutation.before).length,
        (mutation.replacements ?? 1) + 1,
        mutation.name,
      );
      fs.writeFileSync(
        path.join(workspace, "crates/code-graph/src", mutation.file),
        source.replaceAll(mutation.before, mutation.after),
      );
      const build = spawnSync(
        process.env.CARGO ?? "cargo",
        [
          "build",
          "--offline",
          "-p",
          "demlik-code-graph",
          "--example",
          "cli_config_driver",
        ],
        {
          cwd: workspace,
          encoding: "utf8",
          maxBuffer: 16 * 1024 * 1024,
          env: environment,
        },
      );
      assert.equal(
        build.status,
        0,
        mutation.name + build.stdout + build.stderr,
      );
      const result = pairs(binary, mutation.name);
      assert.notEqual(result.run.status, 0, mutation.name);
      assert.ok(
        result.report.failures.some((row) => row.id === mutation.witness),
        mutation.name +
          JSON.stringify(result.report.failures.map((row) => row.id)),
      );
      controls.push({
        ...mutation,
        detected: true,
        build: {
          status: build.status,
          stdout: build.stdout,
          stderr: build.stderr,
        },
        failedCases: result.report.failures.map((row) => row.id),
        witness: result.report.cases.find((row) => row.id === mutation.witness),
      });
      process.stdout.write(
        `${JSON.stringify({ detected: mutation.name, failures: result.report.failures.length })}\n`,
      );
    }
    assert.equal(hash(fs.readFileSync(baseline)), baselineHash);
    for (const [file, text] of original)
      assert.equal(
        fs.readFileSync(path.join(root, "crates/code-graph/src", file), "utf8"),
        text,
      );
    const report = {
      detected: controls.length,
      escaped: 0,
      baselineCases: before.report.passed,
      invalidInputs: 8,
      baselineMatchesSource: true,
      baselineDriverUnchanged: true,
      baselineDriverSha256: baselineHash,
      sourceHashes: Object.fromEntries(
        [...original].map(([file, text]) => [file, hash(text)]),
      ),
      buildProfile: {
        devDebug: 0,
        testDebug: 0,
        incremental: false,
        jobs: 1,
        target,
      },
      reference: before.report.reference,
      controls,
    };
    if (process.argv[3])
      fs.writeFileSync(process.argv[3], `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(
      `${JSON.stringify({ detected: report.detected, escaped: 0 })}\n`,
    );
  } finally {
  }
} catch (error) {
  mutationFailure = error;
  throw error;
} finally {
  mutationCheck.remove(mutationFailure);
}
