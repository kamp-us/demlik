import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { prerequisiteParity } from "./agent-state-prerequisite-run.mjs";
import {
  createCheckWorktree,
  checkedExecFileSync as execFileSync,
} from "./check-worktree.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url)),
  hash = (v) => createHash("sha256").update(v).digest("hex");
const types = "crates/tea/src/agent/types.rs",
  conv = "crates/tea/src/agent/conversation.rs",
  wire = "crates/tea/src/agent/wire.rs";
const control = (name, file, before, after, id) => ({
  name,
  file,
  before,
  after,
  ids: [`agent-state-prerequisite.${id}`],
});
const controls = [
  control(
    "copy-reallocates-turn-array",
    types,
    "turns: Rc::clone(&self.turns),",
    "turns: Rc::new(self.turns.as_ref().clone()),",
    "copy-null-wire",
  ),
  control(
    "copy-reallocates-record-array",
    types,
    "tool_records: Rc::clone(&self.tool_records),",
    "tool_records: Rc::new(self.tool_records.as_ref().clone()),",
    "copy-null-wire",
  ),
  control(
    "copy-collapses-null-legacy",
    types,
    "legacy_usage: self.legacy_usage.clone(),",
    "legacy_usage: match &self.legacy_usage {AgentField::Value(None)=>AgentField::Absent,v=>v.clone()},",
    "copy-null-wire",
  ),
  control(
    "zero-usage-owner-is-fresh",
    conv,
    "SHARED_NO_USAGE.with(Rc::clone)",
    "Rc::new(NO_USAGE.clone())",
    "shared-no-usage",
  ),
  control(
    "fold-reuses-turn-array",
    conv,
    "turns: Rc::new(turns),",
    "turns: Rc::clone(&conversation.turns),",
    "fold-0-null",
  ),
  control(
    "fold-reuses-record-array",
    conv,
    "tool_records: Rc::new(tool_records),",
    "tool_records: Rc::clone(&conversation.tool_records),",
    "fold-0-null",
  ),
  control(
    "fold-drops-legacy-usage",
    conv,
    "legacy_usage: conversation.legacy_usage.clone(),",
    "legacy_usage: AgentField::Absent,",
    "fold-0-null",
  ),
  control(
    "null-record-is-not-zero-for-filter",
    conv,
    "record.turn.number_or_zero() >= folding",
    "record.turn.number().unwrap_or(f64::NEG_INFINITY) >= folding",
    "fold-0-null",
  ),
  control(
    "null-record-is-not-zero-for-subtraction",
    conv,
    "turn: (record.turn.number_or_zero() - shift).into(),",
    "turn: AgentNumber(record.turn.number().map(|n|n-shift)),",
    "fold-0-null",
  ),
  control(
    "null-optional-is-treated-as-undefined",
    conv,
    "left.value(),\n        right.value(),",
    "left.value().filter(|n|n.number().is_some()),\n        right.value().filter(|n|n.number().is_some()),",
    "sum-null-optional",
  ),
  control(
    "serialization-coerces-null-count",
    types,
    '("turnCount", field::<S, _>(&self.turn_count)?),',
    '("turnCount", PlainData::Number(self.turn_count.number_or_zero())),',
    "copy-null-wire",
  ),
  control(
    "wire-missing-tool-result-becomes-null",
    wire,
    'crate::data::decode_missing("result")?',
    'serde_json::from_str("null").map_err(serde::de::Error::custom)?',
    "copy-undefined-tool-result-wire",
  ),
];
controls.find((x) => x.name === "fold-reuses-record-array").extraEdits = [
  [
    "let tool_records = conversation",
    "let tool_records: Vec<_> = conversation",
  ],
];
export async function prerequisiteMutations(options = {}) {
  const mutationCheck = createCheckWorktree(
    process.cwd(),
    "agent-state-prerequisite-mutations",
  );
  let mutationFailure;
  try {
    const baselineTarget =
        process.env.CARGO_TARGET_DIR ?? path.join(root, "target"),
      target = mutationCheck.target;
    assert.notEqual(path.resolve(target), path.resolve(baselineTarget));
    const binary =
        options.binary ??
        path.join(
          baselineTarget,
          "debug/examples/agent_state_prerequisite_driver",
        ),
      binaryHash = hash(fs.readFileSync(binary));
    const originals = new Map(
        [types, conv, wire].map((f) => [
          f,
          fs.readFileSync(path.join(root, f), "utf8"),
        ]),
      ),
      sourceHashes = Object.fromEntries(
        [
          "packages/tea/src/agent/internal.ts",
          "packages/tea/src/agent/types.ts",
        ].map((f) => [f, hash(fs.readFileSync(path.join(root, f)))]),
      );
    const temporary = mutationCheck.root,
      workspace = mutationCheck.root,
      detected = [];

    const env = {
      ...process.env,
      CARGO_PROFILE_DEV_DEBUG: "0",
      CARGO_PROFILE_TEST_DEBUG: "0",
      CARGO_INCREMENTAL: "0",
      CARGO_BUILD_JOBS: "1",
    };
    try {
      const baseline = await prerequisiteParity({
        binary,
        quiet: true,
        reportFile: path.join(
          root,
          "target/parity/agent-state-prerequisite-mutation-baseline.json",
        ),
      });
      assert.equal(baseline.cases, 49);
      assert.equal(baseline.passed, 49);

      for (const item of controls.filter(
        (x) => !options.only || options.only.includes(x.name),
      )) {
        for (const [f, s] of originals)
          fs.writeFileSync(path.join(workspace, f), s);
        const before = originals.get(item.file);
        assert.equal(
          before.split(item.before).length,
          2,
          `${item.name} unique site`,
        );
        let mutant = before.replace(item.before, item.after);
        for (const [from, to] of item.extraEdits ?? []) {
          assert.equal(mutant.split(from).length, 2);
          mutant = mutant.replace(from, to);
        }
        fs.writeFileSync(path.join(workspace, item.file), mutant);
        execFileSync(
          process.env.CARGO ?? "cargo",
          [
            "build",
            "--locked",
            "--offline",
            "-p",
            "demlik-tea",
            "--example",
            "agent_state_prerequisite_driver",
          ],
          { cwd: workspace, env, stdio: "pipe", maxBuffer: 16 * 1024 * 1024 },
        );
        const result = await prerequisiteParity({
            binary: path.join(
              target,
              "debug/examples/agent_state_prerequisite_driver",
            ),
            caseIds: item.ids,
            allowFailures: true,
            quiet: true,
            reportFile: path.join(
              root,
              `target/parity/agent-state-prerequisite-mutants/${item.name}.json`,
            ),
          }),
          failures = result.failures.map((x) => x.id);
        assert.ok(
          item.ids.some((id) => failures.includes(id)),
          `${item.name}: no declared witness`,
        );
        for (const id of failures)
          assert.ok(!Object.hasOwn(result.nativeEvidence, id));
        detected.push({
          name: item.name,
          file: item.file,
          compiled: true,
          detected: true,
          expected: item.ids,
          failures,
          originalSha256: hash(before),
          mutantSha256: hash(mutant),
          compileCompanions: item.extraEdits ?? [],
        });
        console.log(JSON.stringify({ detected: item.name }));
      }
      for (const [f, s] of originals)
        assert.equal(fs.readFileSync(path.join(root, f), "utf8"), s);
      for (const [f, h] of Object.entries(sourceHashes))
        assert.equal(hash(fs.readFileSync(path.join(root, f))), h);
      assert.equal(hash(fs.readFileSync(binary)), binaryHash);
      const report = {
        baseline: { total: baseline.cases, passed: baseline.passed },
        detected: detected.length,
        escaped: 0,
        controls: detected,
        sourceHashes,
        activeSourceUnchanged: true,
        baselineArtifactUnchanged: true,
        baselineArtifactSha256: binaryHash,
        targets: {
          baselineTarget,
          mutationTarget: target,
          debug: 0,
          incremental: false,
          jobs: 1,
        },
      };
      const output =
        options.reportFile ??
        path.join(
          root,
          "target/parity/agent-state-prerequisite-mutations.json",
        );
      fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
      console.log(
        JSON.stringify({
          detected: detected.length,
          escaped: 0,
          reportFile: output,
        }),
      );
      return report;
    } finally {
    }
  } catch (error) {
    mutationFailure = error;
    throw error;
  } finally {
    mutationCheck.remove(mutationFailure);
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  await prerequisiteMutations();
