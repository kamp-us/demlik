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
  "cli-parser-mutations",
);
let mutationFailure;
try {
  const directory = mutationCheck.root;
  const workspace = mutationCheck.root;
  const target = mutationCheck.target;
  const binary = path.join(target, "debug/examples/cli_parser_driver");
  const files = ["cli.rs", "cli/options.rs", "cli/help.rs", "cli/suggest.rs"];
  const original = new Map(
    files.map((file) => [
      file,
      fs.readFileSync(path.join(root, "crates/code-graph/src", file), "utf8"),
    ]),
  );
  const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const baselineHash = sha256(fs.readFileSync(baseline));
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
        path.join(root, "verification/parity/graph-cli-parser.mts"),
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
      name: "default-ranking-changed",
      file: "cli/options.rs",
      before: 'Text, DefaultValue::Text("rot")',
      after: 'Text, DefaultValue::Text("size")',
      witness: "isolation.fresh-defaults",
    },
    {
      name: "default-numeric-text-changed",
      file: "cli/options.rs",
      before: 'Text, DefaultValue::Text("90")',
      after: 'Text, DefaultValue::Text("91")',
      witness: "isolation.fresh-defaults",
    },
    {
      name: "default-marked-explicit",
      file: "cli/options.rs",
      before: "source: OptionSource::Default,",
      after: "source: OptionSource::Cli,",
      witness: "isolation.fresh-sources",
    },
    {
      name: "explicit-default-marked-default",
      file: "cli/options.rs",
      before: "source: OptionSource::Cli,",
      after: "source: OptionSource::Default,",
      witness: "handoff.api-explicit-default-refusal-order",
    },
    {
      name: "given-reversed-from-owned-key-order",
      file: "cli/options.rs",
      before:
        ".filter_map(|(id, setting)| (setting.source == OptionSource::Cli).then_some(*id))",
      after:
        ".filter_map(|(id, setting)| (setting.source == OptionSource::Cli).then_some(*id)).rev()",
      witness: "handoff.api-explicit-default-refusal-order",
    },
    {
      name: "preset-repeat-replaces-earlier",
      file: "cli/options.rs",
      before:
        'values.push(value.expect("required repeat value was consumed"));',
      after:
        'values.clear(); values.push(value.expect("required repeat value was consumed"));',
      witness: "option.entryPreset.repeat",
    },
    {
      name: "raw-text-value-replaced",
      file: "cli/options.rs",
      before:
        'OptionValue::Text(value.expect("required option value was consumed"))',
      after:
        'OptionValue::Text(value.expect("required option value was consumed").to_lossy().into())',
      witness: "option.api.raw-0",
    },
    {
      name: "flag-recorded-false",
      file: "cli/options.rs",
      before: "ValueKind::Flag => OptionValue::Flag(true)",
      after: "ValueKind::Flag => OptionValue::Flag(false)",
      witness: "option.json.before",
    },
    {
      name: "required-option-rejects-next-flag",
      file: "cli.rs",
      before: "options.apply(spec.id, Some(value.clone()));",
      after:
        "if maybe_option(value) { return CliParse {options,arguments:Vec::new(),outcome:ParseOutcome::Refused(CliParseError::MissingOptionValue(spec.id))}; } options.apply(spec.id, Some(value.clone()));",
      witness: "option.by.consumes-help",
    },
    {
      name: "equals-split-at-last-separator",
      file: "cli.rs",
      before: ".position(|unit| *unit == 61)",
      after: ".rposition(|unit| *unit == 61)",
      witness: "option.by.equal",
    },
    {
      name: "empty-equals-value-ignored",
      file: "cli.rs",
      before:
        "let flag = JsString::from_units(argument.units()[..index].to_vec());",
      after:
        "if index + 1 == argument.units().len() { continue; } let flag = JsString::from_units(argument.units()[..index].to_vec());",
      witness: "option.by.empty",
    },
    {
      name: "boolean-equals-accepted",
      file: "cli.rs",
      before: "&& spec.kind != ValueKind::Flag",
      after: "&& true",
      witness: "option.json.equal-is-unknown",
    },
    {
      name: "late-help-requires-only-help",
      file: "cli.rs",
      before: '.any(|argument| argument == "--help" || argument == "-h")',
      after:
        '.all(|argument| argument == "--help" || argument == "-h") && !unknown.is_empty()',
      witness: "parse.fixed-15",
    },
    {
      name: "literal-termination-drops-target",
      file: "cli.rs",
      before: "destination.extend(remaining.cloned());",
      after: "destination.extend(std::iter::empty::<JsString>());",
      witness: "parse.fixed-8",
    },
    {
      name: "unknown-option-stops-known-option-processing",
      file: "cli.rs",
      before: "while let Some(argument) = remaining.next() {",
      after:
        "while let Some(argument) = remaining.next() { if unknown_destination {unknown.push(argument.clone());continue;}",
      witness: "parse.fixed-10",
    },
    {
      name: "raw-unknown-message-replaced",
      file: "cli.rs",
      before: "out.extend(flag);",
      after: "out.push_str(&flag.to_lossy());",
      witness: "suggest.special-11",
    },
    {
      name: "help-width-ignored",
      file: "cli/help.rs",
      before: "let width = width.filter(|width| *width != 0).unwrap_or(80);",
      after: "let width = width.map(|_| 80usize).unwrap_or(80);",
      witness: "help.width-100",
    },
    {
      name: "help-minimum-column-width-shifted",
      file: "cli/help.rs",
      before: "if column_width < 40 {",
      after: "if column_width < 41 {",
      witness: "help.width-68",
    },
    {
      name: "help-default-description-omitted",
      file: "cli/help.rs",
      before: 'description.push_str(&format!(" (default: {value:?})"));',
      after: "let _ = value;",
      witness: "help.width-80",
    },
    {
      name: "short-unknown-gets-long-suggestions",
      file: "cli/suggest.rs",
      before: 'if !flag.starts_with("--") {',
      after: "if false {",
      witness: "suggest.special-10",
    },
    {
      name: "transposition-distance-omitted",
      file: "cli/suggest.rs",
      before:
        "distance[i][j] = distance[i][j].min(distance[i - 2][j - 2] + 1);",
      after: "let _ = distance[i - 2][j - 2];",
      witness: "suggest.deep.transposed",
    },
    {
      name: "help-not-a-suggestion-candidate",
      file: "cli/suggest.rs",
      before: '.chain(["--help"])',
      after: ".chain(std::iter::empty::<&str>())",
      witness: "suggest.special-2",
    },
  ];
  try {
    const before = pairs(baseline, "baseline");
    assert.equal(before.run.status, 0, before.run.stdout + before.run.stderr);
    assert.equal(before.report.passed, before.report.attempted);
    assert.equal(before.report.rejectedInvalidInputs, 9);

    for (const mutation of mutations) {
      for (const [file, text] of original)
        fs.writeFileSync(
          path.join(workspace, "crates/code-graph/src", file),
          text,
        );
      const source = original.get(mutation.file);
      assert.equal(source.split(mutation.before).length, 2, mutation.name);
      fs.writeFileSync(
        path.join(workspace, "crates/code-graph/src", mutation.file),
        source.replace(mutation.before, mutation.after),
      );
      const build = spawnSync(
        process.env.CARGO ?? "cargo",
        [
          "build",
          "--offline",
          "-p",
          "demlik-code-graph",
          "--example",
          "cli_parser_driver",
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
    assert.equal(sha256(fs.readFileSync(baseline)), baselineHash);
    for (const [file, text] of original)
      assert.equal(
        fs.readFileSync(path.join(root, "crates/code-graph/src", file), "utf8"),
        text,
      );
    const report = {
      detected: controls.length,
      escaped: 0,
      baselineCases: before.report.passed,
      invalidInputs: 9,
      baselineMatchesSource: true,
      baselineDriverUnchanged: true,
      baselineDriverSha256: baselineHash,
      sourceHashes: Object.fromEntries(
        [...original].map(([file, text]) => [file, sha256(text)]),
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
