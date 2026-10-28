import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { agentBaseParity } from "./agent-base-run.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url)),
  hash = (v) => createHash("sha256").update(v).digest("hex"),
  knob = "crates/tea/src/agent/knob.rs";
const c = (name, before, after, ...ids) => ({
  name,
  edits: [[before, after]],
  ids: ids.map((id) => `agent-base.${id}`),
});
const controls = [
  c(
    "skip-usage-migration",
    "let current = s.with_usage_defaults();",
    "let current = Rc::clone(s);",
    "legacy-value",
  ),
  c(
    "retain-prior-lifecycle",
    "entered.lifecycle = AgentField::Value(Rc::new(vec![]));",
    "entered.lifecycle = current.lifecycle.clone();",
    "stale-and-note-clearing",
  ),
  c(
    "duplicate-terminal-note",
    "if !was_settled && step.state.is_settled() {",
    "if step.state.is_settled() {",
    "stale-and-note-clearing",
  ),
  c(
    "remint-retained-note-handles",
    ".map_or_else(Vec::new, |old| old.as_ref().clone());",
    `.map_or_else(Vec::new, |old| old.iter().map(|note| Rc::new(match note.as_ref() {
    AgentLifecycleNote::BrainStarted{turn,purpose,model,at} => AgentLifecycleNote::BrainStarted{turn:*turn,purpose:purpose.clone(),model:model.clone(),at:*at},
    AgentLifecycleNote::ToolStarted{call,at} => AgentLifecycleNote::ToolStarted{call:Rc::clone(call),at:*at},
    AgentLifecycleNote::ToolFailed{call,failure,at} => AgentLifecycleNote::ToolFailed{call:Rc::clone(call),failure:Rc::clone(failure),at:*at},
    AgentLifecycleNote::RunEnded{at} => AgentLifecycleNote::RunEnded{at:*at},
  })).collect());`,
    "note-retention-1",
    "note-retention-2",
  ),
  c(
    "restart-retains-usage",
    "next.usage = AgentField::Value(Some(shared_no_usage()));",
    "next.usage = s.usage.clone();",
    "three-stage-audit",
  ),
  c(
    "restart-resets-brain-ledger",
    "next.output = AgentField::Value(None);",
    "next.output = AgentField::Value(None); next.resilience=self.config.llm.init();",
    "three-stage-audit",
  ),
  c(
    "payload-reads-configured-instructions",
    `let instructions = match &state.instructions {
            AgentField::Value(Some(value)) => Some(value),
            _ => None,
        };`,
    "let instructions = self.config.instructions.as_ref();",
    "legacy-null",
  ),
  c(
    "skip-dedupe-first-call-id",
    "let batch = dedupe_by_call_id(&fields.tool_calls);",
    "let batch = fields.tool_calls.clone();",
    "three-stage-audit",
  ),
  c(
    "coerce-retained-null-turn",
    "turn: conv.turn_count,",
    "turn: conv.turn_count.number_or_zero().into(),",
    "restored-null-numbers",
  ),
  c(
    "skip-drained-tool-turn-increment",
    "conversation.turn_count = (conversation.turn_count.number_or_zero() + 1.0).into();",
    "conversation.turn_count = conversation.turn_count;",
    'guard-{"maxTurns":1}',
  ),
  c(
    "run-guards-on-empty-turns",
    `if fields.tool_calls.is_empty() {
            counted.conversation = Some(Rc::new(measured));`,
    `if fields.tool_calls.is_empty() {
            counted.conversation = Some(Rc::new(measured));
            if let Some(stopped)=self.stop_conditions(&Rc::new(counted.clone()),at){return Ok(stopped);}`,
    "empty-turns-3",
  ),
  c(
    "elapsed-reason-overrides-turn-limit",
    "Some(AgentFailure::TurnLimit { at: at.into() })",
    "Some(AgentFailure::ElapsedLimit { at: at.into() })",
    'guard-{"maxTurns":1,"maxElapsedMs":1,"stopAfter":0}',
  ),
  c(
    "boot-resets-original-start-time",
    "resumed.run = self.run.boot(&s.run, at).state;",
    "resumed.run = self.run.boot(&s.run, at).state; let mut changed=resumed.run.as_ref().clone(); changed.core.started_at=at.into(); resumed.run=Rc::new(changed);",
    "three-stage-audit",
  ),
  c(
    "boot-reissues-after-cancel",
    "if resumed.is_settled() {",
    "if false {",
    "cancel-late-succeed",
  ),
  c(
    "blanket-terminal-transition-gate",
    "self.supported(s)?;\n        let current",
    "if s.is_settled(){return Ok(Step::new(Rc::clone(s),vec![]));} self.supported(s)?;\n        let current",
    "cancel-late-fail",
    "restart-failed",
  ),
  c(
    "success-retains-prior-brain-state",
    "next.resilience = retry.state;\n            let mut step = self.turn_body",
    "next.resilience = s.resilience.clone();\n            let mut step = self.turn_body",
    "three-stage-audit",
  ),
  c(
    "terminal-failure-drops-full-error",
    "error: AgentField::Value(Rc::new(error)),",
    "error: AgentField::Undefined,",
    "retry-0",
  ),
  c(
    "terminal-filter-drops-retry-sub",
    "let mut list = self.config.llm.deadlines(&s.resilience);",
    "if s.is_settled(){return Ok(vec![]);} let mut list = self.config.llm.deadlines(&s.resilience);",
    "cancel-late-retry",
  ),
  c(
    "terminal-filter-drops-retry-timer",
    "self.transition(s, msg.at_ms, |s| {",
    "self.transition(s, msg.at_ms, |s| { if s.is_settled(){return Ok(Step::new(Rc::clone(s),vec![]));}",
    "cancel-late-retry",
  ),
  c(
    "unknown-tool-id-folds-first-call",
    ".find(|c| c.call_id == *id)",
    ".find(|_| true)",
    "fanout-1",
  ),
  c(
    "final-output-is-lost",
    "next.output = AgentField::Value(Some(terminating));",
    "next.output = AgentField::Value(None);",
    "three-stage-audit",
  ),
  c(
    "next-stage-retains-prior-conversation",
    `next.conversation = Some(Rc::new(Conversation::fresh()));
        next.tools = self.fan.init();`,
    `next.conversation = s.conversation.as_ref().map(Rc::clone);
        next.tools = self.fan.init();`,
    "three-stage-audit",
  ),
];
controls.push({
  name: "scatter-skips-second-tool-of",
  edits: [
    ["drop(scattered.commands);", "let scatter_commands=scattered.commands;"],
    [
      `let commands = scattered
            .state
            .running
            .iter()
            .map(|call| AgentCommand::Tool((self.config.tool_of)(call)))
            .collect();`,
      "let commands = scatter_commands.into_iter().map(AgentCommand::Tool).collect();",
    ],
  ],
  ids: ["agent-base.three-stage-audit"],
});
controls.push({
  name: "backfill-skips-second-tool-of",
  edits: [
    ["drop(settled.commands);", "let settled_commands=settled.commands;"],
    [
      `let launch_commands = launched
            .iter()
            .map(|call| AgentCommand::Tool((self.config.tool_of)(call)))
            .collect::<Vec<_>>();`,
      "let launch_commands = settled_commands.into_iter().map(AgentCommand::Tool).collect::<Vec<_>>();",
    ],
  ],
  ids: ["agent-base.fanout-1"],
});

