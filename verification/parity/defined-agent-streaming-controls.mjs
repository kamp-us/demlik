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
  path.join(root, "target/parity/defined-agent-streaming-controls-"),
);
const controls = [
  {
    id: "drop-model-forward",
    file: "crates/tea/src/agent/defined.rs",
    before: "self.model.model_of_with_stream(id, self.stream.clone())",
    after: "self.model.model_of(id)",
    case: "watched",
    message: /configured stream must deliver its original chunk/,
  },
  {
    id: "drop-run-sink",
    file: "crates/tea/src/agent/defined.rs",
    before:
      "options\n                .on_chunk\n                .map(ModelStream::contained)\n                .unwrap_or_default()",
    after: "ModelStream::default()",
    case: "watched",
    message: /configured stream must deliver its original chunk/,
  },
  {
    id: "drop-store-sink",
    file: "crates/tea/src/agent/defined.rs",
    before: "on_chunk: self.on_chunk,",
    after: "on_chunk: None,",
    case: "watched",
    message: /configured stream must deliver its original chunk/,
  },
  {
    id: "escape-listener-panic",
    file: "crates/tea/src/agent/model.rs",
    before:
      '        Self::new(move |chunk| {\n            if let Err(payload) =\n                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| sink(chunk)))\n            {\n                eprintln!(\n                    "demlik: on_chunk listener panicked: {}",\n                    crate::storage::PanicCause::new(payload).summary\n                );\n            }\n        })',
    after: "        Self(sink)",
    case: "throwing",
    message: /unexpected DriveStalledError/,
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
      "defined_agent_streaming",
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
