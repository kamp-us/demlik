import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const owner = "crates/tea/src/compose.rs";
const faults = [
  {
    id: "compose-reverses-read-order",
    needle: "for step in order {",
    fault:
      "for step in order.into_iter().collect::<Vec<_>>().into_iter().rev() {",
    witness: "compose.read.precedence.answer.throw",
  },
  {
    id: "compose-skips-first-reader",
    needle: "for step in order {",
    fault: "for step in order.into_iter().skip(1) {",
    witness: "compose.read.answer-2",
  },
  {
    id: "compose-swallows-original-error",
    needle: "(step.borrow().read)(input)?",
    fault: "(step.borrow().read)(input).ok().flatten()",
    witness: "compose.read.error-7",
  },
  {
    id: "compose-snapshots-live-iterator",
    needle: "for step in order {",
    fault: "for step in order.into_iter().collect::<Vec<_>>() {",
    witness: "compose.read.live-append",
  },
  {
    id: "compose-truncates-deferred-reads",
    needle: "for step in order {",
    fault: "for step in order.into_iter().take(1) {",
    witness: "compose.read.undefined-only-defers",
  },
  {
    id: "compose-drops-commands",
    needle: "Step::new(replace(host, step.state), step.commands)",
    fault: "Step::new(replace(host, step.state), vec![])",
    witness: "compose.workflow.refresh.false",
  },
  {
    id: "compose-reverses-commands",
    needle: "Step::new(replace(host, step.state), step.commands)",
    fault:
      "Step::new(replace(host, step.state), step.commands.into_iter().rev().collect())",
    witness: "compose.workflow.refresh.false",
  },
  {
    id: "compose-skips-field-replacement",
    needle: "Step::new(replace(host, step.state), step.commands)",
    fault:
      "{ drop(replace); drop(step.state); Step::new(host, step.commands) }",
    witness: "compose.lift.right.false.7.3",
  },
];
const hash = (v) => createHash("sha256").update(v).digest("hex");
function command(program, args, options = {}) {
  const r = spawnSync(program, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
  return {
    command: [program, ...args],
    exit: r.status,
    stdout: r.stdout,
    stderr: r.stderr,
    error: r.error?.message,
  };
}
function adapter(root, binary, file, id) {
  const r = command(
    process.execPath,
    [
      "--import",
      join(root, "verification/parity/node_modules/tsx/dist/loader.mjs"),
      join(root, "verification/parity/compose.mts"),
      "--native-bin",
      binary,
      "--report",
      file,
      ...(id ? ["--case-id", id] : []),
    ],
    { cwd: root },
  );
  assert([0, 1].includes(r.exit), JSON.stringify(r));
  return { run: r, report: JSON.parse(readFileSync(file, "utf8")) };
}
export function composeMutations({
  binary,
  reportFile = "target/parity/compose-controls.json",
  only,
} = {}) {
  assert(binary);
  const root = process.cwd(),
    source = readFileSync(owner, "utf8"),
    controls = [];
  reportFile = resolve(reportFile);
  mkdirSync(dirname(reportFile), { recursive: true });
  const baseline = adapter(
    root,
    resolve(binary),
    `${reportFile}.baseline.json`,
  );
  assert.equal(baseline.run.exit, 0);
  for (const f of faults.filter((f) => !only || only.includes(f.id))) {
    assert.equal(source.split(f.needle).length, 2, `${f.id}: unique mutation`);
    const temporary = mkdtempSync(join(tmpdir(), "demlik-compose-mutant-")),
      target = mkdtempSync(join(tmpdir(), "demlik-compose-mutant-target-"));
    try {
      for (const path of ["Cargo.toml", "Cargo.lock", "crates"])
        cpSync(join(root, path), join(temporary, path), { recursive: true });
      const changed = source.replace(f.needle, f.fault);
      writeFileSync(join(temporary, owner), changed);
      const env = {
        ...process.env,
        CARGO_TARGET_DIR: target,
        CARGO_NET_OFFLINE: "true",
        CARGO_BUILD_JOBS: "1",
        CARGO_INCREMENTAL: "0",
        CARGO_PROFILE_DEV_DEBUG: "0",
        CARGO_PROFILE_TEST_DEBUG: "0",
      };
      const build = command(
        process.env.CARGO ?? "cargo",
        [
          "build",
          "--locked",
          "--offline",
          "--message-format=json",
          "-p",
          "demlik-tea",
          "--example",
          "compose_driver",
        ],
        { cwd: temporary, env },
      );
      assert.equal(
        build.exit,
        0,
        `Compile/setup failure is not detection: ${f.id}\n${build.stderr}\n${build.stdout}`,
      );
      const events = build.stdout
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l));
      const executable = events.find(
        (e) => e.executable && e.target.name === "compose_driver",
      )?.executable;
      assert(executable);
      const result = adapter(
        root,
        executable,
        join(temporary, "result.json"),
        f.witness,
      );
      assert.equal(result.run.exit, 1, `${f.id}: behavioral mismatch required`);
      assert(result.report.failures.some((c) => c.id === f.witness));
      const saved = resolve(
        "target/parity/control-binaries/compose-controls",
        f.id,
      );
      mkdirSync(dirname(saved), { recursive: true });
      cpSync(executable, saved);
      controls.push({
        id: f.id,
        witness: f.witness,
        detectedIds: result.report.failures.map((c) => c.id),
        source: {
          path: owner,
          originalSha256: hash(source),
          mutatedSha256: hash(changed),
          needle: f.needle,
          fault: f.fault,
        },
        binary: { path: saved, sha256: hash(readFileSync(saved)) },
        build,
        result,
      });
      writeFileSync(
        `${reportFile}.progress.json`,
        `${JSON.stringify({ baseline: baseline.report.binary, controls }, null, 2)}\n`,
      );
    } finally {
      assert.equal(readFileSync(owner, "utf8"), source);
      rmSync(temporary, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  }
  const report = {
    baseline: {
      compared: baseline.report.compared,
      passed: baseline.report.passed,
      binary: baseline.report.binary,
    },
    controls,
    activeSourceUnchanged: readFileSync(owner, "utf8") === source,
    semanticPairs: 0,
  };
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
      only: { type: "string", multiple: true },
    },
    strict: true,
  });
  const r = composeMutations({
    binary: values["native-bin"],
    reportFile: values.report,
    only: values.only,
  });
  console.log(
    JSON.stringify({
      controls: r.controls.length,
      detected: r.controls.length,
      activeSourceUnchanged: r.activeSourceUnchanged,
    }),
  );
}
