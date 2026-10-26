import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const baseline = process.argv[2],
  reportFile = process.argv[3];
assert.ok(baseline, "provide compiled baseline gate_preflight_driver");
assert.ok(process.argv.length <= 4);
assert.equal(process.version, "v22.21.1");
assert.equal(process.versions.v8, "12.4.254.21-node.33");
const root = fileURLToPath(new URL("../..", import.meta.url));
const directory = fs.mkdtempSync(
  path.join(os.tmpdir(), "demlik-ledger-preflight-faults-"),
);
const workspace = path.join(directory, "workspace");
const target = path.join(root, "target/parity/shape-judgment-mutation-build");
const binary = path.join(target, "debug/examples/gate_preflight_driver");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const baselineHash = hash(fs.readFileSync(baseline));
const environment = {
  ...process.env,
  CARGO_PROFILE_DEV_DEBUG: "0",
  CARGO_PROFILE_TEST_DEBUG: "0",
  CARGO_INCREMENTAL: "0",
  CARGO_BUILD_JOBS: "1",
  CARGO_TARGET_DIR: target,
};
const controls = [];
const mutations = [
  {
    name: "workspace-nearest-becomes-last",
    file: "project.rs",
    before:
      'fn workspace_root_index(ancestors: impl Iterator<Item = PathBuf>) -> Option<usize> {\n    ancestors.enumerate().find_map(|(index, directory)| {\n        directory\n            .join("pnpm-workspace.yaml")\n            .exists()\n            .then_some(index)\n    })\n}\n',
    after:
      'fn workspace_root_index(ancestors: impl Iterator<Item = PathBuf>) -> Option<usize> {\n    ancestors.enumerate().filter_map(|(index, directory)| {\n        directory\n            .join("pnpm-workspace.yaml")\n            .exists()\n            .then_some(index)\n    }).last()\n}\n',
    witness: "root.closest",
    matches: 1,
  },
  {
    name: "repo-text-replaces-lone-units",
    file: "project.rs",
    before: ".map_or_else(|| start.clone(), |index| ancestors[index].clone())",
    after:
      ".map_or_else(|| JsString::from(start.to_lossy()), |index| JsString::from(ancestors[index].to_lossy()))",
    witness: "root.raw-marker",
    matches: 1,
  },
  {
    name: "repo-fallback-becomes-filesystem-root",
    file: "project.rs",
    before: ".map_or_else(|| start.clone(), |index| ancestors[index].clone())",
    after:
      '.map_or_else(|| JsString::from("/"), |index| ancestors[index].clone())',
    witness: "root.fallback",
    matches: 1,
  },
  {
    name: "json-text-lone-unit-replaced",
    file: "text.rs",
    before:
      'write!(&mut encoded, "\\\\u{:04x}", unit.unpaired_surrogate())\n                            .expect("String formatting is infallible");',
    after: "encoded.push(char::REPLACEMENT_CHARACTER);",
    witness: "json.context-7",
    matches: 1,
  },
  {
    name: "json-text-repairs-invalid-escape",
    file: "text.rs",
    before: "if in_string && !escaped {",
    after: "if in_string {",
    witness: "json.context-10",
    matches: 1,
  },
  {
    name: "json-text-forgets-even-backslashes",
    file: "text.rs",
    before: "if escaped {\n                            escaped = false;",
    after: "if escaped {\n                            escaped = true;",
    witness: "json.context-15",
    matches: 1,
  },
  {
    name: "json-text-escaped-quote-ends-string",
    file: "text.rs",
    before: "if escaped {\n                            escaped = false;",
    after:
      "if escaped {\n                            escaped = false; if ch == '\"' { in_string = false; }",
    witness: "json.context-14",
    matches: 1,
  },
  {
    name: "json-text-valid-surrogate-pair-replaced",
    file: "text.rs",
    before: "Ok(ch) => {\n                    encoded.push(ch);",
    after:
      "Ok(ch) => {\n                    if ch.len_utf16()==2 {encoded.push(char::REPLACEMENT_CHARACTER);}else{encoded.push(ch);}",
    witness: "json.context-5",
    matches: 1,
  },
  {
    name: "json-text-repairs-raw-c0",
    file: "text.rs",
    before: "Ok(ch) => {\n                    encoded.push(ch);",
    after:
      'Ok(ch) => {\n                    if (ch as u32)<32 {write!(&mut encoded,"\\\\u{:04x}",ch as u32).unwrap();}else{encoded.push(ch);}',
    witness: "json.context-29",
    matches: 1,
  },
  {
    name: "js-trim-keeps-bom",
    file: "text.rs",
    before: " | 0xfeff",
    after: "",
    witness: "smell.mode-none-2-blank",
    matches: 1,
  },
  {
    name: "js-trim-keeps-nbsp",
    file: "text.rs",
    before: " | 0xa0",
    after: "",
    witness: "unreachable.mode-5-blank",
    matches: 1,
  },
  {
    name: "js-trim-drops-non-js-space",
    file: "text.rs",
    before: " | 0xa0",
    after: " | 0xa0 | 0x85",
    witness: "smell.mode-none-2-kept",
    matches: 1,
  },
  {
    name: "empty-ledger-identifiers-accepted",
    file: "validation.rs",
    before: "if text.is_empty() {",
    after: "if false {",
    witness: "unreachable.schema-16",
    matches: 1,
  },
  {
    name: "unreachable-key-omits-category",
    file: "unreachable/ledger.rs",
    before:
      "serde_json::to_string(&(&finding.scope, &finding.kind, &finding.id))",
    after: "serde_json::to_string(&(&finding.scope, &finding.id))",
    witness: "unreachable.first-wins-1",
    matches: 1,
  },
  {
    name: "unreachable-last-reason-wins",
    file: "unreachable/ledger.rs",
    before: ".or_insert_with(|| Arc::clone(entry));",
    after:
      ".and_modify(|held| *held=Arc::clone(entry)).or_insert_with(|| Arc::clone(entry));",
    witness: "unreachable.first-wins-0",
    matches: 1,
  },
  {
    name: "unreachable-schema-deduplicates-instead-of-refusing",
    file: "unreachable/ledger.rs",
    before: "if !seen.insert(key.clone()) {",
    after: "if {let _=seen.insert(key.clone());false} {",
    witness: "unreachable.schema-52",
    matches: 1,
  },
  {
    name: "unreachable-constructor-uses-utf16-order",
    file: "unreachable/ledger.rs",
    before: "locale_compare_units(a.scope.units(), b.scope.units())",
    after: "a.scope.cmp(&b.scope)",
    witness: "unreachable.locale-constructor",
    matches: 1,
  },
  {
    name: "smell-key-includes-changing-measure",
    file: "smells/ledger.rs",
    before: "serde_json::to_string(&(finding.rule, &finding.target))",
    after:
      "serde_json::to_string(&(finding.rule, &finding.target, finding.value))",
    witness: "smell.first-wins-0",
    matches: 1,
  },
  {
    name: "smell-last-reason-wins",
    file: "smells/ledger.rs",
    before: ".or_insert_with(|| Arc::clone(entry));",
    after:
      ".and_modify(|held| *held=Arc::clone(entry)).or_insert_with(|| Arc::clone(entry));",
    witness: "smell.first-wins-0",
    matches: 1,
  },
  {
    name: "smell-schema-drops-duplicate-entry",
    file: "smells/ledger.rs",
    before: "if !seen.insert(smell_key(&entry.finding)) {",
    after: "if {let _=seen.insert(smell_key(&entry.finding));false} {",
    witness: "smell.schema-87",
    matches: 1,
  },
  {
    name: "smell-schema-drops-duplicate-gated-rule",
    file: "smells/ledger.rs",
    before: "if !seen.insert(kind.as_str()) {",
    after: "if {let _=seen.insert(kind.as_str());false} {",
    witness: "smell.schema-84",
    matches: 1,
  },
  {
    name: "smell-constructor-uses-utf16-order",
    file: "smells/ledger.rs",
    before:
      "locale_compare_units(a.finding.target.units(), b.finding.target.units())",
    after: "a.finding.target.cmp(&b.finding.target)",
    witness: "smell.locale-constructor",
    matches: 1,
  },
  {
    name: "safe-number-check-erases-negative-zero",
    file: "validation.rs",
    before: "return Ok(*number);",
    after: "return Ok(number.abs());",
    witness: "smell.schema-80",
    matches: 1,
  },
  {
    name: "reader-erases-original-io-cause",
    file: "unreachable/ledger.rs",
    before: "source: Some(source),",
    after: "source: None,",
    witness: "unreachable.read-directory",
    matches: 1,
  },
  {
    name: "unreachable-reads-inactive-fifo",
    file: "unreachable/gate.rs",
    before: "let reason = opts.reason.map(JsString::trim_js);",
    after:
      "let _=read_unreachable_ledger(&join_path_text(repo_root,&UNREACHABLE_LEDGER_FILENAME.into()));\n    let reason = opts.reason.map(JsString::trim_js);",
    witness: "cli.accept-dead-first",
    matches: 1,
  },
  {
    name: "smell-reads-inactive-fifo",
    file: "smells/gate.rs",
    before: "let reason = opts.reason.map(JsString::trim_js);",
    after:
      "let _=read_smell_ledger(&join_path_text(repo_root,&SMELL_LEDGER_FILENAME.into()));\n    let reason = opts.reason.map(JsString::trim_js);",
    witness: "cli.smell-conflict",
    matches: 1,
  },
  {
    name: "accept-dead-misses-required-mode",
    file: "unreachable/gate.rs",
    before: "opts.accept_dead && !opts.unreachable,",
    after: "false,",
    witness: "cli.accept-dead-first",
    matches: 1,
  },
  {
    name: "boundary-owned-reason-refused-too-early",
    file: "unreachable/gate.rs",
    before: "&& !opts.boundaries,",
    after: "&& true,",
    witness: "unreachable.mode-17-kept",
    matches: 1,
  },
  {
    name: "dead-only-gates-test-only-findings",
    file: "unreachable/gate.rs",
    before: "if opts.dead_only {",
    after: "if false {",
    witness: "unreachable.mode-11-missing",
    matches: 1,
  },
  {
    name: "ci-empty-smell-ledger-refused",
    file: "smells/gate.rs",
    before: "if matches!(mode, SmellGateMode::Gate) {",
    after: "if false {",
    witness: "smell.mode-none-1-missing",
    matches: 1,
  },
  {
    name: "edge-requirement-misses-high-fan-in",
    file: "smells/ledger.rs",
    before: ".any(|kind| measured_by(*kind) == MeasuredBy::Edges)",
    after:
      ".any(|kind| *kind != SmellKind::HighFanIn && measured_by(*kind) == MeasuredBy::Edges)",
    witness: "edges.high-fan-in",
    matches: 1,
  },
  {
    name: "prepared-smell-does-not-require-edges",
    file: "smells/gate.rs",
    before:
      "pub fn smell_gate_needs_edges(preparation: &SmellPreparation) -> bool {\n    matches!(preparation,SmellPreparation::Prepared{gate}if needs_edges(&gate.ledger.gated))\n}\n",
    after:
      "pub fn smell_gate_needs_edges(preparation:&SmellPreparation)->bool {let _=preparation;false}\n",
    witness: "cli.edges-ready",
    matches: 1,
  },
  {
    name: "invalid-rule-object-conversion-does-not-escape",
    file: "smells/ledger.rs",
    before: 'if object.contains_key(&JsString::from("toString")) {',
    after: 'if false && object.contains_key(&JsString::from("toString")) {',
    witness: "smell.schema-28",
    matches: 1,
  },
  {
    name: "earlier-issue-hides-later-conversion-error",
    file: "smells/ledger.rs",
    before: "let input = rule_input_text(value).map_err",
    after:
      "if !issues.is_empty(){return Ok(None);}\n    let input = rule_input_text(value).map_err",
    witness: "smell.schema-82",
    matches: 1,
  },
  {
    name: "conversion-error-input-erased",
    file: "smells/ledger.rs",
    before:
      'input: value\n            .expect("missing input has a string representation")\n            .clone(),',
    after: "input: JsValue::Null,",
    witness: "smell.schema-28",
    matches: 1,
  },
  {
    name: "invalid-rule-message-loses-raw-unit",
    file: "smells/ledger.rs",
    before: "JsValue::String(value) => out.extend(value),",
    after: "JsValue::String(value) => out.push_str(&value.to_lossy()),",
    witness: "smell.schema-36",
    matches: 1,
  },
  {
    name: "cli-dead-only-flag-not-forwarded",
    file: "cli/frontdoor.rs",
    before: "dead_only: opts.dead_only() == Some(true),",
    after: "dead_only: false,",
    witness: "cli.dead-only-first",
    matches: 1,
  },
  {
    name: "cli-unreachable-refusal-not-reported",
    file: "cli/frontdoor.rs",
    before: "clean_exit(host, &message);",
    after: "let _ = &message;",
    witness: "cli.unreachable-invalid",
    matches: 2,
  },
  {
    name: "cli-smell-preparation-runs-before-unreachable",
    file: "cli/frontdoor.rs",
    before:
      "        let unreachable = prepare_unreachable_gate(\n            UnreachableOpts {\n                unreachable: opts.unreachable() == Some(true),\n                ci: opts.ci() == Some(true),\n                accept_dead: opts.accept_dead() == Some(true),\n                dead_only: opts.dead_only() == Some(true),\n                boundaries: opts.boundaries() == Some(true),\n                reason: opts.reason(),\n            },\n            &self.root_absolute,\n            &repo_root,\n        )\n        .map_err(|source| FrontdoorError::GateScope {\n            stage: GatePreparationKind::Unreachable,\n            root: self.root_absolute.clone(),\n            repo_root: repo_root.clone(),\n            source,\n        })?;\n        if let UnreachablePreparation::Refused { message, source } = unreachable {\n            clean_exit(host, &message);\n            return Ok(GatePreflightDispatch::Stopped(GatePreflightRefusal {\n                stage: GatePreparationKind::Unreachable,\n                message,\n                source,\n            }));\n        }\n        let smells = prepare_smell_gate(\n            SmellGateOpts {\n                ci: opts.ci() == Some(true),\n                accept_smells: opts.accept_smells() == Some(true),\n                unreachable: opts.unreachable() == Some(true),\n                boundaries: opts.boundaries() == Some(true),\n                comments: opts.comments() == Some(true),\n                collapse: opts.collapse() == Some(true),\n                layers: opts.layers() == Some(true),\n                reason: opts.reason(),\n            },\n            &self.root_absolute,\n            &repo_root,\n        )\n        .map_err(|error| match error {\n            SmellPreparationError::RuleName(error) => FrontdoorError::RuleNameConversion(error),\n            SmellPreparationError::Scope(source) => FrontdoorError::GateScope {\n                stage: GatePreparationKind::Smell,\n                root: self.root_absolute.clone(),\n                repo_root: repo_root.clone(),\n                source,\n            },\n        })?;\n        if let SmellPreparation::Refused { message, source } = smells {\n            clean_exit(host, &message);\n            return Ok(GatePreflightDispatch::Stopped(GatePreflightRefusal {\n                stage: GatePreparationKind::Smell,\n                message,\n                source,\n            }));\n        }\n",
    after:
      "        let smells = prepare_smell_gate(\n            SmellGateOpts {\n                ci: opts.ci() == Some(true),\n                accept_smells: opts.accept_smells() == Some(true),\n                unreachable: opts.unreachable() == Some(true),\n                boundaries: opts.boundaries() == Some(true),\n                comments: opts.comments() == Some(true),\n                collapse: opts.collapse() == Some(true),\n                layers: opts.layers() == Some(true),\n                reason: opts.reason(),\n            },\n            &self.root_absolute,\n            &repo_root,\n        )\n        .map_err(|error| match error {\n            SmellPreparationError::RuleName(error) => FrontdoorError::RuleNameConversion(error),\n            SmellPreparationError::Scope(source) => FrontdoorError::GateScope {\n                stage: GatePreparationKind::Smell,\n                root: self.root_absolute.clone(),\n                repo_root: repo_root.clone(),\n                source,\n            },\n        })?;\n        if let SmellPreparation::Refused { message, source } = smells {\n            clean_exit(host, &message);\n            return Ok(GatePreflightDispatch::Stopped(GatePreflightRefusal {\n                stage: GatePreparationKind::Smell,\n                message,\n                source,\n            }));\n        }\n        let unreachable = prepare_unreachable_gate(\n            UnreachableOpts {\n                unreachable: opts.unreachable() == Some(true),\n                ci: opts.ci() == Some(true),\n                accept_dead: opts.accept_dead() == Some(true),\n                dead_only: opts.dead_only() == Some(true),\n                boundaries: opts.boundaries() == Some(true),\n                reason: opts.reason(),\n            },\n            &self.root_absolute,\n            &repo_root,\n        )\n        .map_err(|source| FrontdoorError::GateScope {\n            stage: GatePreparationKind::Unreachable,\n            root: self.root_absolute.clone(),\n            repo_root: repo_root.clone(),\n            source,\n        })?;\n        if let UnreachablePreparation::Refused { message, source } = unreachable {\n            clean_exit(host, &message);\n            return Ok(GatePreflightDispatch::Stopped(GatePreflightRefusal {\n                stage: GatePreparationKind::Unreachable,\n                message,\n                source,\n            }));\n        }\n",
    witness: "cli.accept-dead-first",
    matches: 1,
  },
  {
    name: "cli-config-facts-reset-after-preparation",
    file: "cli/frontdoor.rs",
    before: "prepared: self,",
    after: "prepared: {let mut p=self;p.thresholds=Default::default();p},",
    witness: "cli.config-values-carried",
    matches: 1,
  },
  {
    name: "cli-root-text-routed-through-lossy-path",
    file: "cli/frontdoor.rs",
    before: "let repo_root = find_repo_root_text(&self.root_absolute);",
    after:
      "let repo_root:JsString=crate::project::find_repo_root(std::path::Path::new(&self.root_absolute.to_lossy())).to_string_lossy().as_ref().into();",
    witness: "cli.raw-root-ready",
    matches: 1,
  },
];
const original = new Map(
  [...new Set(mutations.map((row) => row.file))].map((file) => [
    file,
    fs.readFileSync(path.join(root, "crates/code-graph/src", file), "utf8"),
  ]),
);
for (const row of mutations)
  assert.equal(
    original.get(row.file).split(row.before).length,
    row.matches + 1,
    row.name,
  );
