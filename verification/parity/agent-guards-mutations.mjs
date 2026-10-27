import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { agentGuardsParity } from "./agent-guards-run.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url)),
  hash = (value) => createHash("sha256").update(value).digest("hex");
const types = "crates/tea/src/agent/types.rs",
  schema = "crates/tea/src/agent/schema.rs",
  compaction = "crates/tea/src/agent/compaction.rs",
  conversation = "crates/tea/src/agent/conversation.rs",
  slice = "crates/tea/src/flow/fan_out.rs";
const control = (name, file, before, after, id) => ({
  name,
  file,
  edits: [[before, after]],
  ids: [`agent-guards.${id}`],
});
const controls = [
  control(
    "reject-max-safe-count",
    types,
    "*number <= 9_007_199_254_740_991.0",
    "*number < 9_007_199_254_740_991.0",
    "count-inputTokens-max-safe",
  ),
  control(
    "accept-fractional-count",
    types,
    "number.fract() == 0.0",
    "true",
    "count-inputTokens-fraction",
  ),
  control(
    "optional-undefined-is-rejected",
    types,
    "None | Some(PlainData::Undefined) => true,\n                value => is_token_count(value),",
    "None => true,\n                value => is_token_count(value),",
    "count-reasoningTokens-undefined",
  ),
  control(
    "invent-cached-less-than-input-rule",
    types,
    'is_token_count(fields.get("inputTokens"))',
    '!matches!((fields.get("cachedInputTokens"),fields.get("inputTokens")),(Some(PlainData::Number(cached)),Some(PlainData::Number(input))) if cached>input) && is_token_count(fields.get("inputTokens"))',
    "usage-cached-exceeds-input",
  ),
  control(
    "only-first-tool-is-guarded",
    types,
    "calls.iter().all(is_tool_call)",
    "calls.first().is_none_or(is_tool_call)",
    "turn-late-tool-invalid",
  ),
  control(
    "null-tool-args-accepted",
    types,
    "Some(PlainData::Object(_) | PlainData::Array(_))",
    "Some(PlainData::Object(_) | PlainData::Array(_) | PlainData::Null)",
    "turn-tool-args-null",
  ),
  control(
    "opaque-null-provider-refused",
    types,
    'matches!(fields.get("content"), Some(PlainData::String(_)))',
    '!matches!(fields.get("provider"),Some(PlainData::Null)) && matches!(fields.get("content"), Some(PlainData::String(_)))',
    "turn-provider-null",
  ),
  control(
    "schema-remints-the-original",
    schema,
    "Ok(raw)",
    "Ok(Rc::new(raw.as_ref().clone()))",
    "turn-extra-retained",
  ),
  control(
    "schema-refusal-message-lost",
    schema,
    "structured-output parse failed: not {}",
    "structured-output parse failed: {}",
    "primitive-null",
  ),
  control(
    "summary-number-accepted",
    compaction,
    "Some(PlainData::String(_))",
    "Some(PlainData::String(_) | PlainData::Number(_))",
    "summary-number",
  ),
  control(
    "sum-invents-optional-zero",
    conversation,
    "(None, None) => AgentField::Absent,",
    "(None, None) => AgentField::Value(0.0.into()),",
    "sum-absent",
  ),
  control(
    "sum-clamps-to-safe-count",
    conversation,
    "input_tokens: (total.input_tokens.number_or_zero() + turn.input_tokens.number_or_zero())\n            .into(),",
    "input_tokens: (total.input_tokens.number_or_zero() + turn.input_tokens.number_or_zero()).min(9_007_199_254_740_991.0).into(),",
    "sum-infinite-overflow",
  ),
  control(
    "dedupe-keeps-duplicates",
    conversation,
    "seen.insert(&call.call_id)",
    "seen.insert(&call.call_id) || true",
    "dedupe-first-and-references",
  ),
  control(
    "fold-record-boundary-is-exclusive",
    conversation,
    "record.turn.number_or_zero() >= folding",
    "record.turn.number_or_zero() > folding",
    "fold-valid-identities",
  ),
  control(
    "fold-shift-loses-summary-slot",
    conversation,
    "let shift = folding - 1.0;",
    "let shift = folding;",
    "fold-fraction",
  ),
  control(
    "fold-resets-total-turn-count",
    conversation,
    "turn_count: conversation.turn_count,",
    "turn_count: 0.0.into(),",
    "fold-valid-identities",
  ),
  control(
    "fold-keeps-stale-context",
    conversation,
    "turn_count: conversation.turn_count,\n        awaiting: Awaiting::Llm,\n        context_tokens: AgentField::Value(AgentNumber(None)),",
    "turn_count: conversation.turn_count,\n        awaiting: Awaiting::Llm,\n        context_tokens: conversation.context_tokens.clone(),",
    "fold-valid-identities",
  ),
  control(
    "fold-copies-the-outcome-object",
    conversation,
    "outcome: Rc::clone(&record.outcome),",
    "outcome: Rc::new(match record.outcome.as_ref(){super::types::ToolOutcome::Ok(value)=>super::types::ToolOutcome::Ok(Rc::clone(value)),super::types::ToolOutcome::Error(value)=>super::types::ToolOutcome::Error(Rc::clone(value))}),",
    "fold-valid-identities",
  ),
  control(
    "negative-slice-index-rounds-down",
    slice,
    "len as f64 + index.trunc()",
    "len as f64 + index.floor()",
    "fold-negative-fraction",
  ),
  control(
    "negative-slice-branches-before-truncation",
    slice,
    "else if index.trunc() < 0.0",
    "else if index < 0.0",
    "fold-negative-near-zero",
  ),
];
export { controls as agentGuardControls };

