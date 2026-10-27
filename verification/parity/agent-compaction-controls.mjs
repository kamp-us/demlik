import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  assertCheckPath,
  cargoCheckEnvironment,
  checkEvidenceDirectory,
  compiledCheckLibrary,
  createCheckWorktree,
} from "./check-worktree.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url)),
  sha = (x) => createHash("sha256").update(x).digest("hex");
export async function runCompactionControls(options = {}) {
  const evidence = path.resolve(
    options.output ?? checkEvidenceDirectory(root, "agent-compaction-controls"),
  );
  assert.ok(
    !evidence.startsWith(path.join(root, "target") + path.sep),
    "control evidence must outlive the construction worktree",
  );
  fs.mkdirSync(evidence, { recursive: true });
  const faults = JSON.parse(
    fs.readFileSync(new URL("./agent-compaction-faults.json", import.meta.url)),
  );
  const before = execFileSync("git", ["status", "--porcelain=v1"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(before, "");
  const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  const check = createCheckWorktree(
      root,
      "agent-compaction-controls",
      evidence,
    ),
    results = [];
  let active = null;
  const save = () =>
    fs.writeFileSync(
      path.join(evidence, "controls.json"),
      `${JSON.stringify({ sourceCommit, results, active, complete: results.length === faults.length }, null, 2)}\n`,
    );
  try {
    for (const directory of [
      "node_modules",
      "packages/tea/node_modules",
      "verification/parity/node_modules",
    ]) {
      const source = path.join(root, directory),
        target = path.join(check.root, directory);
      if (fs.existsSync(source) && !fs.existsSync(target))
        fs.symlinkSync(fs.realpathSync(source), target, "dir");
    }
    const { agentCompactionParity } = await import(
      pathToFileURL(
        path.join(check.root, "verification/parity/agent-compaction-run.mjs"),
      ).href
    );
    for (const fault of faults) {
      const directory = path.join(evidence, fault.name);
      fs.mkdirSync(directory, { recursive: true });
      const file = path.join(check.root, fault.file),
        original = fs.readFileSync(file, "utf8");
      assert.equal(
        original.split(fault.before).length - 1,
        1,
        `one actual mutation site: ${fault.name}`,
      );
      active = {
        name: fault.name,
        file: fault.file,
        witness: fault.witness,
        contract: fault.contract,
        status: "prepared",
        baselineSourceSha256: sha(original),
      };
      save();
      try {
        const changed = original.replace(fault.before, fault.after);
        fs.writeFileSync(file, changed);
        fs.writeFileSync(path.join(directory, "mutant-source.rs"), changed);
        active.mutantSourceSha256 = sha(changed);
        active.status = "building";
        save();
        console.log(`building ${fault.name}`);
        const command = [
          "build",
          "--locked",
          "--offline",
          "-p",
          "demlik-tea",
          "--example",
          "agent_compaction_driver",
          "--features",
          "pbt",
          "--message-format=json",
        ];
        const env = cargoCheckEnvironment({
          CARGO_NET_OFFLINE: "true",
          CARGO_PROFILE_DEV_DEBUG: "0",
          CARGO_PROFILE_TEST_DEBUG: "0",
          CARGO_INCREMENTAL: "0",
          CARGO_BUILD_JOBS: "1",
        });
        const built = spawnSync(
          options.cargo ?? process.env.CARGO ?? "cargo",
          command,
          {
            cwd: check.root,
            env,
            encoding: "utf8",
            maxBuffer: 64 * 1024 * 1024,
            timeout: 240000,
          },
        );
        fs.writeFileSync(
          path.join(directory, "cargo.jsonl"),
          built.stdout ?? "",
        );
        fs.writeFileSync(
          path.join(directory, "cargo.stderr"),
          built.stderr ?? "",
        );
        active.build = {
          command,
          status: built.status,
          signal: built.signal,
          error: built.error
            ? {
                name: built.error.name,
                message: built.error.message,
                code: built.error.code,
              }
            : null,
        };
        save();
        assert.ifError(built.error);
        assert.equal(built.status, 0, "compile failure is not detection");
        const rows = built.stdout
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line));
        const library = compiledCheckLibrary(
          rows,
          "demlik_tea",
          check.root,
          check.target,
        );
        const drivers = rows.filter(
          (r) =>
            r.reason === "compiler-artifact" &&
            r.target.name === "agent_compaction_driver" &&
            r.executable,
        );
        assert.equal(drivers.length, 1);
        const driver = drivers[0];
        assert.equal(driver.fresh, false, "actual modified consumer rebuilt");
        assertCheckPath(driver.target.src_path, check.root);
        assertCheckPath(driver.manifest_path, check.root);
        const binary = assertCheckPath(driver.executable, check.target);
        const libraryCopy = path.join(directory, "library.rlib"),
          binaryCopy = path.join(directory, "driver.bin");
        fs.copyFileSync(library.path, libraryCopy);
        fs.copyFileSync(binary, binaryCopy);
        fs.chmodSync(binaryCopy, 0o755);
        active.artifacts = {
          library,
          driver,
          libraryCopy,
          librarySha256: sha(fs.readFileSync(libraryCopy)),
          binaryCopy,
          binarySha256: sha(fs.readFileSync(binaryCopy)),
          libraryRetained: true,
        };
        active.status = "running";
        save();
        const report = agentCompactionParity({
          binary: binaryCopy,
          only: fault.witness,
          output: path.join(directory, "comparison.json"),
          allowFailures: true,
        });
        assert.equal(
          report.observations[0].literal.source.passed,
          true,
          "named Source contract must remain valid",
        );
        const detected = report.failures.some((r) => r.id === fault.witness);
        active.status = detected ? "detected" : "not-detected";
        active.processes = report.processes;
        active.comparison = {
          cases: report.cases,
          passed: report.passed,
          failures: report.failures,
          literalFailures: report.literalFailures,
        };
        save();
        assert.equal(report.cases, 1);
        assert.equal(
          detected,
          true,
          "valid named semantic witness must differ",
        );
        results.push({ ...active, detected });
        active = null;
        save();
        console.log(`detected ${fault.name}`);
      } finally {
        fs.writeFileSync(file, original);
        assert.equal(sha(fs.readFileSync(file)), sha(original));
      }
    }
    assert.equal(
      execFileSync("git", ["diff", "--name-only"], {
        cwd: check.root,
        encoding: "utf8",
      }),
      "",
    );
    assert.equal(
      execFileSync("git", ["status", "--porcelain=v1"], {
        cwd: root,
        encoding: "utf8",
      }),
      before,
    );
    return {
      sourceCommit,
      controls: results.length,
      detected: results.filter((r) => r.detected).length,
      results,
    };
  } catch (error) {
    fs.writeFileSync(
      path.join(evidence, "incomplete.json"),
      `${JSON.stringify({ sourceCommit, active, results, error: { name: error.name, message: error.message, stack: error.stack } }, null, 2)}\n`,
    );
    throw error;
  } finally {
    save();
    check.remove();
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const args = process.argv.slice(2);
  const i = args.indexOf("--output");
  const result = await runCompactionControls({
    output: i < 0 ? undefined : args[i + 1],
  });
  console.log(
    JSON.stringify({ controls: result.controls, detected: result.detected }),
  );
}