function pairs(executable, name, ids) {
  const report = path.join(directory, `${name}.json`);
  const run = spawnSync(
    process.execPath,
    [
      "--import",
      createRequire(import.meta.url).resolve("tsx"),
      path.join(root, "verification/parity/graph-cli-ledger-preflight.mts"),
      executable,
      report,
    ],
    {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      env: { ...environment, DEMLIK_LEDGER_CASES: ids.join(",") },
    },
  );
  assert.ok(fs.existsSync(report), run.stdout + run.stderr);
  return { run, report: JSON.parse(fs.readFileSync(report, "utf8")) };
}
let before;
try {
  const ids = [...new Set(mutations.map((row) => row.witness))];
  before = pairs(baseline, "baseline", ids);
  assert.equal(before.run.status, 0, before.run.stdout + before.run.stderr);
  assert.equal(before.report.passed, ids.length);
  assert.equal(before.report.rejectedInvalidInputs, 7);
  for (const entry of ["Cargo.toml", "Cargo.lock", "crates"])
    fs.cpSync(path.join(root, entry), path.join(workspace, entry), {
      recursive: true,
    });
  for (const mutation of mutations) {
    for (const [file, text] of original)
      fs.writeFileSync(
        path.join(workspace, "crates/code-graph/src", file),
        text,
      );
    fs.writeFileSync(
      path.join(workspace, "crates/code-graph/src", mutation.file),
      original.get(mutation.file).replace(mutation.before, mutation.after),
    );
    const build = spawnSync(
      process.env.CARGO ?? "cargo",
      [
        "build",
        "--offline",
        "-p",
        "demlik-code-graph",
        "--example",
        "gate_preflight_driver",
      ],
      {
        cwd: workspace,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        env: environment,
      },
    );
    assert.equal(build.status, 0, mutation.name + build.stdout + build.stderr);
    const result = pairs(binary, mutation.name, [mutation.witness]);
    assert.notEqual(result.run.status, 0, mutation.name);
    assert.equal(result.report.rejectedInvalidInputs, 7, mutation.name);
    assert.ok(
      result.report.failures.some((row) => row.id === mutation.witness),
      mutation.name + JSON.stringify(result.report.failures),
    );
    controls.push({
      ...mutation,
      detected: true,
      mutantBinarySha256: hash(fs.readFileSync(binary)),
      build,
      failures: result.report.failures,
      witness: result.report.cases.find((row) => row.id === mutation.witness),
    });
    assert.equal(hash(fs.readFileSync(baseline)), baselineHash);
    for (const [file, text] of original)
      assert.equal(
        fs.readFileSync(path.join(root, "crates/code-graph/src", file), "utf8"),
        text,
      );
    process.stdout.write(
      `${JSON.stringify({ detected: mutation.name, completed: controls.length, total: mutations.length })}\n`,
    );
  }
  const report = {
    detected: controls.length,
    escaped: 0,
    baselineCases: before.report.passed,
    baselineMatchesSource: true,
    baselineDriverUnchanged: true,
    baselineDriverSha256: baselineHash,
    reference: before.report.reference,
    verifierSha256: hash(
      fs.readFileSync(
        path.join(root, "verification/parity/graph-cli-ledger-preflight.mts"),
      ),
    ),
    scriptSha256: hash(fs.readFileSync(fileURLToPath(import.meta.url))),
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
    controls,
  };
  if (reportFile)
    fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ detected: report.detected, escaped: 0 }));
} catch (error) {
  if (reportFile)
    fs.writeFileSync(
      reportFile,
      `${JSON.stringify({ incomplete: true, detected: controls.length, planned: mutations.length, failure: String(error), baseline: before?.report, controls }, null, 2)}\n`,
    );
  throw error;
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
