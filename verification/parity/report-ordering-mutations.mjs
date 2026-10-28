import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import {
  assertCheckPath,
  cargoCheckEnvironment,
  compiledCheckLibrary,
  createCheckWorktree,
} from "./check-worktree.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const controls = [
  {
    id: "reverse-flat-locator",
    owner: "smells/evaluate.rs",
    needle: ".compare(left_key, right_key)",
    replacement: ".compare(right_key, left_key)",
    witness: "flat-mixed-locators",
  },
  {
    id: "plan-tie-precedence",
    owner: "smells/plan.rs",
    needle:
      ".then_with(|| left.start_line.cmp(&right.start_line))\n                .then_with(|| collation.compare(left_id, right_id))",
    replacement:
      ".then_with(|| collation.compare(left_id, right_id))\n                .then_with(|| left.start_line.cmp(&right.start_line))",
    witness: "plan-line-before-id",
  },
  {
    id: "closed-kind-declaration-order",
    owner: "smells/evaluate.rs",
    needle: "left.kind\n        .as_str()\n        .cmp(right.kind.as_str())",
    replacement:
      "crate::schema::SmellKind::ALL.iter().position(|kind| *kind == left.kind)\n        .cmp(&crate::schema::SmellKind::ALL.iter().position(|kind| *kind == right.kind))",
    witness: "closed-kind-pair-matrix",
  },
  {
    id: "withheld-tally-insertion-order",
    owner: "render/analysis.rs",
    needle: "counts.sort_by(|a, b| a.0.cmp(b.0));",
    replacement: "counts.sort_by(|_, _| std::cmp::Ordering::Equal);",
    witness: "withheld-tally-permutations",
  },
];
const [proofArg, archiveArg, manifestArg, sourceArg, cliArg] =
  process.argv.slice(2);
