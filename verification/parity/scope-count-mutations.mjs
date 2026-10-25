import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
  scopeCountReference,
  scopeCountSchema,
  scopeOrderingCases,
} from "./scope-count-reference.mjs";

const baseline = process.argv[2];
assert.ok(
  baseline,
  "usage: node --import tsx scope-count-mutations.mjs <baseline-driver> [evidence.json]",
);
assert.ok(process.argv.length <= 4);
assert.equal(process.version, "v22.21.1");
assert.equal(process.versions.v8, "12.4.254.21-node.33");
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const directory = await mkdtemp(
  path.join(tmpdir(), "demlik-scope-count-faults-"),
);
const workspace = path.join(directory, "workspace");
const targetDirectory = path.join(
  root,
  "target/parity/shape-judgment-mutation-build",
);
const targetBinary = path.join(
  targetDirectory,
  "debug/examples/scope_count_driver",
);
const buildEnvironment = {
  ...process.env,
  CARGO_PROFILE_DEV_DEBUG: "0",
  CARGO_PROFILE_TEST_DEBUG: "0",
  CARGO_INCREMENTAL: "0",
  CARGO_BUILD_JOBS: "1",
  CARGO_TARGET_DIR: targetDirectory,
};
const owner = "crates/code-graph/src/ratchet/scope_count.rs",
  ordering = "crates/code-graph/src/ratchet/scope_count/ordering.rs";
