import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildTeaExample } from "./tea-example.mjs";

const hash = (file) =>
  createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const root = fileURLToPath(new URL("../..", import.meta.url));
const proof = fs.mkdtempSync(
  path.join(root, "target/parity/defined-agent-tool-policy-controls-"),
);
const controls = [
  {
    id: "drop-selector",
    file: "crates/tea/src/agent/defined.rs",
    before: "move |call| policy_tools.resilience_of(call)",
    after: "move |_call| { let _ = &policy_tools; None }",
    case: "retry-recover",
    message: /successful retry starts two attempts/,
  },
  {
    id: "drop-timeout",
    file: "crates/tea/src/agent/tool_resilience.rs",
    before: "deadline: policy.timeout_ms.map(|ms| rc::DeadlineConfig { ms })",
    after: "deadline: None",
    case: "timeout-late",
    message: /overall timeout produces the final ending/,
  },
  {
    id: "attempt-hook",
    file: "crates/tea/src/agent/defined.rs",
    before: "if self.router.command_has_policy(command)",
    after: "if false",
    case: "retry-recover",
    message: /absorbed retry attempts stay silent/,
  },
  {
    id: "lost-last-reason",
    file: "crates/tea/src/agent/tool/router.rs",
    before: "RetryExhausted{attempts,last:reason}",
    after: 'RetryExhausted{attempts,last:{let _ = reason; "lost".into()}}',
    case: "retry-exhaust",
    message: /exhaustion keeps last reason/,
  },
];
const rows = [];
for (const control of controls) {
  const file = path.join(root, control.file),
    original = fs.readFileSync(file, "utf8");
  assert(original.includes(control.before), control.id);
  try {
    fs.writeFileSync(file, original.replace(control.before, control.after));
    const producer = buildTeaExample(
      process.env.CARGO ?? "cargo",
      "defined_agent_tool_policy",
      path.join(proof, control.id, "producer"),
    );
    const r = spawnSync(producer.binary, [`--case=${control.case}`], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      timeout: 10000,
    });
    for (const stream of ["stdout", "stderr"])
      fs.writeFileSync(
        path.join(proof, control.id, `native.${stream}`),
        r[stream] ?? "",
      );
    const processRecord = {
      command: [producer.binary, `--case=${control.case}`],
      status: r.status,
      signal: r.signal,
      error: r.error?.message ?? null,
    };
    fs.writeFileSync(
      path.join(proof, control.id, "native.process.json"),
      JSON.stringify(processRecord, null, 2),
    );
    assert.equal(
      r.status,
      101,
      `${control.id}: credible public consumer assertion failure`,
    );
    assert.equal(r.signal, null);
    assert.equal(r.error, undefined);
    assert.match(r.stderr, control.message);
    rows.push({
      id: control.id,
      detected: true,
      producer,
      binaryAfterSha256: (() => {
        const after = hash(producer.binary);
        assert.equal(after, producer.binarySha256);
        return after;
      })(),
      libraryAfterSha256: Object.fromEntries(
        Object.entries(producer.libraries).map(([name, library]) => {
          const after = hash(library.path);
          assert.equal(after, library.sha256);
          return [name, after];
        }),
      ),
      process: processRecord,
    });
  } finally {
    fs.writeFileSync(file, original);
  }
}
console.log(
  JSON.stringify({
    status: "passed",
    cases: rows.length,
    failures: [],
    proof,
    rows,
  }),
);