assert.ok(proofArg && archiveArg && manifestArg && sourceArg && cliArg);
assert.equal(process.version, "v22.21.1");
const proof = path.resolve(proofArg);
const archive = fs.realpathSync(archiveArg);
const manifest = fs.realpathSync(manifestArg);
const frozenSource = fs.realpathSync(sourceArg);
const cli = fs.realpathSync(cliArg);
fs.mkdirSync(proof, { recursive: true });
const environment = cargoCheckEnvironment({ TMPDIR: "/private/tmp" });
assert.ok(environment.CARGO && environment.DEMLIK_ICU77_PYTHON);
const baseline = new Map(
  [...new Set(controls.map((c) => c.owner))].map((owner) => [
    owner,
    fs.readFileSync(path.join(root, "crates/code-graph/src", owner), "utf8"),
  ]),
);
for (const c of controls) {
  const body = baseline.get(c.owner);
  assert.equal(body.split(c.needle).length - 1, 1, `${c.id} unique needle`);
  assert.notEqual(body.replace(c.needle, c.replacement), body);
}
const report = {
  baselineOwners: Object.fromEntries(
    [...baseline].map(([owner, bytes]) => [owner, hash(bytes)]),
  ),
  frozenSource: {
    file: frozenSource,
    sha256: hash(fs.readFileSync(frozenSource)),
  },
  baselineCli: {
    file: cli,
    sha256: hash(fs.readFileSync(cli)),
    executedInControls: false,
  },
  controls: [],
  semanticDetections: 0,
  processingFailure: null,
  cleanupFailure: null,
};
const save = () =>
  fs.writeFileSync(
    path.join(proof, "controls.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
function run(program, args, cwd, name) {
  const child = spawnSync(program, args, {
    cwd,
    env: environment,
    maxBuffer: 128 << 20,
  });
  fs.writeFileSync(
    path.join(proof, `${name}.stdout`),
    child.stdout ?? Buffer.alloc(0),
  );
  fs.writeFileSync(
    path.join(proof, `${name}.stderr`),
    child.stderr ?? Buffer.alloc(0),
  );
  const record = {
    command: [program, ...args],
    cwd,
    exit: child.status,
    signal: child.signal,
    error: child.error?.message,
    stdoutSha256: hash(child.stdout ?? ""),
    stderrSha256: hash(child.stderr ?? ""),
  };
  fs.writeFileSync(
    path.join(proof, `${name}.process.json`),
    `${JSON.stringify(record, null, 2)}\n`,
  );
  assert.ifError(child.error);
  assert.equal(child.signal, null);
  return { child, record };
}
function retain(file, event, owner, role) {
  const actual = assertCheckPath(file, owner);
  const bytes = fs.readFileSync(actual),
    digest = hash(bytes);
  const dest = path.join(
    proof,
    "artifacts",
    digest,
    `${path.basename(actual)}.gz`,
  );
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (!fs.existsSync(dest))
    fs.writeFileSync(dest, gzipSync(bytes, { level: 1 }));
  return {
    role,
    actualArtifact: actual,
    sha256: digest,
    bytes: bytes.length,
    preserved: dest,
    encoding: "gzip",
    preservedSha256: hash(fs.readFileSync(dest)),
    event,
    executed: false,
    linkedIntoExecutedConsumers: false,
  };
}
let check;
let processingError;
let cleanupError;
try {
  check = createCheckWorktree(root, "report-ordering-controls", proof);
  for (const relative of [
    "node_modules",
    "verification/parity/node_modules",
    "packages/code-graph/node_modules",
    "packages/tea/node_modules",
  ])
    fs.symlinkSync(path.join(root, relative), path.join(check.root, relative));
  environment.DEMLIK_ICU77_PREPARED = path.join(
    check.target,
    "icu77/prepared.json",
  );
  environment.RUST_ICU_LINK_SEARCH_DIR = path.join(
    check.target,
    "icu77/install/lib",
  );
  environment.RUST_ICU_MAJOR_VERSION_NUMBER = "77";
  const prep = run(
    environment.DEMLIK_ICU77_PYTHON,
    [
      "tools/icu77/prepare.py",
      "prepare",
      "--host",
      "aarch64-apple-darwin",
      "--target",
      "aarch64-apple-darwin",
      "--source-archive",
      archive,
      "--cargo",
      environment.CARGO,
    ],
    check.root,
    "icu-prepare",
  );
  assert.equal(prep.record.exit, 0);
  report.preparation = {
    process: prep.record,
    stamp: JSON.parse(fs.readFileSync(environment.DEMLIK_ICU77_PREPARED)),
  };
  save();
  for (const c of controls) {
    for (const [owner, body] of baseline)
      fs.writeFileSync(
        path.join(check.root, "crates/code-graph/src", owner),
        body,
      );
    const file = path.join(check.root, "crates/code-graph/src", c.owner);
    const original = baseline.get(c.owner),
      changed = original.replace(c.needle, c.replacement);
    fs.writeFileSync(file, changed);
    const build = run(
      environment.CARGO,
      [
        "build",
        "-p",
        "demlik-code-graph",
        "--lib",
        "--example",
        "report_ordering_driver",
        "--locked",
        "--offline",
        "--message-format=json",
      ],
      check.root,
      `${c.id}-cargo`,
    );
    const entry = {
      ...c,
      originalSha256: hash(original),
      changedSha256: hash(changed),
      build: build.record,
      detected: false,
    };
    report.controls.push(entry);
    save();
    const events = build.child.stdout
      .toString()
      .split("\n")
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
    entry.availableSelectedArtifacts = events
      .filter(
        (event) =>
          event.reason === "compiler-artifact" &&
          event.manifest_path ===
            path.join(check.root, "crates/code-graph/Cargo.toml"),
      )
      .flatMap((event) =>
        [
          ...new Set([
            ...(event.executable ? [event.executable] : []),
            ...event.filenames.filter((file) => file.endsWith(".rlib")),
          ]),
        ]
          .filter((file) => fs.existsSync(file))
          .map((file) =>
            retain(
              file,
              event,
              check.target,
              "selection-only-before-adjudication",
            ),
          ),
      );
    save();
    assert.equal(
      build.record.exit,
      0,
      "compiler/setup failure is zero semantic credit",
    );
    const library = compiledCheckLibrary(
      events,
      "demlik_code_graph",
      check.root,
      check.target,
    );
    const drivers = events.filter(
      (row) =>
        row.reason === "compiler-artifact" &&
        row.target.name === "report_ordering_driver" &&
        row.executable,
    );
    assert.equal(drivers.length, 1);
    assert.equal(drivers[0].fresh, false);
    entry.library = retain(
      library.path,
      library.artifact,
      check.target,
      "modified-library",
    );
    entry.driver = retain(
      drivers[0].executable,
      drivers[0],
      check.target,
      "selected-control-driver",
    );
    save();
    const pairs = path.join(proof, `${c.id}-pairs.json`);
    const script = assertCheckPath(
      path.join(check.root, "verification/parity/report-ordering-pairs.mjs"),
      check.root,
    );
    const compared = run(
      process.execPath,
      [
        "--import",
        path.join(
          check.root,
          "verification/parity/node_modules/tsx/dist/loader.mjs",
        ),
        script,
        entry.driver.actualArtifact,
        cli,
        manifest,
        frozenSource,
        pairs,
        c.witness,
      ],
      check.root,
      `${c.id}-compare`,
    );
    entry.comparison = compared.record;
    const raw = JSON.parse(fs.readFileSync(pairs));
    assert.equal(raw.attempted, 1);
    assert.equal(raw.passed, 0);
    assert.equal(raw.qualifiedPairs, 0);
    assert.equal(raw.rustBinarySha256, entry.driver.sha256);
    assert.equal(raw.failures.length, 1);
    assert.equal(raw.failures[0].id, c.witness);
    assert.equal(raw.cases.length, 1);
    const witness = raw.cases[0];
    assert.equal(witness.id, c.witness);
    assert.equal(witness.nativeProcess.status, 0);
    assert.equal(witness.nativeProcess.signal, null);
    assert.equal(witness.nativeTrace.ok, true);
    assert.ok(witness.nativeTrace.observedCalls.length > 0);
    assert.deepEqual(witness.qualifications, []);
    assert.notDeepEqual(witness.actual, witness.expected);
    assert.equal(compared.record.exit, 1);
    entry.driver.executed = true;
    entry.driver.role = "executed-control-driver";
    entry.library.linkedIntoExecutedConsumers = true;
    entry.detected = true;
    report.semanticDetections++;
    save();
    assert.equal(hash(fs.readFileSync(cli)), report.baselineCli.sha256);
  }
  assert.equal(report.semanticDetections, 4);
} catch (error) {
  processingError = error;
  report.processingFailure = String(error?.stack ?? error);
  save();
} finally {
  if (check) {
    try {
      for (const [owner, body] of baseline)
        fs.writeFileSync(
          path.join(check.root, "crates/code-graph/src", owner),
          body,
        );
      report.restoredOwners = Object.fromEntries(
        [...baseline].map(([owner, body]) => {
          const digest = hash(
            fs.readFileSync(
              path.join(check.root, "crates/code-graph/src", owner),
            ),
          );
          assert.equal(digest, hash(body));
          return [owner, digest];
        }),
      );
      const native = path.join(proof, "native-icu77");
      fs.mkdirSync(native, { recursive: true });
      const logs = path.join(check.target, "icu77/logs");
      if (fs.existsSync(logs))
        fs.cpSync(logs, path.join(native, "logs"), { recursive: true });
      for (const name of ["prepared.json", "attempt.json"]) {
        const file = path.join(check.target, "icu77", name);
        if (fs.existsSync(file)) fs.copyFileSync(file, path.join(native, name));
      }
    } catch (error) {
      processingError ??= error;
      report.restorationOrProvenanceFailure = String(error?.stack ?? error);
    }
    try {
      check.remove();
    } catch (error) {
      cleanupError = error;
      report.cleanupFailure = String(error?.stack ?? error);
    }
  }
  save();
}
if (processingError) throw processingError;
if (cleanupError) throw cleanupError;