const normalize = (value) => JSON.parse(JSON.stringify(value));
function item(id, input) {
  return {
    id,
    operation: "code_graph.scope-count",
    input: scopeCountSchema.parse(input),
  };
}
const limits = { default: 0, scopes: [] };
function evaluation(id, measurements, ceilings = limits) {
  return item(id, {
    action: "evaluate",
    measurements,
    ceilings,
    title: "COUNT",
  });
}
function call(binary, item, allowPanic = false) {
  const run = spawnSync(binary, [], {
    input: `${JSON.stringify(item)}\n`,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (allowPanic && run.status !== 0) {
    assert.match(
      run.stderr,
      /comparison function does not correctly implement a total order/,
    );
    return { nativePanic: run.stderr, exitCode: run.status };
  }
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stderr, "");
  const reply = JSON.parse(run.stdout);
  assert.equal(reply.id, item.id);
  assert.equal(reply.ok, true, JSON.stringify(reply.error));
  assert.ok(reply.observedCalls.length);
  return reply.output;
}
const rowFacts = (rows) =>
  rows
    .map((row) =>
      JSON.stringify(
        Object.entries(row).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      ),
    )
    .sort();
function changedOrder(actual, expected) {
  assert.notDeepEqual(
    actual.table.verdict.violations,
    expected.table.verdict.violations,
  );
  assert.deepEqual(
    rowFacts(actual.table.verdict.violations),
    rowFacts(expected.table.verdict.violations),
    "order fault preserves every row fact",
  );
  assert.deepEqual(actual.recorded, expected.recorded);
  assert.deepEqual(actual.measurementsAfter, expected.measurementsAfter);
  assert.deepEqual(actual.ceilingsAfter, expected.ceilingsAfter);
}
const baselineHash = createHash("sha256")
  .update(await readFile(baseline))
  .digest("hex");
const controls = [];
try {
  const missing = path.join(directory, "missing.json");
  const mutations = [
    {
      name: "fractional-schema-number-accepted",
      file: owner,
      before: "if number.fract() != 0.0 {",
      after: "if false {",
      item: item("fraction-is-not-an-int", {
        action: "parse",
        value: { default: 0.5 },
      }),
      beforeCheck: (answer) => assert.equal(answer.success, false),
      afterCheck: (answer) => assert.equal(answer.success, true),
    },
    {
      name: "unsafe-schema-integer-accepted",
      file: owner,
      before: "if number.abs() > SAFE {",
      after: "if false {",
      item: item("unsafe-integer-rejected", {
        action: "parse",
        value: { default: Number.MAX_SAFE_INTEGER + 1 },
      }),
      beforeCheck: (answer) => assert.equal(answer.issues[0].code, "too_big"),
      afterCheck: (answer) => assert.equal(answer.success, true),
    },
    {
      name: "record-constructor-typeerror-becomes-issue",
      file: owner,
      before: ".map(record_object)",
      after: ".map(|value| Ok(value.as_object()))",
      item: item("record-typeerror-is-not-normal-schema-refusal", {
        action: "parse",
        value: { default: -1, scopes: { constructor: null } },
      }),
      beforeCheck: (answer) => assert.equal(answer.thrown.name, "TypeError"),
      afterCheck: (answer) => assert.equal(answer.success, false),
    },
    {
      name: "proto-key-validated-in-zod-record",
      file: owner,
      before: 'if key == "__proto__" {',
      after: "if false {",
      item: item("zod-record-drops-proto-before-number-validation", {
        action: "parse",
        value: JSON.parse('{"scopes":{"__proto__":null}}'),
      }),
      beforeCheck: (answer) => assert.equal(answer.success, true),
      afterCheck: (answer) =>
        assert.equal(
          answer.issues[0].message,
          "Invalid input: expected number, received null",
        ),
    },
    {
      name: "record-drops-unmeasured-scopes",
      file: owner,
      before: "let mut scopes = ceilings.scopes.clone();",
      after: "let mut scopes = IndexMap::new();",
      item: evaluation("unmeasured-scopes-retained", [], {
        default: 0,
        scopes: [["stale", 7]],
      }),
      beforeCheck: (answer) =>
        assert.deepEqual(answer.recorded.scopes, { stale: 7 }),
      afterCheck: (answer) => assert.deepEqual(answer.recorded.scopes, {}),
    },
    {
      name: "record-invents-own-proto-number",
      file: owner,
      before:
        'if measurement.scope != "__proto__" || scopes.contains_key(&measurement.scope) {',
      after: "if true {",
      item: evaluation("numeric-proto-assignment-does-not-create-a-key", [
        { scope: "__proto__", count: 2 },
      ]),
      beforeCheck: (answer) =>
        assert.equal(Object.hasOwn(answer.recorded.scopes, "__proto__"), false),
      afterCheck: (answer) => assert.equal(answer.recorded.scopes.__proto__, 2),
    },
    {
      name: "inherited-function-masked-as-nan",
      file: owner,
      before:
        "} else if let Some(name) = object_prototype_function_name(scope) {\n            CeilingValue::InheritedFunction(name)",
      after:
        "} else if let Some(_name) = object_prototype_function_name(scope) {\n            CeilingValue::Number(f64::NAN)",
      item: evaluation("inherited-function-is-omitted-not-null", [
        { scope: "constructor", count: 1 },
      ]),
      beforeCheck: (answer) =>
        assert.equal(
          Object.hasOwn(answer.table.verdict.violations[0], "ceiling"),
          false,
        ),
      afterCheck: (answer) =>
        assert.equal(answer.table.verdict.violations[0].ceiling, null),
    },
    {
      name: "missing-file-refused-instead-of-defaulted",
      file: owner,
      before: "if !std::path::Path::new(&file.to_lossy()).exists() {",
      after: "if false {",
      item: item("missing-file-defaults", { action: "read", file: missing }),
      beforeCheck: (answer) =>
        assert.deepEqual(answer, {
          ceilings: { default: 0, scopes: {} },
          messages: [],
        }),
      afterCheck: (answer) => assert.equal(answer.ceilings, null),
    },
    {
      name: "scope-prefix-opens-sibling",
      file: owner,
      before: "scope.units().starts_with(prefix.units())",
      after: "scope.units().starts_with(under.units())",
      item: item("under-requires-folder-separator", {
        action: "paths",
        repoRoot: "/repo",
        absolute: "/repo",
        scopes: ["services/a", "services/ab", "services/a/child"],
        under: "services/a",
      }),
      beforeCheck: (answer) =>
        assert.deepEqual(answer.selected, ["services/a", "services/a/child"]),
      afterCheck: (answer) =>
        assert.ok(answer.selected.includes("services/ab")),
    },
    {
      name: "root-scope-left-empty",
      file: owner,
      before: 'Ok(if relative.is_empty() {\n        ".".into()',
      after: "Ok(if relative.is_empty() {\n        relative",
      item: item("root-is-dot", {
        action: "paths",
        repoRoot: "/repo",
        absolute: "/repo",
        scopes: [],
        under: ".",
      }),
      beforeCheck: (answer) => assert.equal(answer.scope, "."),
      afterCheck: (answer) => assert.equal(answer.scope, ""),
    },
    {
      name: "direction-check-inverted",
      file: owner,
      before: "violation.direction == direction",
      after: "violation.direction != direction",
      item: evaluation("has-direction-reads-actual-violations", [
        { scope: "a", count: -1 },
      ]),
      beforeCheck: (answer) => assert.equal(answer.table.hasExceeded, false),
      afterCheck: (answer) => assert.equal(answer.table.hasExceeded, true),
    },
  ];
  const orderingCases = scopeOrderingCases().map((row) =>
    item(row.id, row.input),
  );
  const sortMutations = [
    {
      name: "std-sort-assumes-a-total-order",
      file: owner,
      before: "ordering::sort(&mut violations);",
      after:
        "violations.sort_by(|left,right| right.delta.abs().partial_cmp(&left.delta.abs()).unwrap_or(std::cmp::Ordering::Equal).then_with(||crate::project::locale_compare_units(left.scope.units(),right.scope.units())));",
      allowPanic: true,
    },
    {
      name: "linear-insertion-comparison-schedule",
      file: ordering,
      before: "let middle = left + (right - left) / 2;",
      after: "let middle = right - 1;",
    },
    {
      name: "equal-rows-start-a-descending-run",
      file: ordering,
      before:
        "let descending = self.compare(self.work[low + 1], self.work[low]).is_lt();",
      after:
        "let descending = self.compare(self.work[low + 1], self.work[low]).is_le();",
    },
    {
      name: "minimum-run-boundary-is-32",
      file: ordering,
      before: "while n >= 64 {",
      after: "while n >= 32 {",
    },
    {
      name: "low-merge-reverses-equal-rows",
      file: ordering,
      before:
        ".compare(self.work[cursor_b], self.temp[cursor_a])\n                    .is_lt()",
      after:
        ".compare(self.work[cursor_b], self.temp[cursor_a])\n                    .is_le()",
    },
    {
      name: "high-merge-reverses-equal-rows",
      file: ordering,
      before:
        ".compare(self.temp[cursor_b - 1], self.work[cursor_a - 1])\n                    .is_lt()",
      after:
        ".compare(self.temp[cursor_b - 1], self.work[cursor_a - 1])\n                    .is_le()",
    },
    {
      name: "galloping-never-entered",
      file: ordering,
      before: "min_gallop: 7,",
      after: "min_gallop: usize::MAX,",
    },
    {
      name: "gallop-exit-penalty-changes-next-merge",
      file: ordering,
      before: "minimum += 1;\n            self.min_gallop = minimum;",
      after: "minimum += 7;\n            self.min_gallop = minimum;",
      occurrences: 2,
    },
  ];
  const checked = new Map();
  for (const candidate of [
    ...mutations.map((row) => row.item),
    ...orderingCases,
  ]) {
    const expected = normalize(scopeCountReference(candidate.input));
    const actual = call(baseline, candidate);
    assert.deepEqual(
      actual,
      expected,
      `${candidate.id}: baseline/source mismatch`,
    );
    checked.set(candidate.id, expected);
  }
  for (const mutation of mutations)
    mutation.beforeCheck(checked.get(mutation.item.id));
  await mkdir(workspace);
  for (const entry of ["Cargo.toml", "Cargo.lock", "crates"])
    await cp(path.join(root, entry), path.join(workspace, entry), {
      recursive: true,
    });
  const originals = new Map();
  for (const mutation of [...mutations, ...sortMutations])
    if (!originals.has(mutation.file))
      originals.set(
        mutation.file,
        await readFile(path.join(root, mutation.file), "utf8"),
      );
  for (const mutation of [...sortMutations, ...mutations]) {
    for (const [file, original] of originals)
      await writeFile(path.join(workspace, file), original);
    const original = originals.get(mutation.file);
    assert.equal(
      original.split(mutation.before).length,
      (mutation.occurrences ?? 1) + 1,
      `fault sites: ${mutation.name}`,
    );
    await writeFile(
      path.join(workspace, mutation.file),
      original.replaceAll(mutation.before, mutation.after),
    );
    execFileSync(
      process.env.CARGO ?? "cargo",
      [
        "build",
        "--offline",
        "-p",
        "demlik-code-graph",
        "--example",
        "scope_count_driver",
      ],
      {
        cwd: workspace,
        env: buildEnvironment,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        stdio: "pipe",
      },
    );
    let witness;
    for (const candidate of mutation.item ? [mutation.item] : orderingCases) {
      const expected = checked.get(candidate.id);
      const actual = call(targetBinary, candidate, mutation.allowPanic);
      if (isDeepStrictEqual(actual, expected)) continue;
      if (mutation.afterCheck) mutation.afterCheck(actual);
      else if (!actual.nativePanic) changedOrder(actual, expected);
      witness = { item: candidate, expected, mutant: actual };
      break;
    }
    assert.ok(witness, `${mutation.name}: escaped`);
    controls.push({ name: mutation.name, detected: true, ...witness });
    process.stdout.write(
      `${JSON.stringify({ detected: mutation.name, witness: witness.item.id })}\n`,
    );
  }
  assert.equal(
    createHash("sha256")
      .update(await readFile(baseline))
      .digest("hex"),
    baselineHash,
    "isolated fault target preserves baseline driver",
  );
  const report = {
    detected: controls.length,
    escaped: 0,
    reference: { node: process.version, v8: process.versions.v8 },
    baselineMatchesSource: true,
    baselineDriverUnchanged: true,
    baselineDriverHash: baselineHash,
    buildProfile: {
      devDebug: 0,
      testDebug: 0,
      incremental: false,
      jobs: 1,
      target: targetDirectory,
    },
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