export function agentBaseMutations(options = {}) {
  const baselineTarget =
      process.env.CARGO_TARGET_DIR ?? path.join(root, "target"),
    mutationTarget =
      options.mutationTarget ??
      path.join(root, "target/parity/agent-base-mutation-build"),
    binary = options.binary;
  assert.ok(binary, "An explicit compiled baseline binary is required");
  assert.ok(
    options.libraries?.length,
    "Actual Cargo JSON library artifacts are required",
  );
  assert.notEqual(path.resolve(baselineTarget), path.resolve(mutationTarget));
  const sources = [
      knob,
      "crates/tea/src/agent/types.rs",
      "crates/tea/src/agent/knob/command.rs",
      "crates/tea/src/agent/knob/error.rs",
      "crates/tea/examples/agent_base_driver.rs",
      "packages/tea/src/agent/index.ts",
      "packages/tea/src/agent/internal.ts",
      "packages/tea/src/agent/types.ts",
      "packages/tea/src/agent/machine.ts",
    ],
    sourceHashes = Object.fromEntries(
      sources.map((f) => [f, hash(fs.readFileSync(path.join(root, f)))]),
    ),
    artifacts = [binary, ...options.libraries],
    artifactHashes = Object.fromEntries(
      artifacts.map((f) => [f, hash(fs.readFileSync(f))]),
    );
  const baseline = agentBaseParity({
    binary,
    quiet: true,
    reportFile: path.join(
      root,
      "target/parity/agent-base-mutation-baseline.json",
    ),
  });
  assert.equal(baseline.cases, 44);
  assert.equal(baseline.passed, 44);
  assert.equal(baseline.protocolRefusals, 8);
  assert.equal(baseline.qualifiedObservations.length, 1);
  const directory = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "demlik-agent-base-faults-")),
    ),
    workspace = path.join(directory, "workspace"),
    detected = [];
  fs.mkdirSync(workspace);
  const original = fs.readFileSync(path.join(root, knob), "utf8"),
    env = {
      ...process.env,
      CARGO_TARGET_DIR: mutationTarget,
      CARGO_PROFILE_DEV_DEBUG: "0",
      CARGO_PROFILE_TEST_DEBUG: "0",
      CARGO_INCREMENTAL: "0",
      CARGO_BUILD_JOBS: "1",
    };
  try {
    for (const entry of ["Cargo.toml", "Cargo.lock", "crates"])
      fs.cpSync(path.join(root, entry), path.join(workspace, entry), {
        recursive: true,
      });
    for (const item of controls.filter(
      (x) => !options.only || options.only.includes(x.name),
    )) {
      let mutant = original;
      for (const [before, after] of item.edits) {
        assert.equal(
          mutant.split(before).length,
          2,
          `${item.name}: unique site`,
        );
        mutant = mutant.replace(before, after);
      }
      fs.writeFileSync(path.join(workspace, knob), mutant);
      const args = [
          "build",
          "--locked",
          "--offline",
          "-p",
          "demlik-tea",
          "--example",
          "agent_base_driver",
        ],
        log = path.join(
          root,
          `target/agent-base-mutant-${item.name}-compile.log`,
        );
      const compiled = spawnSync(process.env.CARGO ?? "cargo", args, {
        cwd: workspace,
        env,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      });
      fs.writeFileSync(log, (compiled.stdout ?? "") + (compiled.stderr ?? ""));
      if (compiled.error) throw compiled.error;
      assert.equal(
        compiled.status,
        0,
        `${item.name}: compilation failed; ${log}`,
      );
      const reportFile = path.join(
          root,
          `target/parity/agent-base-mutants/${item.name}.json`,
        ),
        r = agentBaseParity({
          binary: path.join(mutationTarget, "debug/examples/agent_base_driver"),
          caseIds: item.ids,
          allowFailures: true,
          quiet: true,
          reportFile,
        }),
        failures = r.failures.map((x) => x.id);
      assert.ok(
        item.ids.some((id) => failures.includes(id)),
        `${item.name}: no declared semantic witness`,
      );
      for (const id of failures)
        assert.ok(!Object.hasOwn(r.nativeEvidence, id));
      detected.push({
        name: item.name,
        compiled: true,
        detected: true,
        expected: item.ids,
        failures,
        reportFile,
        originalSha256: hash(original),
        mutantSha256: hash(mutant),
        binarySha256: r.binarySha256,
      });
      fs.writeFileSync(
        path.join(root, "target/parity/agent-base-mutations-progress.json"),
        `${JSON.stringify(detected, null, 2)}\n`,
      );
      console.log(JSON.stringify({ detected: item.name }));
    }
    for (const [f, s] of Object.entries(sourceHashes))
      assert.equal(hash(fs.readFileSync(path.join(root, f))), s, f);
    for (const [f, s] of Object.entries(artifactHashes))
      assert.equal(hash(fs.readFileSync(f)), s, f);
    const report = {
        baseline: {
          strict: 44,
          actions: 271,
          protocolRefusals: 8,
          qualifiedExcluded: 1,
        },
        detected: detected.length,
        escaped: 0,
        controls: detected,
        activeSourceUnchanged: true,
        baselineArtifactsUnchanged: true,
        sourceHashes,
        artifactHashes,
        targets: {
          baselineTarget,
          mutationTarget,
          debug: 0,
          incremental: false,
          jobs: 1,
        },
      },
      out =
        options.reportFile ??
        path.join(root, "target/parity/agent-base-mutations.json");
    fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
    console.log(
      JSON.stringify({ detected: detected.length, escaped: 0, report: out }),
    );
    return report;
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const { agentBaseCheckpointParity } = await import(
    "./agent-state-parity.mjs"
  );
  const baseline = await agentBaseCheckpointParity(
    process.env.CARGO ?? "cargo",
  );
  agentBaseMutations({
    binary: baseline.binary,
    libraries: Object.values(baseline.cargoArtifacts.libraries).map(
      (a) => a.path,
    ),
  });
}
