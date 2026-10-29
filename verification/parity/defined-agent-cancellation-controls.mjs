import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildTeaExample } from "./tea-example.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const hash = (p) =>
  createHash("sha256").update(fs.readFileSync(p)).digest("hex");
fs.mkdirSync(path.join(root, "target/parity"), { recursive: true });
const proof = fs.mkdtempSync(
  path.join(root, "target/parity/defined-agent-cancellation-controls-"),
);
const file = path.join(root, "crates/tea/src/agent/defined.rs");
const original = fs.readFileSync(file, "utf8"),
  originalHash = hash(file),
  rows = [];
for (const c of [
  {
    id: "drop-drive-signal",
    before: "options.signal.map(|signal|",
    after: "options.signal.filter(|_| false).map(|signal|",
    witness: /preaborted signal must skip model/,
  },
  {
    id: "drop-store-signal",
    before: "signal: self.signal,",
    after: "signal: None,",
    witness: /preaborted signal must skip model/,
  },
  {
    id: "wrong-cancel-clock",
    before: "at: cancel_clock()",
    after: "at: cancel_clock() + 1.0",
    witness: /cancellation timestamp must use the caller clock/,
  },
]) {
  assert.equal(original.split(c.before).length, 2, c.id);
  try {
    fs.writeFileSync(file, original.replace(c.before, c.after));
    const producer = buildTeaExample(
      process.env.CARGO ?? "cargo",
      "defined_agent_cancellation",
      path.join(proof, c.id, "producer"),
    );
    const r = spawnSync(producer.binary, ["--case=preabort"], {
      cwd: root,
      encoding: "utf8",
      timeout: 10000,
      maxBuffer: 64 * 1024 * 1024,
    });
    for (const stream of ["stdout", "stderr"])
      fs.writeFileSync(
        path.join(proof, c.id, `native.${stream}`),
        r[stream] ?? "",
      );
    const processRecord = {
      command: [producer.binary, "--case=preabort"],
      status: r.status,
      signal: r.signal,
      error: r.error?.message ?? null,
    };
    fs.writeFileSync(
      path.join(proof, c.id, "native.process.json"),
      `${JSON.stringify(processRecord, null, 2)}\n`,
    );
    assert.equal(r.status, 101, `${c.id}: compiled semantic consumer failure`);
    assert.equal(r.signal, null);
    assert.equal(r.error, undefined);
    assert.match(r.stderr, c.witness);
    assert.equal(hash(producer.binary), producer.binarySha256);
    const libraryAfterSha256 = Object.fromEntries(
      Object.entries(producer.libraries).map(([name, v]) => {
        const after = hash(v.path);
        assert.equal(after, v.sha256);
        return [name, after];
      }),
    );
    rows.push({
      id: c.id,
      detected: true,
      witness: c.witness.source,
      producer,
      binaryAfterSha256: hash(producer.binary),
      libraryAfterSha256,
      process: processRecord,
    });
  } finally {
    fs.writeFileSync(file, original);
    assert.equal(hash(file), originalHash);
  }
}
fs.writeFileSync(
  path.join(proof, "report.json"),
  `${JSON.stringify(
    {
      proof,
      controls: rows,
      restoredSha256: hash(file),
      failures: [],
      credit:
        "Three compiled semantic controls only; no additional Source case or global parity credit.",
    },
    null,
    2,
  )}\n`,
);
console.log(
  JSON.stringify({ proof, controls: rows.map((r) => r.id), failures: [] }),
);
