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
assert.ok(baseline, "provide compiled baseline hexagon_driver");
assert.ok(process.argv.length <= 4);
assert.equal(process.version, "v22.21.1");
assert.equal(process.versions.v8, "12.4.254.21-node.33");
const root = fileURLToPath(new URL("../..", import.meta.url));
const directory = fs.mkdtempSync(
  path.join(os.tmpdir(), "demlik-hexagon-faults-"),
);
const workspace = path.join(directory, "workspace");
const target = path.join(root, "target/parity/shape-judgment-mutation-build");
const binary = path.join(target, "debug/examples/hexagon_driver");
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
    name: "port-prefix-allows-lowercase",
    file: "hexagon/ports.rs",
    before: "is_some_and(u8::is_ascii_uppercase)",
    after: "is_some_and(u8::is_ascii_alphabetic)",
    witness: "ports.prefix",
    matches: 1,
  },
  {
    name: "generic-port-check-inverted",
    file: "hexagon/ports.rs",
    before: '.is_some()\n            .then_some("generic port")',
    after: '.is_none()\n            .then_some("generic port")',
    witness: "ports.generic",
    matches: 1,
  },
  {
    name: "generic-function-confused-with-alias-parameters",
    file: "hexagon/ports.rs",
    before: 'return node\n            .node("typeParameters")',
    after:
      'return node.node("typeAnnotation").and_then(|body| body.node("typeParameters"))',
    witness: "ports.generic",
    matches: 1,
  },
  {
    name: "partial-unreadable-bag-emitted",
    file: "hexagon/ports.rs",
    before: "members.iter().copied().find_map(member_reason)",
    after: "None::<&'static str>",
    witness: "ports.memberShapes",
    matches: 1,
  },
  {
    name: "duplicate-members-accepted",
    file: "hexagon/ports.rs",
    before: "if !names.insert(name) {",
    after: "if { let _ = names.insert(name); false } {",
    witness: "ports.duplicate",
    matches: 1,
  },
  {
    name: "declaration-merges-not-refused",
    file: "hexagon/ports.rs",
    before: "counts.get(&entry.name).copied().unwrap_or(0) > 1",
    after: "counts.get(&entry.name).copied().unwrap_or(0) > 2",
    witness: "ports.merge",
    matches: 1,
  },
  {
    name: "optional-member-name-loses-question-mark",
    file: "hexagon/ports.rs",
    before: 'name.push_str("?");',
    after: 'name.push_str("");',
    witness: "ports.properties",
    matches: 1,
  },
  {
    name: "parenthesized-reference-treated-as-exact-port",
    file: "hexagon/ports.rs",
    before: ".get(&member.type_text)",
    after:
      ".get(&JsString::from(member.type_text.to_lossy().trim_matches(['(',')'])))",
    witness: "ports.exactUse",
    matches: 1,
  },
  {
    name: "used-ports-still-listed-unbagged",
    file: "hexagon/ports.rs",
    before: ".filter(|port| !used.contains(&port.name))",
    after: ".filter(|port| { let _ = &used; let _ = port; true })",
    witness: "ports.exactUse",
    matches: 1,
  },
  {
    name: "type-reference-port-rejected",
    file: "hexagon/ports.rs",
    before: '"TSFunctionType" | "TSTypeReference"',
    after: '"TSFunctionType"',
    witness: "ports.ports",
    matches: 1,
  },
  {
    name: "let-binding-becomes-factory",
    file: "hexagon/read.rs",
    before:
      'node.kind() != "VariableDeclaration" || node.string("kind") != Some("const")',
    after: 'node.kind() != "VariableDeclaration"',
    witness: "factory.let",
    matches: 1,
  },
  {
    name: "parenthesized-initializer-becomes-factory",
    file: "hexagon/read.rs",
    before: '"ArrowFunctionExpression" | "FunctionExpression"',
    after:
      '"ArrowFunctionExpression" | "FunctionExpression" | "ParenthesizedExpression"',
    witness: "factory.wrapped",
    matches: 1,
  },
  {
    name: "filename-score-no-longer-first",
    file: "hexagon/read.rs",
    before: "if file == &preferred {\n            return 0;",
    after: "if file == &preferred {\n            return 2;",
    witness: "factory.filename-rank",
    matches: 1,
  },
  {
    name: "factory-needs-only-one-readable-bag",
    file: "hexagon/read.rs",
    before: "names.contains(&feature) && names.contains(&driven)",
    after: "names.contains(&feature) || names.contains(&driven)",
    witness: "factory.requires-both-bags",
    matches: 1,
  },
  {
    name: "factory-file-tie-order-reversed",
    file: "hexagon/read.rs",
    before: ".then_with(|| a.0.cmp(b.0))",
    after: ".then_with(|| b.0.cmp(a.0))",
    witness: "factory.file-rank-distinct-features",
    matches: 1,
  },
  {
    name: "factory-name-tie-order-reversed",
    file: "hexagon/read.rs",
    before: ".then_with(|| a.1.cmp(b.1))",
    after: ".then_with(|| b.1.cmp(a.1))",
    witness: "factory.file-and-name-rank",
    matches: 1,
  },
  {
    name: "factory-basename-replaces-lone-utf16",
    file: "hexagon/read.rs",
    before: "basename_path_text(root)",
    after: "basename_path_text(&root.to_lossy().into())",
    witness: "read.basename-raw",
    matches: 1,
  },
  {
    name: "visible-file-order-uses-utf8",
    file: "hexagon/read.rs",
    before: "files.sort();",
    after: "files.sort_by(|a,b| a.to_lossy().cmp(&b.to_lossy()));",
    witness: "read.layout-unicodeFiles",
    matches: 1,
  },
  {
    name: "member-order-uses-utf8",
    file: "hexagon/ports.rs",
    before: "members.sort_by(|a, b| a.name.cmp(&b.name));",
    after: "members.sort_by(|a,b| a.name.to_lossy().cmp(&b.name.to_lossy()));",
    witness: "ports.unicodeOrder",
    matches: 1,
  },
  {
    name: "syntax-failure-mislabeled-as-read-error",
    file: "hexagon/read.rs",
    before: 'reason: "cannot parse source".into(),',
    after: 'reason: "cannot read source".into(),',
    witness: "read.layout-malformedPorts",
    matches: 1,
  },
  {
    name: "adapter-source-parsed-as-usecase",
    file: "hexagon/read.rs",
    before:
      'if file.starts_with("application/")\n            && units.ends_with(&[116, 115])\n            && units.len() >= 3\n            && units[units.len() - 3] == 46\n            && !units[12..].contains(&47)',
    after:
      'if (file.starts_with("application/")\n            && units.ends_with(&[116, 115])\n            && units.len() >= 3\n            && units[units.len() - 3] == 46\n            && !units[12..].contains(&47)) || file.starts_with("adapters/")',
    witness: "read.layout-visibility",
    matches: 1,
  },
  {
    name: "directory-order-left-to-native-enumeration",
    file: "hexagon/read.rs",
    before: "entries.sort_by_key(|entry| entry.file_name());",
    after: ";",
    witness: "read.layout-unreadableReverse",
    matches: 1,
  },
  {
    name: "directory-order-uses-report-utf16",
    file: "hexagon/read.rs",
    before: "entries.sort_by_key(|entry| entry.file_name());",
    after:
      "entries.sort_by_key(|entry| entry.file_name().to_string_lossy().encode_utf16().collect::<Vec<_>>());",
    witness: "read.layout-unreadableUnicode",
    matches: 1,
  },
  {
    name: "published-line-fact-truncated",
    file: "hexagon/render.rs",
    before: "number(item.line)",
    after: "number(item.line as i64 as f64)",
    witness: "render.line-1.5-text",
    matches: 1,
  },
  {
    name: "renderer-replaces-lone-utf16",
    file: "hexagon/render.rs",
    before: "line.extend(&member.name);",
    after: "line.push_str(&member.name.to_lossy());",
    witness: "render.raw-data",
    matches: 1,
  },
  {
    name: "pure-json-renderer-ignores-pretty",
    file: "hexagon/render.rs",
    before: "stable_stringify(report, pretty)",
    after: "stable_stringify(report, false)",
    witness: "render.line-1.5-pretty",
    matches: 1,
  },
  {
    name: "emit-error-does-not-call-report",
    file: "hexagon/cli.rs",
    before: "if let Err(report) = (out.report)(&processing.message()) {",
    after: "if let Err(report) = Ok::<(),ApiError>(()) {",
    witness: "run.callbacks-callback-ok",
    matches: 1,
  },
  {
    name: "escaping-report-error-swallowed",
    file: "hexagon/cli.rs",
    before:
      "return Err(HexagonRunError {\n                    report: Box::new(report),\n                    processing: Box::new(processing),\n                });",
    after:
      "let _ = report; return Ok(HexagonRunOutcome { failure: Some(processing) });",
    witness: "run.callbacks-callback-callback",
    matches: 1,
  },
  {
    name: "escaping-report-message-loses-precedence",
    file: "hexagon/cli.rs",
    before: "self.report.message()",
    after: "self.processing.message()",
    witness: "run.callbacks-callback-callback",
    matches: 1,
  },
  {
    name: "original-processing-cause-erased",
    file: "hexagon/cli.rs",
    before: "processing: Box::new(processing),",
    after:
      "processing: Box::new(HexagonFailure::Emit(ApiError::Callback(crate::api::map::ApiCallbackError::new(processing.message())))),",
    witness: "run.callbacks-callback-callback",
    matches: 1,
  },
  {
    name: "original-report-cause-erased",
    file: "hexagon/cli.rs",
    before: "report: Box::new(report),",
    after:
      "report: Box::new(ApiError::Callback(crate::api::map::ApiCallbackError::new(report.message()))),",
    witness: "run.callbacks-callback-callback",
    matches: 1,
  },
  {
    name: "reported-failure-data-discarded",
    file: "hexagon/cli.rs",
    before: "failure: Some(processing),",
    after: "failure: { let _ = processing; None },",
    witness: "run.callbacks-callback-ok",
    matches: 1,
  },
  {
    name: "hexagon-success-resets-prior-exit",
    file: "cli/frontdoor.rs",
    before: "Ok(HexagonDispatch::Complete(result))",
    after:
      "host.assign_exit(0.0).unwrap(); Ok(HexagonDispatch::Complete(result))",
    witness: "cli.prior-exit-preserved",
    matches: 1,
  },
  {
    name: "inactive-hexagon-executes-other-mode",
    file: "cli/frontdoor.rs",
    before: "if self.options.hexagon() != Some(true) {",
    after: "if false {",
    witness: "continue.other-mode",
    matches: 1,
  },
  {
    name: "requested-hexagon-remains-unexecuted",
    file: "cli/frontdoor.rs",
    before: "if self.options.hexagon() != Some(true) {",
    after: "if true {",
    witness: "cli.fixture-full-text",
    matches: 1,
  },
  {
    name: "cli-json-flag-not-forwarded",
    file: "cli/frontdoor.rs",
    before: "json: self.options.json() == Some(true),",
    after: "json: false,",
    witness: "cli.fixture-full-json",
    matches: 2,
  },
  {
    name: "cli-pretty-flag-not-forwarded",
    file: "cli/frontdoor.rs",
    before: "pretty: self.options.pretty() == Some(true),",
    after: "pretty: false,",
    witness: "cli.fixture-full-pretty",
    matches: 2,
  },
  {
    name: "hexagon-emit-error-uses-api-crash-exit",
    file: "cli/frontdoor.rs",
    before: "Ok(HexagonDispatch::Complete(result))",
    after:
      "if result.failure.is_some() { host.assign_exit(3.0).unwrap(); } Ok(HexagonDispatch::Complete(result))",
    witness: "cli.out-missing-parent",
    matches: 1,
  },
  {
    name: "queued-stdio-error-enters-hexagon-catch",
    file: "cli/frontdoor.rs",
    before:
      "let mut emit = |payload: &JsString| output.emit(&mut bridge.borrow_mut(), payload);",
    after:
      'let mut emit = |payload: &JsString| {\n                let result = output.emit(&mut bridge.borrow_mut(), payload);\n                if !bridge.borrow().pending_stdio_failures().is_empty() { return Err(crate::api::map::ApiError::Callback(crate::api::map::ApiCallbackError::new("wrong synchronous stdio catch".into()))); }\n                result\n            };',
    witness: "cli.stdout-bad",
    matches: 2,
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
      path.join(root, "verification/parity/graph-hexagon.mts"),
      executable,
      report,
    ],
    {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      env: { ...environment, DEMLIK_HEXAGON_CASES: ids.join(",") },
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
  assert.equal(before.report.rejectedInvalidInputs, 9);
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
        "hexagon_driver",
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
    assert.equal(result.report.rejectedInvalidInputs, 9, mutation.name);
    assert.ok(
      result.report.failures.some((row) => row.id === mutation.witness),
      mutation.name + JSON.stringify(result.report.failures),
    );
    controls.push({
      ...mutation,
      detected: true,
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
