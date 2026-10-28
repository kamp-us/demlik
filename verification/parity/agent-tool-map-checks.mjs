import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import {
  assertCheckPath,
  cargoCheckEnvironment,
  compiledCheckLibrary,
  createCheckWorktree,
} from "./check-worktree.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const [baseline, baselineReport, sourceReport, output] = process.argv.slice(2);
assert.ok(
  baseline &&
    baselineReport &&
    sourceReport &&
    output &&
    process.argv.length === 6,
);
const evidence = path.resolve(output);
fs.mkdirSync(evidence, { recursive: true });
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const faults = [
  {
    id: "map-continues-after-first-error",
    owner: "crates/tea/src/flow/fan_out.rs",
    needle: ".collect::<Result<Vec<_>, L>>()?;",
    replacement:
      ".collect::<Vec<_>>().into_iter().collect::<Result<Vec<_>, L>>()?;",
    witness: "fan.scatter-prefix",
  },
  {
    id: "discarded-fan-map-error-swallowed",
    owner: "crates/tea/src/agent/knob.rs",
    needle: "let scattered = self.fan.try_scatter(&self.fan.init(), batch)?;",
    replacement:
      "let scattered = self.fan.try_scatter(&self.fan.init(), batch).unwrap_or_else(|_| Step::new(self.fan.init(), vec![]));",
    witness: "agent.turn-discarded",
  },
  {
    id: "original-mapping-error-reminted",
    owner: "crates/tea/src/agent/knob/error.rs",
    needle:
      "fn from(error: std::rc::Rc<super::super::tool::ToolError>) -> Self {\n        Self::ToolMapping(error)\n    }",
    replacement:
      'fn from(error: std::rc::Rc<super::super::tool::ToolError>) -> Self {\n        drop(error);\n        Self::ToolMapping(std::rc::Rc::new(super::super::tool::ToolError::Reserved { name: "map_fault".into() }))\n    }',
    witness: "agent.turn-discarded",
  },
  {
    id: "ladder-retry-mapping-error-swallowed",
    owner: "crates/tea/src/agent/tool_resilience.rs",
    start: "    fn cmds(",
    end: "    pub(crate) fn launch(",
    needle: ".collect()",
    replacement: ".collect::<Result<Vec<_>, _>>().or_else(|_| Ok(vec![]))",
    witness: "agent.timer-retry",
  },
];
const originals = Object.fromEntries(
  faults.map((f) => [
    f.owner,
    fs.readFileSync(path.join(root, f.owner), "utf8"),
  ]),
);
const trusted = JSON.parse(fs.readFileSync(baselineReport, "utf8"));
assert.equal(trusted.cases, 12);
assert.equal(trusted.passed, 10);
assert.equal(trusted.qualifiedPassed, 2);
assert.deepEqual(trusted.failures, []);
assert.equal(hash(fs.readFileSync(baseline)), trusted.binaryHash);
for (const fault of faults) {
  const text = originals[fault.owner],
    section = fault.start
      ? text.slice(text.indexOf(fault.start), text.indexOf(fault.end))
      : text;
  assert.equal(section.split(fault.needle).length, 2, fault.id);
}
let check;
const report = {
  planned: 4,
  cargoSelections: 0,
  controls: [],
  complete: false,
  sourceRestored: false,
  baselineHash: trusted.binaryHash,
  sourceReportHash: hash(fs.readFileSync(sourceReport)),
  qualifiedControls: 0,
};
function save() {
  fs.writeFileSync(
    path.join(evidence, "report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
}
function retain(file, name) {
  const canonical = assertCheckPath(file, check.target),
    bytes = fs.readFileSync(canonical),
    dest = `${name}.gz`;
  fs.writeFileSync(path.join(evidence, dest), gzipSync(bytes, { level: 1 }));
  return {
    path: canonical,
    sha256: hash(bytes),
    bytes: bytes.length,
    retained: dest,
  };
}
function restore() {
  for (const [file, bytes] of Object.entries(originals))
    fs.writeFileSync(path.join(check.root, file), bytes);
}
try {
  check = createCheckWorktree(root, "agent-tool-map", evidence);
  report.sourceCommit = JSON.parse(
    fs.readFileSync(
      path.join(evidence, "agent-tool-map-worktree.json"),
      "utf8",
    ),
  ).sourceCommit;
  report.root = check.root;
  report.target = check.target;
  save();
  const { agentToolMapParity } = await import(
    pathToFileURL(
      path.join(check.root, "verification/parity/agent-tool-map-run.mjs"),
    )
  );
  for (const fault of faults) {
    restore();
    const original = originals[fault.owner];
    let changed;
    if (fault.start) {
      const start = original.indexOf(fault.start),
        end = original.indexOf(fault.end);
      assert.ok(start >= 0 && end > start);
      changed =
        original.slice(0, start) +
        original.slice(start, end).replace(fault.needle, fault.replacement) +
        original.slice(end);
    } else changed = original.replace(fault.needle, fault.replacement);
    fs.writeFileSync(path.join(check.root, fault.owner), changed);
    fs.writeFileSync(path.join(evidence, `${fault.id}-original.rs`), original);
    fs.writeFileSync(path.join(evidence, `${fault.id}-modified.rs`), changed);
    const attempt = {
      id: fault.id,
      owner: fault.owner,
      sourceSha256: hash(changed),
      witness: fault.witness,
      detected: false,
    };
    report.controls.push(attempt);
    save();
    const command = [
      process.env.CARGO ?? "cargo",
      "build",
      "--locked",
      "--offline",
      "-p",
      "demlik-tea",
      "--lib",
      "--example",
      "agent_tool_map_driver",
      "--message-format=json",
    ];
    report.cargoSelections++;
    const result = spawnSync(command[0], command.slice(1), {
      cwd: check.root,
      env: cargoCheckEnvironment(),
      encoding: "utf8",
      maxBuffer: 64 << 20,
      timeout: 180_000,
    });
    fs.writeFileSync(
      path.join(evidence, `${fault.id}-cargo.stdout`),
      result.stdout ?? "",
    );
    fs.writeFileSync(
      path.join(evidence, `${fault.id}-cargo.stderr`),
      result.stderr ?? "",
    );
    Object.assign(attempt, {
      command,
      compileExit: result.status,
      signal: result.signal,
      spawnError: result.error?.message,
    });
    const events = (result.stdout ?? "")
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map(JSON.parse);
    // Retain available actual producers before freshness/witness assertions can reject.
    attempt.availableArtifacts = [];
    for (const e of events.filter(
      (e) =>
        e.reason === "compiler-artifact" &&
        ["demlik_tea", "agent_tool_map_driver"].includes(e.target.name),
    )) {
      const file = e.executable ?? e.filenames.find((f) => f.endsWith(".rlib"));
      if (file && fs.existsSync(file))
        attempt.availableArtifacts.push({
          role: e.target.name,
          fresh: e.fresh,
          event: e,
          ...retain(file, `${fault.id}-${e.target.name}`),
        });
    }
    save();
    assert.ifError(result.error);
    assert.equal(result.status, 0);
    assert.equal(result.signal, null);
    const library = compiledCheckLibrary(
      events,
      "demlik_tea",
      check.root,
      check.target,
    );
    const consumers = events.filter(
      (e) =>
        e.reason === "compiler-artifact" &&
        e.target.name === "agent_tool_map_driver" &&
        e.target.kind.includes("example") &&
        e.executable,
    );
    assert.equal(consumers.length, 1);
    const consumer = consumers[0];
    assert.equal(consumer.fresh, false);
    assertCheckPath(consumer.target.src_path, check.root);
    assertCheckPath(consumer.manifest_path, check.root);
    const binary = assertCheckPath(consumer.executable, check.target),
      beforeHash = hash(fs.readFileSync(binary));
    const pairFile = path.join(evidence, `${fault.id}-comparison.json`);
    const compared = agentToolMapParity({
      binary,
      output: pairFile,
      sourceReport,
      onlyId: fault.witness,
      allowFailures: true,
    });
    Object.assign(attempt, {
      libraryFresh: library.artifact.fresh,
      consumerFresh: consumer.fresh,
      executedBinarySha256: beforeHash,
      comparison: pairFile,
      nativeProcess: compared.processes.native,
    });
    save();
    assert.equal(hash(fs.readFileSync(binary)), beforeHash);
    assert.equal(compared.cases, 1);
    assert.equal(compared.passed, 0);
    assert.equal(compared.qualifiedPassed, 0);
    assert.equal(compared.failures.length, 1);
    assert.equal(compared.failures[0].id, fault.witness);
    assert.equal(compared.processes.native.status, 0);
    assert.equal(compared.processes.native.stderr, "");
    assert.equal(compared.observations[0].native.ok, true);
    assert.ok(compared.observations[0].native.output);
    attempt.detected = true;
    save();
  }
  restore();
  report.sourceRestored = Object.entries(originals).every(
    ([f, s]) => fs.readFileSync(path.join(check.root, f), "utf8") === s,
  );
  report.baselineUnchanged =
    hash(fs.readFileSync(baseline)) === trusted.binaryHash;
  assert.ok(report.sourceRestored && report.baselineUnchanged);
  report.complete = true;
} catch (error) {
  report.error = {
    name: error.name,
    message: error.message,
    stack: error.stack,
  };
  throw error;
} finally {
  if (check) {
    try {
      restore();
      report.sourceRestored = Object.entries(originals).every(
        ([f, s]) => fs.readFileSync(path.join(check.root, f), "utf8") === s,
      );
      check.remove();
      report.worktreeRemoved = !fs.existsSync(check.root);
      report.defaultTargetRemoved = !fs.existsSync(check.target);
    } catch (error) {
      report.cleanupError = { name: error.name, message: error.message };
    }
  }
  save();
}
