import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  assertCheckPath,
  cargoCheckEnvironment,
  compiledCheckLibrary,
  checkedSpawnSync as spawnSync,
} from "./check-worktree.mjs";

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
const moduleRoot = fileURLToPath(new URL("../..", import.meta.url));
const require = createRequire(import.meta.url);
function command(program, args, options = {}) {
  const r = spawnSync(program, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
  return {
    command: [program, ...args],
    exit: r.status,
    signal: r.signal,
    stdout: r.stdout,
    stderr: r.stderr,
    error: r.error?.message,
  };
}
export function composeComparison(check, binary, file, id, environment) {
  const script = assertCheckPath(
    join(check.root, "verification/parity/compose.mts"),
    check.root,
  );
  const r = command(
    process.execPath,
    [
      "--import",
      require.resolve("tsx"),
      script,
      "--native-bin",
      binary,
      "--report",
      file,
      ...(id ? ["--case-id", id] : []),
    ],
    { cwd: check.root, env: environment },
  );
  writeFileSync(`${file}.process.json`, `${JSON.stringify(r, null, 2)}\n`);
  assert.equal(r.error, undefined, JSON.stringify(r));
  assert.equal(r.signal, null, JSON.stringify(r));
  assert([0, 1].includes(r.exit), JSON.stringify(r));
  const report = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(report.compared, report.cases.length);
  assert.equal(report.passed, report.cases.filter((row) => row.equal).length);
  assert.equal(report.binary.sha256, hash(readFileSync(binary)));
  assert.equal(r.exit, report.failures.length ? 1 : 0);
  return { run: r, script, scriptSha256: hash(readFileSync(script)), report };
}
export function composeMutations({
  check,
  binary,
  reportFile,
  only,
  baseline: suppliedBaseline,
  observeTarget = () => {},
} = {}) {
  assert(
    check && binary && reportFile,
    "Supply the owning check, immutable baseline and external report",
  );
  assert.equal(realpathSync(check.root), realpathSync(moduleRoot));
  assert.equal(resolve(check.target), join(resolve(check.root), "target"));
  reportFile = resolve(reportFile);
  const proofPath = relative(check.root, reportFile);
  assert(
    proofPath === ".." ||
      proofPath.startsWith(`..${sep}`) ||
      isAbsolute(proofPath),
    "proof must outlive the check",
  );
  mkdirSync(dirname(reportFile), { recursive: true });
  const sourceFile = assertCheckPath(join(check.root, owner), check.root);
  const source = readFileSync(sourceFile, "utf8");
  const baselineHash = hash(readFileSync(binary));
  const selected = faults.filter((f) => !only || only.includes(f.id));
  assert.ok(selected.length);
  if (only)
    assert.equal(selected.length, new Set(only).size, "known unique fault IDs");
  for (const f of selected)
    assert.equal(source.split(f.needle).length, 2, `${f.id}: unique mutation`);
  const environment = cargoCheckEnvironment({
    CARGO_NET_OFFLINE: "true",
    CARGO_BUILD_JOBS: "1",
    CARGO_INCREMENTAL: "0",
    CARGO_PROFILE_DEV_DEBUG: "0",
    CARGO_PROFILE_TEST_DEBUG: "0",
  });
  const controls = [];
  let baseline;
  let attempt = { phase: "baseline" };
  const state = {};
  const save = (extra = {}) => {
    Object.assign(state, extra);
    writeFileSync(
      reportFile,
      `${JSON.stringify(
        {
          baseline: baseline && {
            compared: baseline.report.compared,
            passed: baseline.report.passed,
            binary: baseline.report.binary,
          },
          controls,
          planned: selected.length,
          semanticPairs: 0,
          activeSourceUnchanged: readFileSync(sourceFile, "utf8") === source,
          baselineArtifactUnchanged:
            hash(readFileSync(binary)) === baselineHash,
          check: {
            root: check.root,
            target: check.target,
            cargoDefaultTarget: true,
          },
          ...state,
        },
        null,
        2,
      )}\n`,
    );
  };
  try {
    baseline =
      suppliedBaseline ??
      composeComparison(
        check,
        resolve(binary),
        `${reportFile}.baseline.json`,
        undefined,
        environment,
      );
    assert.equal(baseline.report.binary.sha256, baselineHash);
    assert.equal(baseline.run.exit, 0);
    for (const f of selected) {
      writeFileSync(sourceFile, source);
      assert.equal(hash(readFileSync(sourceFile)), hash(source));
      const changed = source.replace(f.needle, f.fault);
      writeFileSync(sourceFile, changed);
      const prefix = join(dirname(reportFile), f.id);
      writeFileSync(
        `${prefix}.diff`,
        `--- ${owner}\n+++ ${owner}\n-${f.needle}\n+${f.fault}\n`,
      );
      attempt = { id: f.id, witness: f.witness, phase: "compile" };
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
        { cwd: check.root, env: environment },
      );
      writeFileSync(`${prefix}.cargo.jsonl`, build.stdout ?? "");
      writeFileSync(`${prefix}.cargo.stderr`, build.stderr ?? "");

      attempt.build = {
        command: build.command,
        exit: build.exit,
        signal: build.signal,
        error: build.error,
        cargoJson: `${prefix}.cargo.jsonl`,
        stderr: `${prefix}.cargo.stderr`,
      };
      observeTarget();
      assert.equal(
        build.error,
        undefined,
        "Cargo spawn failure is not detection",
      );
      assert.equal(build.signal, null, "Cargo signal is not detection");
      assert.equal(
        build.exit,
        0,
        `Compile/setup failure is not detection: ${f.id}\n${build.stderr}`,
      );
      const events = build.stdout
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      const library = compiledCheckLibrary(
        events,
        "demlik_tea",
        check.root,
        check.target,
      );
      const drivers = events.filter(
        (row) =>
          row.reason === "compiler-artifact" &&
          row.target.name === "compose_driver" &&
          row.target.kind.includes("example") &&
          row.executable,
      );
      assert.equal(drivers.length, 1);
      const driver = drivers[0];
      assert.equal(
        driver.fresh,
        false,
        "effective driver must be rebuilt for this fault",
      );
      assertCheckPath(driver.target.src_path, check.root);
      assertCheckPath(driver.manifest_path, check.root);
      const actual = assertCheckPath(driver.executable, check.target);
      const saved = `${prefix}.bin`;
      copyFileSync(actual, saved);
      const sha256 = hash(readFileSync(saved));
      attempt.phase = "compare";
      const result = composeComparison(
        check,
        saved,
        `${prefix}.comparison.json`,
        f.witness,
        environment,
      );
      assert.equal(result.run.exit, 1, `${f.id}: behavioral mismatch required`);
      assert.equal(result.report.compared, 1);
      assert.equal(result.report.cases[0].id, f.witness);
      assert(result.report.failures.some((row) => row.id === f.witness));
      assert(result.report.cases[0].observedRustCalls.length);
      controls.push({
        id: f.id,
        witness: f.witness,
        detectedIds: result.report.failures.map((row) => row.id),
        source: {
          path: sourceFile,
          relativePath: owner,
          originalSha256: hash(source),
          mutatedSha256: hash(changed),
          needle: f.needle,
          fault: f.fault,
        },
        binary: { path: saved, sha256, actualArtifact: actual },
        library: {
          actualArtifact: library.path,
          sha256: hash(readFileSync(library.path)),
          fresh: library.artifact.fresh,
          sourcePath: library.sourcePath,
          manifestPath: library.manifestPath,
        },
        driverArtifact: driver,
        build: attempt.build,
        result,
      });
      assert.equal(hash(readFileSync(binary)), baselineHash);
      save({ complete: false, phase: "between-controls" });
    }
  } catch (error) {
    save({
      complete: false,
      incomplete: true,
      attempt,
      failure: {
        name: error.name,
        message: error.message,
        code: error.code,
        stack: error.stack,
      },
    });
    throw error;
  } finally {
    writeFileSync(sourceFile, source);
    assert.equal(hash(readFileSync(sourceFile)), hash(source));
    assert.equal(hash(readFileSync(binary)), baselineHash);
    save({ ownerRestored: true });
  }
  save({ complete: true, incomplete: false });
  return JSON.parse(readFileSync(reportFile, "utf8"));
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  throw new Error(
    "Compose mutations require an owning check; run compose-checks-run.mjs",
  );
}
