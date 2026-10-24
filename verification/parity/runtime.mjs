import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const require = createRequire(import.meta.url);
const scenarios = [
  "serial",
  "restored",
  "missing-handler",
  "handler-failure",
  "no-store",
  "terminal-boot",
];
const cases = ["promise", "effect"].flatMap((profile) =>
  scenarios.map((scenario) => ({
    id: `runtime.${profile}.${scenario}`,
    input: { profile, scenario },
  })),
);
const invalid = [
  "not json",
  JSON.stringify({
    id: "invalid-profile",
    input: { profile: "unknown", scenario: "serial" },
  }),
  JSON.stringify({
    id: "invalid-scenario",
    input: { profile: "promise", scenario: "unknown" },
  }),
];
const serialTrace = [
  "save:0",
  "commit:boot:0",
  "save:1",
  "Batch",
  "Last",
  "commit:Start:1",
  "save:3",
  "commit:Added:3",
  "save:7",
  "commit:Added:7",
  "save:15",
  "commit:Added:15",
  "save:15",
  "commit:Finish:15",
];

export async function runtimeParity(cargo, options = {}) {
  if (!options.binary)
    execFileSync(
      cargo,
      [
        "build",
        "--locked",
        "--package",
        "demlik-tea",
        "--example",
        "runtime_driver",
      ],
      { cwd: root, stdio: "inherit" },
    );
  const binary =
    options.binary ?? path.join(root, "target/debug/examples/runtime_driver");
  const input = `${[...cases.map((test) => JSON.stringify(test)), ...invalid].join("\n")}\n`;
  function run(program, args) {
    const output = execFileSync(program, args, {
      cwd: root,
      input,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
    const answers = output
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(
      answers.length,
      cases.length + invalid.length,
      "incomplete runtime answer stream",
    );
    return answers;
  }
  const typescript = run(process.execPath, [
    "--import",
    require.resolve("tsx"),
    path.join(here, "runtime-typescript.mts"),
  ]);
  const rust = run(binary, []);
  const evidence = {};
  const failures = [];
  for (const [index, test] of cases.entries()) {
    try {
      for (const [language, answer] of [
        ["TypeScript", typescript[index]],
        ["Rust", rust[index]],
      ]) {
        assert.equal(answer.id, test.id, `${language}: runtime response order`);
        assert.equal(
          answer.ok,
          true,
          `${language}: ${test.id}: ${JSON.stringify(answer.error)}`,
        );
        const state = {
          n:
            test.input.scenario === "terminal-boot"
              ? 7
              : test.input.scenario === "restored"
                ? 20
                : ["missing-handler", "handler-failure"].includes(
                      test.input.scenario,
                    )
                  ? 1
                  : 15,
          done: test.input.scenario !== "missing-handler",
        };
        assert.deepEqual(
          answer.output.state,
          state,
          `${language}: independent final state`,
        );
        assert.deepEqual(
          answer.output.result,
          state.done ? state : null,
          `${language}: saved terminal result`,
        );
        assert.deepEqual(
          answer.output.done,
          state.done ? state : null,
          `${language}: terminal completion`,
        );
        assert.deepEqual(
          answer.output.saved,
          test.input.scenario === "no-store" ? null : state,
        );
        assert.deepEqual(answer.output.afterStop.saved, answer.output.saved);
        assert.equal(
          answer.output.failure,
          test.input.scenario === "handler-failure" ? "handler" : null,
        );
        assert.deepEqual(answer.output.reports, []);
        if (test.input.scenario === "serial")
          assert.deepEqual(
            answer.output.trace,
            serialTrace,
            `${language}: independent serial order`,
          );
      }
      assert.deepEqual(rust[index].output, typescript[index].output, test.id);
      assert.ok(rust[index].observedCalls.length > 0);
      evidence[test.id] = rust[index].observedCalls;
    } catch (error) {
      failures.push({
        id: test.id,
        operation: "tea.runtime",
        input: test.input,
        message: error.message,
        typescript: typescript[index],
        rust: rust[index],
      });
    }
  }
  for (let index = 0; index < scenarios.length; index++) {
    assert.deepEqual(
      typescript[index].output,
      typescript[index + scenarios.length].output,
      `${scenarios[index]}: Promise / Effect conformance`,
    );
  }
  for (const [language, answers] of [
    ["TypeScript", typescript],
    ["Rust", rust],
  ]) {
    for (const answer of answers.slice(cases.length)) {
      assert.equal(
        answer.ok,
        false,
        `${language}: invalid runtime input accepted`,
      );
      assert.ok(answer.error);
      if (language === "Rust") assert.deepEqual(answer.observedCalls, []);
    }
  }
  const reportFile =
    options.reportFile ?? path.join(root, "target/parity/runtime.json");
  const report = {
    passed: cases.length - failures.length,
    failures,
    rejectedInvalidInputs: invalid.length * 2,
    profiles: [
      "TypeScript Promise",
      "TypeScript Effect",
      "Rust Promise",
      "Rust Effect",
    ],
    rustBinarySha256: createHash("sha256")
      .update(await readFile(binary))
      .digest("hex"),
    cases: cases.map((test, index) => ({
      ...test,
      typescript: typescript[index],
      rust: rust[index],
    })),
  };
  await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  return {
    ...report,
    cases: cases.length,
    reportFile,
    nativeEvidence: evidence,
  };
}
