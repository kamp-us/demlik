import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { agentContentParity } from "./agent-content-run.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url)),
  hash = (value) => createHash("sha256").update(value).digest("hex");
const content = "crates/tea/src/agent/content.rs",
  transcript = "crates/tea/src/agent/transcript.rs",
  types = "crates/tea/src/agent/types.rs";
const controls = [
  {
    name: "parts-return-a-copy",
    file: content,
    edits: [
      [
        "MessageContent::Parts(parts) => Rc::clone(parts),",
        "MessageContent::Parts(parts) => Rc::new(RefCell::new(parts.borrow().clone())),",
      ],
    ],
    ids: ["agent-content.alias-and-media"],
  },
  {
    name: "text-is-reminted-during-omission",
    file: content,
    edits: [
      [
        "ContentPart::Text(_) => part.clone(),",
        "ContentPart::Text(text) => ContentPart::Text(Rc::new(TextPart { text: text.text.clone() })),",
      ],
    ],
    ids: ["agent-content.alias-and-media"],
  },
  {
    name: "file-uses-image-placeholder",
    file: content,
    edits: [["text: FILE_OMITTED.into(),", "text: IMAGE_OMITTED.into(),"]],
    ids: ["agent-content.alias-and-media"],
  },
  {
    name: "byte-view-copies-buffer",
    file: content,
    edits: [
      [
        "buffer: Rc::clone(&self.0.buffer),",
        "buffer: self.0.buffer.iter().map(|byte| Cell::new(byte.get())).collect::<Vec<_>>().into(),",
      ],
    ],
    ids: ["agent-content.alias-and-media"],
  },
  {
    name: "byte-copy-shares-storage",
    file: content,
    edits: [
      [
        "    pub fn copied(&self) -> Self {\n        Self::new(self.to_vec())\n    }",
        "    pub fn copied(&self) -> Self {\n        self.clone()\n    }",
      ],
    ],
    ids: ["agent-content.alias-and-media"],
  },
  {
    name: "nested-byte-result-has-numeric-native-keys",
    file: content,
    edits: [
      [
        "map.serialize_entry(&index.to_string(), &byte)?;",
        "map.serialize_entry(&index, &byte)?;",
      ],
    ],
    ids: ["agent-transcript.live-seeded"],
  },
  {
    name: "seed-discards-ok-records",
    file: transcript,
    edits: [["if is_ok(&record)? {", "if false && is_ok(&record)? {"]],
    ids: ["agent-transcript.seed-only"],
  },
  {
    name: "seed-discards-old-turns",
    file: transcript,
    edits: [
      [
        "state.turns = conversation.turns.clone();",
        "state.turns = Vec::new();",
      ],
    ],
    ids: ["agent-transcript.seed-only"],
  },
  {
    name: "tool-wrapper-is-copied-on-every-read",
    file: transcript,
    edits: [
      [
        "tools: state.tools.clone(),",
        "tools: state.tools.iter().map(|tool| Rc::new(TranscriptToolResult { call_id: tool.call_id.clone(), result: Rc::clone(&tool.result) })).collect(),",
      ],
    ],
    ids: ["agent-transcript.live-seeded"],
  },
  {
    name: "status-object-is-copied",
    file: transcript,
    edits: [
      [
        "TranscriptOutcome::Ended(Rc::clone(status)),",
        `TranscriptOutcome::Ended(Rc::new(match status.as_ref() {
 AgentEndedStatus::Done {output,usage} => AgentEndedStatus::Done {output:output.clone(),usage:Rc::clone(usage)},
 AgentEndedStatus::Failed {failure} => AgentEndedStatus::Failed {failure:Rc::clone(failure)},
 AgentEndedStatus::Cancelled {at} => AgentEndedStatus::Cancelled {at:*at},
 })),`,
      ],
    ],
    ids: ["agent-transcript.repeated-status"],
  },
  {
    name: "collector-closes-after-run-done",
    file: transcript,
    edits: [
      [
        "    pub fn on_event<P, A, E>(&self, event: &AgentEvent<R, T, F, P, A, E>) {",
        "    pub fn on_event<P, A, E>(&self, event: &AgentEvent<R, T, F, P, A, E>) {\n        if self.inner.borrow().outcome.ended().is_some() { return; }",
      ],
    ],
    ids: ["agent-transcript.late-events"],
  },
  {
    name: "ended-wire-has-accidental-wrapper",
    file: transcript,
    edits: [
      [
        "Self::Ended(status) => status.serialize(serializer),",
        'Self::Ended(status) => JsonData(&object([("Ended", field::<S,_>(status)?)])).serialize(serializer),',
      ],
    ],
    ids: ["agent-transcript.ending-0"],
  },
  {
    name: "done-null-looks-running",
    file: types,
    edits: [
      [
        '("kind", PlainData::String("done".into())),',
        '("kind", PlainData::String(if output.is_none() {"running"}else{"done"}.into())),',
      ],
    ],
    ids: ["agent-transcript.ending-0"],
  },
  {
    name: "undefined-result-becomes-null",
    file: transcript,
    edits: [
      [
        '("result", field::<S, _>(&self.result)?),',
        '("result", match field::<S,_>(&self.result)? { PlainData::Undefined => PlainData::Null, value => value }),',
      ],
    ],
    ids: ["agent-transcript.result-undefined"],
  },
  {
    name: "raw-string-replaces-unpaired-units",
    file: transcript,
    edits: [
      [
        "Err(value) => JsText::from_units(vec![value.unpaired_surrogate()]),",
        'Err(_value) => JsText::from("�"),',
      ],
    ],
    ids: ["agent-seed.string-turns"],
  },
  {
    name: "canonical-provider-is-forgotten",
    file: types,
    edits: [
      [
        "if let AgentField::Value(value) = &self.provider {",
        "if let AgentField::Value(value) = &self.provider { let _=value; if false {",
      ],
      [
        '            fields.push(("provider", field::<S, _>(value)?));',
        '            fields.push(("provider", field::<S, _>(value)?)); }',
      ],
    ],
    ids: ["agent-canonical.provider-opaque"],
  },
];
export async function agentContentMutations(options = {}) {
  const baselineTarget =
      process.env.CARGO_TARGET_DIR ?? path.join(root, "target"),
    target =
      options.mutationTarget ??
      path.join(root, "target/agent-content-mutation-build");
  assert.notEqual(path.resolve(target), path.resolve(baselineTarget));
  const binary =
      options.binary ??
      path.join(baselineTarget, "debug/examples/agent_content_driver"),
    binaryHash = hash(fs.readFileSync(binary));
  const originals = new Map(
    [content, transcript, types].map((file) => [
      file,
      fs.readFileSync(path.join(root, file), "utf8"),
    ]),
  );
  const referenceFiles = [
      "content.ts",
      "transcript.ts",
      "types.ts",
      "machine.ts",
    ],
    sourceHashes = Object.fromEntries(
      referenceFiles.map((file) => [
        file,
        hash(fs.readFileSync(path.join(root, "packages/tea/src/agent", file))),
      ]),
    );
  const directory = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "demlik-agent-content-faults-")),
    ),
    workspace = path.join(directory, "workspace");
  fs.mkdirSync(workspace);
  const env = {
      ...process.env,
      CARGO_TARGET_DIR: target,
      CARGO_PROFILE_DEV_DEBUG: "0",
      CARGO_PROFILE_TEST_DEBUG: "0",
      CARGO_INCREMENTAL: "0",
      CARGO_BUILD_JOBS: "1",
    },
    detected = [];
  try {
    const baseline = await agentContentParity({
      binary,
      quiet: true,
      reportFile: path.join(
        root,
        "target/parity/agent-content-mutation-baseline.json",
      ),
    });
    for (const entry of ["Cargo.toml", "Cargo.lock", "crates"])
      fs.cpSync(path.join(root, entry), path.join(workspace, entry), {
        recursive: true,
      });
    for (const control of controls.filter(
      (c) => !options.only || options.only.includes(c.name),
    )) {
      for (const [file, source] of originals)
        fs.writeFileSync(path.join(workspace, file), source);
      let source = originals.get(control.file);
      for (const [before, after] of control.edits) {
        assert.equal(
          source.split(before).length,
          2,
          `unique fault site ${control.name}`,
        );
        source = source.replace(before, after);
      }
      fs.writeFileSync(path.join(workspace, control.file), source);
      execFileSync(
        process.env.CARGO ?? "cargo",
        [
          "build",
          "--locked",
          "--offline",
          "-p",
          "demlik-tea",
          "--example",
          "agent_content_driver",
        ],
        { cwd: workspace, env, stdio: "pipe", maxBuffer: 16 * 1024 * 1024 },
      );
      const result = await agentContentParity({
        binary: path.join(target, "debug/examples/agent_content_driver"),
        caseIds: control.ids,
        quiet: true,
        allowFailures: true,
        reportFile: path.join(
          root,
          `target/parity/agent-content-mutants/${control.name}.json`,
        ),
      });
      const failures = result.failures.map((f) => f.id);
      assert.ok(
        control.ids.some((id) => failures.includes(id)),
        `${control.name} escaped or failed unrelated cases`,
      );
      for (const id of failures)
        assert.ok(!Object.hasOwn(result.nativeEvidence, id));
      detected.push({
        name: control.name,
        file: control.file,
        compiled: true,
        detected: true,
        expected: control.ids,
        failures,
        originalSha256: hash(originals.get(control.file)),
        mutantSha256: hash(source),
      });
      if (!options.quiet)
        console.log(
          JSON.stringify({
            detected: control.name,
            witnesses: failures.length,
          }),
        );
    }
    for (const [file, source] of originals)
      assert.equal(fs.readFileSync(path.join(root, file), "utf8"), source);
    assert.equal(hash(fs.readFileSync(binary)), binaryHash);
    for (const file of referenceFiles)
      assert.equal(
        hash(fs.readFileSync(path.join(root, "packages/tea/src/agent", file))),
        sourceHashes[file],
      );
    const report = {
      reference: "75de37ea01a81cd7949e6275b7ee9cfdeb4e312d",
      node: process.version,
      v8: process.versions.v8,
      detected: detected.length,
      escaped: 0,
      baseline: {
        cases: baseline.cases,
        passed: baseline.passed,
        profileObservations: baseline.profileObservations,
      },
      controls: detected,
      sourceHashes,
      activeSourceUnchanged: true,
      baselineArtifactUnchanged: true,
      baselineArtifactSha256: binaryHash,
      build: {
        baselineTarget,
        mutationTarget: target,
        debug: 0,
        incremental: false,
        jobs: 1,
      },
    };
    const reportFile =
      options.reportFile ??
      path.join(root, "target/parity/agent-content-mutations.json");
    fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
    if (!options.quiet)
      console.log(
        JSON.stringify({ detected: detected.length, escaped: 0, reportFile }),
      );
    return report;
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  await agentContentMutations();
