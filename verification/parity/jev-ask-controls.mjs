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
import { jevAskParity } from "./jev-ask-run.mjs";

const sourceRoot = fileURLToPath(new URL("../..", import.meta.url));
const [evidenceArg, sourceFile] = process.argv.slice(2);
assert.ok(
  evidenceArg && sourceFile,
  "usage: jev-ask-controls.mjs EVIDENCE SAVED_SOURCE_STDOUT",
);
const evidence = path.resolve(evidenceArg);
const hash = (file) =>
  createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const write = (file, value) =>
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
const mutations = [
  {
    name: "canonical-clone-drops-tag-position",
    file: "crates/tea/src/resilience/resilient_call/model.rs",
    before: "tag_position: self.tag_position,",
    after: "tag_position: None,",
    witness: "wire.middle",
  },
  {
    name: "transient-429-becomes-terminal",
    file: "crates/tea/src/jev/ask.rs",
    before: "if !reply::is_transient_ask_err(&error) {",
    after: "if !matches!(error.as_ref(), JevAskErr::PortThrew { .. }) {",
    witness: "promise.retry429",
  },
  {
    name: "terminal-401-enters-retry",
    file: "crates/tea/src/jev/ask.rs",
    before: "if !reply::is_transient_ask_err(&error) {",
    after: "if false {",
    witness: "promise.terminal401",
  },
  {
    name: "original-settled-time-replaced",
    file: "crates/tea/src/jev/ask.rs",
    before: "msg.at().ok_or_else(|| rc::ResilientError::MissingStamp {",
    after: "Some(0.0.into()).ok_or_else(|| rc::ResilientError::MissingStamp {",
    witness: "promise.retry429",
  },
];
const check = createCheckWorktree(sourceRoot, "jev-ask", evidence);
const rows = [];
let current = null,
  failure = null,
  sourceRestored = true;
const save = () =>
  write(path.join(evidence, "controls.json"), {
    allPassed:
      !failure &&
      rows.length === mutations.length &&
      rows.every((r) => r.detected),
    controls: rows,
    current,
    failure,
    sourceRestored,
  });
try {
  for (const mutation of mutations) {
    const dir = path.join(evidence, mutation.name);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(check.root, mutation.file);
    const original = fs.readFileSync(file, "utf8");
    assert.equal(original.split(mutation.before).length - 1, 1);
    const modified = original.replace(mutation.before, mutation.after);
    fs.writeFileSync(path.join(dir, "original.rs"), original);
    fs.writeFileSync(path.join(dir, "modified.rs"), modified);
    current = {
      name: mutation.name,
      file: mutation.file,
      sourceBefore: hash(file),
      witness: mutation.witness,
      phase: "build",
    };
    save();
    try {
      sourceRestored = false;
      fs.writeFileSync(file, modified);
      current.sourceModified = hash(file);
      const command = [
        "build",
        "--locked",
        "--offline",
        "-p",
        "demlik-tea",
        "--example",
        "jev_ask_driver",
        "--message-format=json",
      ];
      const result = spawnSync(process.env.CARGO ?? "cargo", command, {
        cwd: check.root,
        env: cargoCheckEnvironment(),
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
      });
      fs.writeFileSync(
        path.join(dir, "cargo.stdout.jsonl"),
        result.stdout ?? "",
      );
      fs.writeFileSync(path.join(dir, "cargo.stderr"), result.stderr ?? "");
      current.build = {
        command: process.env.CARGO ?? "cargo",
        args: command,
        cwd: check.root,
        exit: result.status,
        signal: result.signal,
        error: result.error ? String(result.error) : null,
      };
      const events = (result.stdout ?? "").split("\n").flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
      write(path.join(dir, "events.json"), events);
      const selected = events.filter(
        (e) =>
          e.reason === "compiler-artifact" &&
          (e.target.name === "demlik_tea" ||
            e.target.name === "jev_ask_driver"),
      );
      current.artifacts = [];
      for (const event of selected) {
        for (const name of event.filenames) {
          if (
            (!name.endsWith(".rlib") && name !== event.executable) ||
            !fs.existsSync(name)
          )
            continue;
          const ownerPath = assertCheckPath(name, check.target);
          const sha256 = hash(ownerPath);
          const retained = path.join(
            dir,
            `${sha256}${name.endsWith(".rlib") ? ".rlib" : ".bin"}.gz`,
          );
          fs.writeFileSync(
            retained,
            gzipSync(fs.readFileSync(ownerPath), { level: 1 }),
          );
          current.artifacts.push({
            target: event.target.name,
            kind: event.target.kind,
            fresh: event.fresh,
            originalPath: ownerPath,
            sha256,
            retained,
            executed: false,
          });
        }
      }
      save();
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0);
      const library = compiledCheckLibrary(
        events,
        "demlik_tea",
        check.root,
        check.target,
      );
      current.library = {
        path: library.path,
        sha256: hash(library.path),
        fresh: library.artifact.fresh,
        sourcePath: library.sourcePath,
        manifestPath: library.manifestPath,
      };
      const drivers = events.filter(
        (e) =>
          e.reason === "compiler-artifact" &&
          e.target.name === "jev_ask_driver" &&
          e.target.kind.includes("example") &&
          e.executable,
      );
      assert.equal(drivers.length, 1);
      const driver = drivers[0];
      assert.equal(driver.fresh, false);
      assertCheckPath(driver.target.src_path, check.root);
      assertCheckPath(driver.manifest_path, check.root);
      const binary = assertCheckPath(driver.executable, check.target);
      const executed = path.join(dir, "executed.bin");
      fs.copyFileSync(binary, executed);
      fs.chmodSync(executed, fs.statSync(binary).mode & 0o777);
      current.binary = {
        producerPath: binary,
        executedPath: executed,
        sha256: hash(executed),
        sourceSha256: hash(driver.target.src_path),
        fresh: driver.fresh,
      };
      assert.equal(hash(binary), current.binary.sha256);
      current.phase = "execute";
      save();
      const report = jevAskParity(executed, path.join(dir, "comparison.json"), {
        sourceFile,
        allowFailures: true,
      });
      current.processes = report.processes;
      current.artifacts.find((a) => a.target === "jev_ask_driver").executed =
        true;
      save();
      assert.equal(report.cases, 18);
      assert.equal(
        report.observations.every((row) => row.native.ok === true),
        true,
      );
      const witness = report.observations.find(
        (row) => row.id === mutation.witness,
      );
      assert.ok(
        witness && !witness.equal,
        "the named semantic witness must differ",
      );
      if (mutation.name === "terminal-401-enters-retry") {
        const first = (row) =>
          row.output.frames.find((frame) => frame.op === "fail").state.calls[
            "invoice:104"
          ].phase;
        assert.equal(first(witness.source), "failed");
        assert.equal(first(witness.native), "waiting_retry");
      }
      rows.push({
        ...current,
        detected: true,
        failures: report.failures.map((row) => row.id),
      });
      current = null;
    } finally {
      fs.writeFileSync(file, original);
      assert.equal(fs.readFileSync(file, "utf8"), original);
      sourceRestored = true;
    }
    save();
  }
} catch (error) {
  failure = { name: error.name, message: error.message, stack: error.stack };
  save();
  process.exitCode = 1;
} finally {
  try {
    check.remove();
  } catch (error) {
    failure ??= {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
    process.exitCode = 1;
  }
  save();
}
