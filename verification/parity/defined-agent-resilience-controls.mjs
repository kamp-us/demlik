import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const files = {
  defined: path.join(root, "crates/tea/src/agent/defined.rs"),
  knob: path.join(root, "crates/tea/src/agent/knob.rs"),
};
const originals = Object.fromEntries(
  Object.entries(files).map(([key, file]) => [
    key,
    fs.readFileSync(file, "utf8"),
  ]),
);
const controls = [
  {
    id: "drop-watchdog",
    file: "defined",
    from: "config = config.deadline_ms(deadline);",
    to: "let _ = deadline;",
  },
  {
    id: "drop-retry",
    file: "defined",
    from: "llm = llm.with_retry(retry);",
    to: "let _ = retry;",
  },
  {
    id: "default-retry",
    file: "defined",
    from: "retry: None,",
    to: "retry: Some(crate::retry_backoff::RetryPolicy {curve: crate::retry_backoff::BackoffCurve {base_ms: 5.0, factor: 2.0, cap_ms: 20.0, jitter: crate::retry_backoff::Jitter::None},budget: crate::retry_backoff::CountBound {max_attempts: 3.0}}.into_any()),",
  },
  {
    id: "reset-retained-attempt",
    file: "knob",
    from: "resumed.run = self.run.boot(&s.run, at).state;",
    to: "resumed.run = self.run.boot(&s.run, at).state; resumed.resilience = crate::resilience::resilient_call::State::from_snapshot(crate::resilience::resilient_call::Snapshot {retry: Rc::new(JsRecord::default()), ..resumed.resilience.snapshot().clone()});",
  },
];
const proof = fs.mkdtempSync(
  path.join(root, "target/parity/defined-agent-resilience-controls-"),
);
const results = [];
try {
  for (const c of controls) {
    const original = originals[c.file];
    assert.equal(original.split(c.from).length, 2, c.id);
    fs.writeFileSync(files[c.file], original.replace(c.from, c.to));
    const args = [
      path.join(
        root,
        "verification/parity/defined-agent-resilience-parity.mjs",
      ),
    ];
    const p = spawnSync(process.execPath, args, {
      cwd: root,
      encoding: "utf8",
      timeout: 120000,
      maxBuffer: 64 * 1024 * 1024,
    });
    fs.writeFileSync(path.join(proof, `${c.id}.stdout`), p.stdout ?? "");
    fs.writeFileSync(path.join(proof, `${c.id}.stderr`), p.stderr ?? "");
    const record = {
      id: c.id,
      command: [process.execPath, ...args],
      status: p.status,
      signal: p.signal,
      error: p.error?.message ?? null,
    };
    fs.writeFileSync(
      path.join(proof, `${c.id}.process.json`),
      JSON.stringify(record, null, 2),
    );
    fs.writeFileSync(files[c.file], original);
    assert.equal(p.signal, null, c.id);
    assert.equal(p.error, undefined, c.id);
    assert.notEqual(p.status, 0, c.id);
    assert(
      !/could not compile|error\[E\d+\]/.test(p.stderr),
      `${c.id}: must compile`,
    );
    assert.match(
      p.stderr,
      /AssertionError|unexpected runtime|bounded controlled|assertion failed/,
      `${c.id}: runtime contract must reject`,
    );
    results.push(record);
  }
} finally {
  for (const [key, file] of Object.entries(files))
    fs.writeFileSync(file, originals[key]);
}
const report = { status: "passed", controls: results.length, results, proof };
fs.writeFileSync(
  path.join(proof, "report.json"),
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify(report));
