import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  assertCheckPath,
  cargoCheckEnvironment,
  compiledCheckLibrary,
  createCheckWorktree,
} from "./check-worktree.mjs";
import { subscriptionControls } from "./subscription-conformance-controls.mjs";
import { subscriptionConformance } from "./subscription-conformance-run.mjs";
import { typedReducerControls } from "./typed-reducer-controls.mjs";
import { typedReducerParity } from "./typed-reducer-run.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const oldIds = [
  "typed-branch-bypasses-report-and-policy",
  "failed-reducer-notifies-a-commit",
  "lookup-refusal-is-supervised",
  "stop-does-not-halt",
];
export async function subscriptionChecks(options) {
  const {
    binary,
    ownerBinary,
    baselineReport,
    oldBinary,
    oldReport,
    directory,
  } = options;
  assert.ok(
    directory &&
      binary &&
      ownerBinary &&
      baselineReport &&
      oldBinary &&
      oldReport,
    "actual selected binaries and complete baselines required",
  );
  await mkdir(directory, { recursive: true });
  const baseline = JSON.parse(await readFile(baselineReport, "utf8"));
  assert.equal(baseline.cases, 65);
  assert.equal(baseline.passed, 65);
  assert.equal(baseline.qualifiedPassed, 3);
  assert.deepEqual(baseline.failures, []);
  assert.equal(hash(await readFile(binary)), baseline.binary.sha256);
  for (const [file, digest] of Object.entries(baseline.sourceHashes))
    assert.equal(
      hash(await readFile(path.join(root, file))),
      digest,
      `baseline source ${file}`,
    );
  const previous = JSON.parse(await readFile(oldReport, "utf8"));
  assert.equal(previous.cases, 94);
  assert.equal(previous.passed, 94);
  assert.deepEqual(previous.failures, []);
  assert.equal(hash(await readFile(oldBinary)), previous.binary.sha256);
  const baselineHashes = Object.fromEntries(
    await Promise.all(
      [binary, ownerBinary, oldBinary].map(async (f) => [
        f,
        hash(await readFile(f)),
      ]),
    ),
  );
  const owner = spawnSync(ownerBinary, [], {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
  });
  await writeFile(
    path.join(directory, "owner-baseline.log"),
    `${owner.stdout}\n${owner.stderr}`,
  );
  assert.equal(owner.status, 0);
  assert.match(owner.stdout, /8 passed; 0 failed/);
  const controls = [
    ...subscriptionControls,
    ...typedReducerControls
      .filter((c) => oldIds.includes(c.id))
      .map((c) => ({ ...c, id: `old-${c.id}`, old: true })),
  ];
  assert.equal(controls.length, 17);
  const results = [];
  const check = createCheckWorktree(
    root,
    "subscription-conformance-fault-suite",
    directory,
  );
  const originals = Object.fromEntries(
    await Promise.all(
      [...new Set(controls.map((c) => c.file))].map(async (file) => [
        file,
        await readFile(path.join(check.root, file), "utf8"),
      ]),
    ),
  );
  const restore = async () => {
    for (const [file, text] of Object.entries(originals))
      await writeFile(path.join(check.root, file), text);
  };
  try {
    for (const control of controls) {
      await restore();
      const evidence = path.join(directory, control.id);
      await mkdir(evidence, { recursive: true });
      const file = path.join(check.root, control.file);
      const before = await readFile(file, "utf8");
      let text = before;
      for (const [from, to] of control.patches) {
        assert.equal(
          text.split(from).length,
          2,
          `${control.id}: unique needle`,
        );
        text = text.replace(from, to);
      }
      await writeFile(file, text);
      await writeFile(path.join(evidence, "mutated.rs"), text);
      const program = control.test
        ? "subscription_runtime"
        : control.old
          ? "typed_reducer_driver"
          : "subscription_conformance_driver";
      const args = [
        control.test ? "test" : "build",
        "--locked",
        "--offline",
        "-p",
        "demlik-tea",
        control.test ? "--test" : "--example",
        program,
        ...(control.test ? ["--no-run"] : []),
        "--message-format=json",
      ];
      const env = cargoCheckEnvironment();
      for (const key of [
        "CARGO_TARGET_DIR",
        "CARGO_BUILD_TARGET_DIR",
        "CARGO_BUILD_BUILD_DIR",
        "DEMLIK_MUTATION_TARGET_DIR",
      ])
        delete env[key];
      const build = spawnSync(process.env.CARGO ?? "cargo", args, {
        cwd: check.root,
        env,
        encoding: "utf8",
        timeout: 180_000,
        maxBuffer: 32 * 1024 * 1024,
      });
      await writeFile(path.join(evidence, "cargo.jsonl"), build.stdout ?? "");
      await writeFile(path.join(evidence, "cargo.stderr"), build.stderr ?? "");
      assert.equal(build.error, undefined);
      assert.equal(build.signal, null);
      assert.equal(
        build.status,
        0,
        `${control.id}: compile/protocol errors do not count`,
      );
      const rows = build.stdout.split("\n").filter(Boolean).map(JSON.parse);
      const selected = rows.filter(
        (r) =>
          r.reason === "compiler-artifact" &&
          r.target.name === program &&
          r.executable,
      );
      assert.equal(selected.length, 1);
      assert.equal(
        selected[0].fresh,
        false,
        "effective driver rebuilt against modified library",
      );
      const library = compiledCheckLibrary(
        rows,
        "demlik_tea",
        check.root,
        check.target,
      );
      assertCheckPath(selected[0].executable, check.target);
      const bin = path.join(evidence, "driver.bin"),
        lib = path.join(evidence, path.basename(library.path));
      await copyFile(selected[0].executable, bin);
      await copyFile(library.path, lib);
      const artifact = {
        binary: {
          path: bin,
          sha256: hash(await readFile(bin)),
          selected: selected[0],
        },
        library: {
          path: lib,
          sha256: hash(await readFile(lib)),
          selected: library.artifact,
        },
      };
      await writeFile(
        path.join(evidence, "artifacts.json"),
        `${JSON.stringify(artifact, null, 2)}\n`,
      );
      let detected = [];
      if (control.test) {
        const execution = spawnSync(
          bin,
          [control.test, "--exact", "--nocapture"],
          { cwd: check.root, encoding: "utf8", timeout: 20_000 },
        );
        await writeFile(
          path.join(evidence, "execution.log"),
          `${execution.stdout}\n${execution.stderr}`,
        );
        assert.equal(execution.signal, null);
        assert.equal(execution.error, undefined);
        assert.equal(execution.status, 101);
        assert.match(execution.stdout, /0 passed; 1 failed/);
        assert.match(execution.stderr, /panicked at/);
        detected = [control.test];
      } else {
        const reportFile = path.join(evidence, "semantic.json");
        const report = control.old
          ? await typedReducerParity({
              binary: bin,
              caseIds: control.cases,
              reportFile,
              quiet: true,
            })
          : await subscriptionConformance({
              binary: bin,
              ids: control.cases,
              reportFile,
              quiet: true,
            });
        assert.ok(
          report.failures.length > 0,
          `${control.id}: actual semantic red required`,
        );
        detected = report.failures.map((f) => f.id);
        assert.ok(
          detected.some((id) => control.cases.includes(id)),
          `${control.id}: a declared witness, not unrelated-only failure`,
        );
      }
      const result = {
        id: control.id,
        compileStatus: build.status,
        source: {
          file: control.file,
          before: hash(Buffer.from(before)),
          mutated: hash(Buffer.from(text)),
        },
        witnesses: control.test ? [control.test] : control.cases,
        detected,
        artifact,
      };
      results.push(result);
      await writeFile(
        path.join(evidence, "result.json"),
        `${JSON.stringify(result, null, 2)}\n`,
      );
    }
  } finally {
    await restore();
    for (const [file, text] of Object.entries(originals))
      assert.equal(
        await readFile(path.join(check.root, file), "utf8"),
        text,
        `restored ${file}`,
      );
    check.remove();
  }
  for (const [file, digest] of Object.entries(baseline.sourceHashes))
    assert.equal(
      hash(await readFile(path.join(root, file))),
      digest,
      `unchanged baseline source ${file}`,
    );
  for (const [file, digest] of Object.entries(baselineHashes))
    assert.equal(
      hash(await readFile(file)),
      digest,
      `unchanged baseline binary ${file}`,
    );
  const report = {
    sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim(),
    newControls: 13,
    inheritedRegressionControls: 4,
    total: results.length,
    detected: results.length,
    policy:
      "one sequential fault suite owns a registered worktree/default target; exact owner restoration before every fault, no cache or target copies; compile/protocol/process errors never semantic credit; actual library and effective driver fresh:false, immutable executed copies retained before the next fault",
    baselineReport,
    oldReport,
    baselineHashes,
    results,
  };
  await writeFile(
    path.join(directory, "report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  return report;
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const options = JSON.parse(await readFile(process.argv[2], "utf8"));
  const report = await subscriptionChecks(options);
  console.log(
    JSON.stringify({ total: report.total, detected: report.detected }),
  );
}
