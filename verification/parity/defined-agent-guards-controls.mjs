import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildTeaExample } from "./tea-example.mjs";
const root = fileURLToPath(new URL("../..", import.meta.url));
const report = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const expected = fs
  .readFileSync(path.join(report.proof, "source.stdout"), "utf8")
  .trim()
  .split("\n")
  .map(JSON.parse);
const owner = path.join(root, "crates/tea/src/agent/defined.rs");
const original = fs.readFileSync(owner, "utf8");
const proof = fs.mkdtempSync(
  path.join(root, "target/parity/defined-agent-guards-controls-")
);
const controls = [
  {
    id: "dropped-turn-forwarding",
    from: "config = config.max_turns(limit);",
    to: "let _ = limit;",
    case: "one",
  },
  {
    id: "dropped-elapsed-forwarding",
    from: "config = config.max_elapsed_ms(limit);",
    to: "let _ = limit;",
    case: "resume-elapsed",
  },
  {
    id: "dropped-stop-forwarding",
    from: "config = config.stop_when(move |state| predicate(state));",
    to: "let _ = predicate;",
    case: "stop",
  },
  {
    id: "cancelled-as-drive-failure",
    from: "matches!(state.run.phase, RunPhase::Failed { .. })",
    to: "matches!(state.run.phase, RunPhase::Failed { .. } | RunPhase::Cancelled { .. })",
    case: "stop",
  },
];
const results = [];
try {
  for (const control of controls) {
    assert.equal(original.split(control.from).length, 2, control.id);
    fs.writeFileSync(owner, original.replace(control.from, control.to));
    const directory = path.join(proof, control.id);
    fs.mkdirSync(directory);
    const producer = buildTeaExample(
      process.env.CARGO ?? "cargo",
      "defined_agent_guards",
      path.join(directory, "producer")
    );
    const result = spawnSync(producer.binary, [], {
      cwd: root,
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 64 * 1024 * 1024,
    });
    fs.writeFileSync(path.join(directory, "stdout"), result.stdout ?? "");
    fs.writeFileSync(path.join(directory, "stderr"), result.stderr ?? "");
    assert.equal(
      result.status,
      0,
      `${control.id} must reach the public behavior comparison, not fail elsewhere`
    );
    const actual = result.stdout.trim().split("\n").map(JSON.parse);
    const before = expected.find((row) => row.id === control.case);
    const after = actual.find((row) => row.id === control.case);
    assert(before && after);
    assert.notDeepEqual(after, before, control.id);
    if (control.id === "cancelled-as-drive-failure") {
      assert.equal(before.phase.outcome, "resolved");
      assert.equal(after.phase.outcome, "failed");
      assert.deepEqual(after.phase.final, before.phase.final);
    } else
      assert(
        after.phase.calls > before.phase.calls,
        `${control.id}: omission must allow an extra actual model call`
      );
    results.push({
      id: control.id,
      detected: true,
      mutatedOwnerSha256: createHash("sha256")
        .update(fs.readFileSync(owner))
        .digest("hex"),
      case: control.case,
      before: { calls: before.phase.calls, outcome: before.phase.outcome },
      after: { calls: after.phase.calls, outcome: after.phase.outcome },
      producer,
    });
  }
} finally {
  fs.writeFileSync(owner, original);
}
const receipt = {
  status: "passed",
  proof,
  results,
  originalOwnerSha256: createHash("sha256").update(original).digest("hex"),
  restoredOwnerSha256: createHash("sha256")
    .update(fs.readFileSync(owner))
    .digest("hex"),
};
fs.writeFileSync(
  path.join(proof, "report.json"),
  JSON.stringify(receipt, null, 2) + "\n"
);
console.log(JSON.stringify(receipt));
