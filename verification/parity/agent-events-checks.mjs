import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { gzipSync } from "node:zlib";
import {
  assertCheckPath,
  cargoCheckEnvironment,
  compiledCheckLibrary,
  createCheckWorktree,
} from "./check-worktree.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const hashFile = (file) => hash(fs.readFileSync(file));
const write = (file, value) =>
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
const faults = [
  {
    name: "outbox-replayed",
    id: "outbox-owner-once",
    before: "projected.push(owner);",
    after: "// fault: omit the original outbox mark",
    witness: (s, n) =>
      s.batches[1].length === 0 &&
      n.batches[1].length === 1 &&
      n.batches[1][0].type === "BrainStarted",
  },
  {
    name: "refused-late-result-published",
    id: "failed-tool-refuses-late-success",
    before: "if !refused {",
    after: "if true {",
    witness: (s, n) =>
      s.batches[1].length === 0 &&
      n.batches[1].length === 1 &&
      n.batches[1][0].type === "ToolSettled",
  },
  {
    name: "next-brain-event-before-settlement",
    id: "direct-success-is-not-deduplicated",
    before: "events.push(AgentEvent::BrainStarted {",
    after: "events.insert(0, AgentEvent::BrainStarted {",
    witness: (s, n) =>
      isDeepStrictEqual(
        s.batches[0].map((e) => e.type),
        ["ToolSettled", "BrainStarted"],
      ) &&
      isDeepStrictEqual(
        n.batches[0].map((e) => e.type),
        ["BrainStarted", "ToolSettled"],
      ),
  },
];

