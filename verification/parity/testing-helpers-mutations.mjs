import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  createCheckWorktree,
  checkedSpawnSync as spawnSync,
} from "./check-worktree.mjs";

const faults = [
  {
    id: "testing-step-boots",
    file: "crates/tea/src/testing.rs",
    changes: [
      {
        needle: "machine.update.apply(state, msg)",
        fault:
          "{ let _ = (machine.init)(None, _input); machine.update.apply(state, msg) }",
      },
    ],
    witness: "testing-helpers.free.counter.step",
  },
  {
    id: "testing-assertion-extra-boot",
    file: "crates/tea/src/testing.rs",
    changes: [
      {
        needle: "core::replay(machine, opts.loaded, input, opts.msgs)",
        occurrences: 4,
        fault:
          "{ let _ = (machine.init)(None, input); core::replay(machine, opts.loaded, input, opts.msgs) }",
      },
    ],
    witness: "testing-helpers.free.counter.final",
  },
  {
    id: "testing-contains-first-only",
    file: "crates/tea/src/testing.rs",
    changes: [
      {
        needle: "for command in &replay.commands {",
        fault: "for command in replay.commands.iter().take(1) {",
      },
    ],
    witness: "testing-helpers.free.counter.contains-middle",
  },
  {
    id: "testing-sequence-reverses-expected",
    file: "crates/tea/src/testing.rs",
    changes: [
      {
        needle: "actual.iter().zip(expected).enumerate()",
        fault: "actual.iter().zip(expected.iter().rev()).enumerate()",
      },
    ],
    witness: "testing-helpers.free.counter.sequence",
  },
  {
    id: "testing-swallows-matcher-error",
    file: "crates/tea/src/testing.rs",
    changes: [
      {
        needle: "equal(&replay.state, expected).map_err(CheckError::Matcher)?",
        fault: "equal(&replay.state, expected).unwrap_or(false)",
      },
      {
        needle: "equal(command, expected).map_err(CheckError::Matcher)?",
        fault: "equal(command, expected).unwrap_or(false)",
      },
      {
        needle: "equal(a, b).map_err(CheckError::Matcher)?",
        fault: "equal(a, b).unwrap_or(false)",
      },
    ],
    witness: "testing-helpers.free.counter.final-matcher-error",
  },
];
const digest = (value) => createHash("sha256").update(value).digest("hex");
function command(program, args, options = {}) {
  const p = spawnSync(program, args, {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
  assert.equal(
    p.status,
    0,
    `${program} ${args.join(" ")}\n${p.stdout}\n${p.stderr}`,
  );
  return p;
}
function parity(root, binary, reportFile, expectedExit) {
  const p = spawnSync(
    "pnpm",
    [
      "exec",
      "node",
      "--import",
      "./verification/parity/node_modules/tsx/dist/loader.mjs",
      "verification/parity/testing-helpers.mts",
      "--native-bin",
      binary,
      "--report",
      reportFile,
    ],
    { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  );
  assert.equal(p.status, expectedExit, `${p.stdout}\n${p.stderr}`);
  assert(
    existsSync(reportFile),
    `adapter did not write ${reportFile}\nstdout:\n${p.stdout}\nstderr:\n${p.stderr}`,
  );
  return JSON.parse(readFileSync(reportFile, "utf8"));
}
export function testingHelpersMutations({
  binary,
  reportFile = "target/parity/testing-helpers-controls.json",
  only,
} = {}) {
  assert(binary, "baseline binary required");
  const root = process.cwd();
  mkdirSync(dirname(resolve(reportFile)), { recursive: true });
  const baseline = parity(
    root,
    binary,
    resolve(`${reportFile}.baseline.json`),
    0,
  );
  assert.equal(baseline.passed, baseline.compared);
  const originals = new Map(
    [...new Set(faults.map((f) => f.file))].map((file) => [
      file,
      readFileSync(file, "utf8"),
    ]),
  );
  const controls = [];
  for (const f of faults.filter((f) => !only || only.includes(f.id))) {
    const source = originals.get(f.file);
    for (const change of f.changes)
      assert.equal(
        source.split(change.needle).length,
        (change.occurrences ?? 1) + 1,
        `${f.id} exact source site`,
      );
    const mutationCheck = createCheckWorktree(
      process.cwd(),
      "testing-helpers-mutations",
    );
    let mutationFailure;
    try {
      const temporary = mutationCheck.root,
        target = mutationCheck.target;
      try {
        let changed = source;
        for (const change of f.changes)
          changed = changed.replace(change.needle, change.fault);
        writeFileSync(join(temporary, f.file), changed);
        const build = command(
          process.env.CARGO ?? "cargo",
          [
            "build",
            "--locked",
            "-p",
            "demlik-tea",
            "--example",
            "testing_helpers_driver",
          ],
          {
            cwd: temporary,
            env: {
              ...process.env,
              CARGO_PROFILE_DEV_DEBUG: "0",
              CARGO_PROFILE_TEST_DEBUG: "0",
              CARGO_INCREMENTAL: "0",
              CARGO_BUILD_JOBS: "1",
              CARGO_NET_OFFLINE: "true",
            },
          },
        );
        const mutant = join(target, "debug/examples/testing_helpers_driver"),
          result = parity(root, mutant, join(temporary, "result.json"), 1),
          detectedIds = result.failures.map((c) => c.id);
        assert(
          detectedIds.includes(f.witness),
          `${f.id} must change its named behavioral witness`,
        );
        const saved = resolve(`target/parity/control-binaries/${f.id}`);
        mkdirSync(dirname(saved), { recursive: true });
        cpSync(mutant, saved);
        controls.push({
          id: f.id,
          compiled: true,
          witness: f.witness,
          detectedIds,
          source: {
            path: f.file,
            originalSha256: digest(source),
            mutatedSha256: digest(changed),
          },
          binary: { path: saved, sha256: digest(readFileSync(mutant)) },
          build: { exit: build.status, stderr: build.stderr },
          results: result,
        });
        writeFileSync(
          `${reportFile}.progress.json`,
          `${JSON.stringify({ baseline: baseline.binary, controls }, null, 2)}\n`,
        );
      } finally {
        for (const [file, before] of originals)
          assert.equal(readFileSync(file, "utf8"), before);
      }
    } catch (error) {
      mutationFailure = error;
      throw error;
    } finally {
      mutationCheck.remove(mutationFailure);
    }
  }
  const report = {
    baseline: {
      compared: baseline.compared,
      passed: baseline.passed,
      binary: baseline.binary,
    },
    controls,
    activeSourcesUnchanged: [...originals].every(
      ([file, source]) => readFileSync(file, "utf8") === source,
    ),
  };
  assert(report.activeSourcesUnchanged);
  writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const { values } = parseArgs({
    options: {
      "native-bin": { type: "string" },
      report: { type: "string" },
      only: { type: "string" },
    },
    strict: true,
  });
  const r = testingHelpersMutations({
    binary: values["native-bin"],
    reportFile: values.report,
    only: values.only?.split(","),
  });
  console.log(
    JSON.stringify({
      baseline: r.baseline.compared,
      controls: r.controls.map((c) => ({
        id: c.id,
        compiled: c.compiled,
        detected: c.detectedIds.length,
      })),
    }),
  );
}