export async function agentGuardsMutations(options = {}) {
  const baselineTarget =
      process.env.CARGO_TARGET_DIR ?? path.join(root, "target"),
    target =
      options.mutationTarget ??
      path.join(root, "target/agent-content-mutation-build");
  assert.notEqual(path.resolve(target), path.resolve(baselineTarget));
  const binary =
      options.binary ??
      path.join(baselineTarget, "debug/examples/agent_guards_driver"),
    binaryHash = hash(fs.readFileSync(binary));
  const originals = new Map(
    [types, schema, compaction, conversation, slice].map((file) => [
      file,
      fs.readFileSync(path.join(root, file), "utf8"),
    ]),
  );
  const referenceFiles = [
      "types.ts",
      "schema.ts",
      "compaction.ts",
      "internal.ts",
    ],
    sourceHashes = Object.fromEntries(
      referenceFiles.map((file) => [
        file,
        hash(fs.readFileSync(path.join(root, "packages/tea/src/agent", file))),
      ]),
    );
  const directory = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "demlik-agent-guards-faults-")),
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
    const baseline = await agentGuardsParity({
      binary,
      quiet: true,
      reportFile: path.join(
        root,
        "target/parity/agent-guards-mutation-baseline.json",
      ),
    });
    assert.equal(baseline.cases, 158);
    assert.equal(baseline.passed, 158);
    for (const entry of ["Cargo.toml", "Cargo.lock", "crates"])
      fs.cpSync(path.join(root, entry), path.join(workspace, entry), {
        recursive: true,
      });
    for (const item of controls.filter(
      (item) => !options.only || options.only.includes(item.name),
    )) {
      for (const [file, original] of originals)
        fs.writeFileSync(path.join(workspace, file), original);
      let source = originals.get(item.file);
      for (const [before, after] of item.edits) {
        assert.equal(
          source.split(before).length,
          2,
          `unique fault site ${item.name}`,
        );
        source = source.replace(before, after);
      }
      fs.writeFileSync(path.join(workspace, item.file), source);
      execFileSync(
        process.env.CARGO ?? "cargo",
        [
          "build",
          "--locked",
          "--offline",
          "-p",
          "demlik-tea",
          "--example",
          "agent_guards_driver",
        ],
        { cwd: workspace, env, stdio: "pipe", maxBuffer: 16 * 1024 * 1024 },
      );
      const result = await agentGuardsParity({
        binary: path.join(target, "debug/examples/agent_guards_driver"),
        caseIds: item.ids,
        quiet: true,
        allowFailures: true,
        reportFile: path.join(
          root,
          `target/parity/agent-guards-mutants/${item.name}.json`,
        ),
      });
      const failures = result.failures.map((failure) => failure.id);
      assert.ok(
        item.ids.some((id) => failures.includes(id)),
        `${item.name} escaped or failed unrelated cases`,
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
        originalSha256: hash(originals.get(item.file)),
        mutantSha256: hash(source),
      });
      if (!options.quiet)
        console.log(
          JSON.stringify({ detected: item.name, witnesses: failures.length }),
        );
    }
    for (const [file, original] of originals)
      assert.equal(fs.readFileSync(path.join(root, file), "utf8"), original);
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
      baseline: { cases: baseline.cases, passed: baseline.passed },
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
      path.join(root, "target/parity/agent-guards-mutations.json");
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
  await agentGuardsMutations();