export function agentEventsControls({
  root,
  evidence,
  baseline,
  sourceReport,
  cargo = "cargo",
}) {
  assert.equal(process.versions.node, "22.21.1");
  fs.mkdirSync(evidence, { recursive: true });
  const sourceBytes = fs.readFileSync(sourceReport);
  assert.equal(
    hash(sourceBytes),
    "bbd4bd0285954caeb64cdc7ebe9ef0b5a1ced50f75952190323a958c13bba298",
  );
  const rows = JSON.parse(sourceBytes).rows;
  const baselineHash = hashFile(baseline);
  const output = {
    baseline: { path: baseline, sha256: baselineHash },
    sourceReport: { path: sourceReport, sha256: hash(sourceBytes) },
    SourceExecutions: 0,
    newSharedCredit: 0,
    faults: [],
    completed: false,
  };
  const save = () => write(path.join(evidence, "report.json"), output);
  const runCase = (binary, row, folder) => {
    fs.mkdirSync(folder, { recursive: true });
    const args = [JSON.stringify(row.input), path.join(folder, "invoice")];
    write(path.join(folder, "request.json"), {
      binary,
      args,
      input: row.input,
    });
    const before = hashFile(binary);
    const result = spawnSync(binary, args, {
      cwd: root,
      env: cargoCheckEnvironment(),
      encoding: "utf8",
      timeout: 15000,
    });
    fs.writeFileSync(path.join(folder, "stdout"), result.stdout ?? "");
    fs.writeFileSync(path.join(folder, "stderr"), result.stderr ?? "");
    write(path.join(folder, "process.json"), {
      command: [binary, ...args],
      status: result.status,
      signal: result.signal,
      error: result.error ? String(result.error) : null,
      sha256Before: before,
      sha256After: hashFile(binary),
    });
    assert.equal(
      result.status,
      0,
      "semantic witness requires a successful producer process",
    );
    assert.equal(result.stderr, "");
    assert.ifError(result.error);
    assert.equal(hashFile(binary), before);
    const frame = JSON.parse(result.stdout);
    assert.deepEqual(frame.input, row.input);
    assert.ok(frame.nativeTrace.length > 0);
    return frame;
  };
  for (const fault of faults) {
    const row = rows.find((row) => row.input.id === fault.id);
    assert.ok(row);
    const frame = runCase(
      baseline,
      row,
      path.join(evidence, "baseline", fault.name),
    );
    assert.deepEqual(
      frame.output,
      row.output,
      "independently built immutable baseline must match whole Source view",
    );
  }
  const check = createCheckWorktree(root, "agent-events-controls", evidence);
  const owner = path.join(check.root, "crates/tea/src/agent/events.rs");
  const original = fs.readFileSync(owner, "utf8");
  let current;
  try {
    for (const fault of faults) {
      const folder = path.join(evidence, fault.name);
      fs.mkdirSync(folder);
      assert.equal(fs.readFileSync(owner, "utf8"), original);
      assert.equal(original.split(fault.before).length - 1, 1);
      const changed = original.replace(fault.before, fault.after);
      fs.writeFileSync(path.join(folder, "original.rs"), original);
      fs.writeFileSync(path.join(folder, "modified.rs"), changed);
      fs.writeFileSync(owner, changed);
      current = {
        name: fault.name,
        id: fault.id,
        originalSHA: hash(original),
        modifiedSHA: hash(changed),
        phase: "compile",
      };
      output.current = current;
      save();
      const args = [
        "build",
        "--locked",
        "--offline",
        "-p",
        "demlik-tea",
        "--example",
        "agent_events_driver",
        "--message-format=json",
      ];
      const build = spawnSync(cargo, args, {
        cwd: check.root,
        env: cargoCheckEnvironment(),
        encoding: "utf8",
        maxBuffer: 24 * 1024 * 1024,
      });
      fs.writeFileSync(
        path.join(folder, "cargo.stdout.jsonl"),
        build.stdout ?? "",
      );
      fs.writeFileSync(path.join(folder, "cargo.stderr"), build.stderr ?? "");
      write(path.join(folder, "cargo-process.json"), {
        command: [cargo, ...args],
        cwd: check.root,
        status: build.status,
        error: build.error ? String(build.error) : null,
      });
      assert.equal(
        build.status,
        0,
        "compile failure is not semantic detection",
      );
      assert.ifError(build.error);
      const artifacts = build.stdout
        .split("\n")
        .filter(Boolean)
        .map(JSON.parse);
      const library = compiledCheckLibrary(
        artifacts,
        "demlik_tea",
        check.root,
        check.target,
      );
      const selected = artifacts.filter(
        (a) =>
          a.reason === "compiler-artifact" &&
          a.target.name === "agent_events_driver" &&
          a.target.kind.includes("example") &&
          a.executable,
      );
      assert.equal(selected.length, 1);
      const driver = selected[0];
      assert.equal(driver.fresh, false);
      assertCheckPath(driver.target.src_path, check.root);
      assertCheckPath(driver.manifest_path, check.root);
      const binary = assertCheckPath(driver.executable, check.target);
      write(path.join(folder, "events.json"), {
        library: library.artifact,
        driver,
      });
      const retained = [];
      for (const [name, file] of [
        ["library", library.path],
        ["driver", binary],
      ]) {
        const bytes = fs.readFileSync(file),
          packed = gzipSync(bytes, { level: 1 });
        const saved = path.join(folder, `${name}.gz`);
        fs.writeFileSync(saved, packed);
        retained.push({
          role: name,
          actualPath: file,
          retained: saved,
          sha256: hash(bytes),
          gzipSha256: hash(packed),
          bytes: bytes.length,
        });
      }
      const effective = path.join(folder, "executed-driver");
      fs.copyFileSync(binary, effective);
      fs.chmodSync(effective, fs.statSync(binary).mode);
      current = {
        ...current,
        phase: "execute",
        retained,
        effectiveBinary: { path: effective, sha256: hashFile(effective) },
      };
      output.current = current;
      save();
      const row = rows.find((row) => row.input.id === fault.id);
      const frame = runCase(effective, row, path.join(folder, "witness"));
      const detection = {
        id: fault.id,
        Source: row.output,
        Native: frame.output,
        nativeTrace: frame.nativeTrace,
        wholeMismatch: !isDeepStrictEqual(row.output, frame.output),
        intendedWitness: fault.witness(row.output, frame.output),
      };
      write(path.join(folder, "comparison.json"), detection);
      assert.equal(detection.wholeMismatch, true);
      assert.equal(
        detection.intendedWitness,
        true,
        "must reach the named semantic witness",
      );
      output.faults.push({
        ...current,
        compileExit: 0,
        processExit: 0,
        detected: true,
        strictWitness: true,
      });
      fs.writeFileSync(owner, original);
      output.current = null;
      save();
    }
    output.completed = true;
  } catch (error) {
    output.failure = { message: String(error), current };
    throw error;
  } finally {
    fs.writeFileSync(owner, original);
    output.sourceRestored = hashFile(owner) === hash(original);
    save();
    check.remove();
    output.removed = true;
    output.baselineUnchanged = hashFile(baseline) === baselineHash;
    save();
  }
  return output;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [root, evidence, baseline, sourceReport] = process.argv.slice(2);
  const result = agentEventsControls({
    root,
    evidence,
    baseline,
    sourceReport,
  });
  console.log(
    JSON.stringify({
      completed: result.completed,
      detected: result.faults.length,
      removed: result.removed,
      SourceExecutions: 0,
    }),
  );
}
