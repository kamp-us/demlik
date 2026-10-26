import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { typedReducerControls } from "./typed-reducer-controls.mjs";
import { typedReducerParity } from "./typed-reducer-run.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
export async function typedReducerChecks(options = {}) {
  assert.ok(
    options.binary && options.ownerBinary,
    "actual Cargo-selected baseline binaries are required",
  );
  const baseline = path.resolve(
    process.env.CARGO_TARGET_DIR ?? path.join(root, "target"),
  );
  const target = path.resolve(
    process.env.DEMLIK_MUTATION_TARGET_DIR ??
      path.join(root, "target/agent-state-mutation-build"),
  );
  assert.notEqual(
    baseline,
    target,
    "mutation and baseline artifacts must be isolated",
  );
  const directory =
    options.directory ??
    path.join(root, "target/typed-reducer-conformance/controls");
  await mkdir(directory, { recursive: true });
  const owners = [
    ...new Set([
      ...typedReducerControls.map((c) => c.file),
      "crates/tea/tests/typed_reducer_lifecycle.rs",
      "crates/tea/examples/typed_reducer_driver.rs",
      "crates/tea/examples/typed_reducer/actor.rs",
      "crates/tea/examples/typed_reducer/pure.rs",
    ]),
  ];
  const originals = Object.fromEntries(
    await Promise.all(
      owners.map(async (file) => [
        file,
        await readFile(path.join(root, file), "utf8"),
      ]),
    ),
  );
  const originalHashes = Object.fromEntries(
    Object.entries(originals).map(([file, text]) => [file, hash(text)]),
  );
  const binaryHashes = {
    driver: hash(await readFile(options.binary)),
    owner: hash(await readFile(options.ownerBinary)),
  };
  const baselineReport = await typedReducerParity({
    binary: options.binary,
    reportFile: path.join(directory, "full94-baseline.json"),
    quiet: true,
  });
  assert.equal(baselineReport.cases, 94, "mandatory complete shared baseline");
  assert.equal(baselineReport.passed, 94);
  assert.deepEqual(baselineReport.failures, []);
  const ownerBaseline = spawnSync(options.ownerBinary, [], {
    cwd: root,
    encoding: "utf8",
    timeout: 20_000,
  });
  await writeFile(
    path.join(directory, "owner-baseline.log"),
    `${ownerBaseline.stdout}\n${ownerBaseline.stderr}`,
  );
  assert.equal(ownerBaseline.status, 0);
  assert.match(ownerBaseline.stdout, /test result: ok\. 6 passed; 0 failed/);
  const temp = await mkdtemp(
      path.join(tmpdir(), "demlik-typed-reducer-controls-"),
    ),
    results = [];
  try {
    for (const file of [
      "Cargo.toml",
      "Cargo.lock",
      "rust-toolchain.toml",
      "crates",
    ])
      await cp(path.join(root, file), path.join(temp, file), {
        recursive: true,
      });
    for (const c of typedReducerControls) {
      for (const [file, text] of Object.entries(originals))
        await writeFile(path.join(temp, file), text);
      let mutated = originals[c.file];
      for (const [before, after] of c.patches) {
        assert.equal(
          mutated.split(before).length,
          2,
          `${c.id}: unique mutation needle`,
        );
        mutated = mutated.replace(before, after);
      }
      await writeFile(path.join(temp, c.file), mutated);
      const controlDir = path.join(directory, c.id);
      await mkdir(controlDir, { recursive: true });
      await writeFile(path.join(controlDir, "mutated.rs"), mutated);
      const args = c.test
        ? ["test", "--no-run", "--test", "typed_reducer_lifecycle"]
        : ["build", "--example", "typed_reducer_driver"];
      const command = [
        ...args,
        "--locked",
        "--offline",
        "--message-format=json",
        "-p",
        "demlik-tea",
      ];
      const build = spawnSync(process.env.CARGO ?? "cargo", command, {
        cwd: temp,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        timeout: 240_000,
        env: {
          ...process.env,
          CARGO_TARGET_DIR: target,
          CARGO_NET_OFFLINE: "true",
          CARGO_PROFILE_DEV_DEBUG: "0",
          CARGO_PROFILE_TEST_DEBUG: "0",
          CARGO_INCREMENTAL: "0",
          CARGO_BUILD_JOBS: "1",
        },
      });
      await writeFile(path.join(controlDir, "cargo.jsonl"), build.stdout ?? "");
      await writeFile(path.join(controlDir, "compile.log"), build.stderr ?? "");
      assert.equal(
        build.status,
        0,
        `${c.id}: mutant must compile, not merely fail\n${build.stderr}`,
      );
      const artifacts = build.stdout.split("\n").flatMap((line) => {
        try {
          const d = JSON.parse(line);
          return d.reason === "compiler-artifact" ? [d] : [];
        } catch {
          return [];
        }
      });
      const name = c.test ? "typed_reducer_lifecycle" : "typed_reducer_driver";
      const selected = artifacts.filter(
        (d) => d.target.name === name && d.executable,
      );
      assert.equal(selected.length, 1, `${c.id}: actual Cargo executable`);
      const actual = selected[0].executable,
        bytes = await readFile(actual),
        sha256 = hash(bytes),
        binary = path.join(controlDir, `${sha256}.bin`);
      await cp(actual, binary);
      let witness;
      if (c.test) {
        const run = spawnSync(binary, [c.test, "--exact", "--nocapture"], {
          cwd: temp,
          encoding: "utf8",
          timeout: 15_000,
          maxBuffer: 8 * 1024 * 1024,
        });
        const text = `${run.stdout}\n${run.stderr}`;
        await writeFile(path.join(controlDir, "native.log"), text);
        assert.equal(
          run.status,
          101,
          `${c.id}: require intended native behavioral refusal\n${text}`,
        );
        assert.ok(
          run.stdout.includes(`test ${c.test} ... FAILED`),
          `${c.id}: intended test failed`,
        );
        assert.ok(
          text.includes(c.assertion),
          `${c.id}: intended semantic assertion`,
        );
        witness = {
          kind: "native-owner-law",
          test: c.test,
          assertion: c.assertion,
          exit: run.status,
        };
      } else {
        const paired = await typedReducerParity({
          binary,
          caseIds: c.cases,
          reportFile: path.join(controlDir, "pairs.json"),
          quiet: true,
        });
        assert.ok(
          paired.failures.length > 0,
          `${c.id}: compiled regression escaped`,
        );
        assert.ok(
          paired.failures.some((f) => c.cases.includes(f.id)),
          `${c.id}: a declared witness must differ`,
        );
        for (const f of paired.failures) {
          assert.ok(c.cases.includes(f.id));
          assert.equal(f.source.ok, true);
          assert.equal(f.native.ok, true);
          assert.equal(paired.nativeEvidence[f.id], undefined);
        }
        witness = {
          kind: "source-native-semantic",
          declared: c.cases,
          detected: paired.failures.map((f) => f.id),
        };
      }
      results.push({
        ...c,
        compiled: true,
        detected: true,
        command,
        sourceSha256: originalHashes[c.file],
        mutantSha256: hash(mutated),
        binary,
        sha256,
        actualArtifact: actual,
        witness,
      });
      await writeFile(
        path.join(directory, "progress.json"),
        `${JSON.stringify(results, null, 2)}\n`,
      );
      console.log(
        JSON.stringify({ control: c.id, compiled: true, detected: true }),
      );
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
  for (const [file, sha256] of Object.entries(originalHashes))
    assert.equal(
      hash(await readFile(path.join(root, file))),
      sha256,
      `${file}: active source integrity`,
    );
  assert.equal(hash(await readFile(options.binary)), binaryHashes.driver);
  assert.equal(hash(await readFile(options.ownerBinary)), binaryHashes.owner);
  const report = {
    detected: results.length,
    escaped: 0,
    sourceNativeControls: results.filter((r) => !r.test).length,
    nativeOwnerControls: results.filter((r) => r.test).length,
    baseline: { cases: 94, native: 6, binaryHashes },
    baselineTarget: baseline,
    mutationTarget: target,
    sourceHashes: originalHashes,
    controls: results,
    activeSourceUnchanged: true,
    baselineArtifactsUnchanged: true,
  };
  const reportFile = path.join(directory, "report.json");
  await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  return { ...report, reportFile };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const option = (name) => {
    const at = process.argv.indexOf(name);
    return at < 0 ? undefined : process.argv[at + 1];
  };
  const report = await typedReducerChecks({
    binary: option("--binary"),
    ownerBinary: option("--owner-binary"),
  });
  console.log(
    JSON.stringify({
      detected: report.detected,
      reportFile: report.reportFile,
    }),
  );
}
