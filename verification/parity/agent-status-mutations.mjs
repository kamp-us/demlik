import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { agentStatusParity } from "./agent-status-run.mjs";
import {
  createCheckWorktree,
  checkedSpawnSync as spawnSync,
} from "./check-worktree.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url)),
  hash = (v) => createHash("sha256").update(v).digest("hex"),
  projection = "crates/tea/src/agent/status.rs",
  types = "crates/tea/src/agent/types.rs";
const c = (name, before, after, id, file = projection) => ({
  name,
  file,
  before,
  after,
  ids: [`agent-status.${id}`],
});
const controls = [
  c(
    "missing-annotation-becomes-null",
    "AgentField::Absent | AgentField::Undefined => Some(AgentField::Undefined),",
    "AgentField::Absent | AgentField::Undefined => None,",
    "precedence-done-absent",
  ),
  c(
    "cancelled-preempts-annotation",
    "let annotation = match &state.failure {",
    "if let RunPhase::Cancelled{at,..}=&state.run.phase{return AgentStatus::Ended(AgentEndedStatus::Cancelled{at:*at});} let annotation = match &state.failure {",
    "original-agent-failure",
  ),
  c(
    "remint-original-agent-failure",
    "AgentTerminalFailure::Agent(Rc::clone(failure)),",
    `AgentTerminalFailure::Agent(Rc::new(match failure.as_ref(){
  super::types::AgentFailure::TurnLimit{at}=>super::types::AgentFailure::TurnLimit{at:*at},
  super::types::AgentFailure::ElapsedLimit{at}=>super::types::AgentFailure::ElapsedLimit{at:*at},
  super::types::AgentFailure::Llm{error,at}=>super::types::AgentFailure::Llm{error:error.clone(),at:*at},
 })),`,
    "original-agent-failure",
  ),
  c(
    "remint-original-run-failure",
    "AgentTerminalFailure::Run(Rc::clone(failure))",
    `AgentTerminalFailure::Run(Rc::new(match failure.as_ref(){
 crate::flow::monitored_run::RunFailure::Deadline{at}=>crate::flow::monitored_run::RunFailure::Deadline{at:*at},
 crate::flow::monitored_run::RunFailure::Stage{stage,error}=>crate::flow::monitored_run::RunFailure::Stage{stage:stage.clone(),error:error.clone()},
 }))`,
    "original-run-stage-failure",
  ),
  c(
    "undefined-output-becomes-null",
    "AgentField::Absent | AgentField::Undefined => AgentField::Undefined,",
    "AgentField::Absent | AgentField::Undefined => AgentField::Value(None),",
    "done-absent-object",
  ),
  c(
    "undefined-output-copies-absence",
    "AgentField::Absent | AgentField::Undefined => AgentField::Undefined,",
    "AgentField::Absent | AgentField::Undefined => AgentField::Absent,",
    "done-absent-object",
  ),
  c(
    "terminal-output-is-dropped",
    "AgentField::Value(value) => AgentField::Value(value.clone()),",
    "AgentField::Value(_) => AgentField::Value(None),",
    "done-object-object",
  ),
  c(
    "fallback-zero-owner-is-reminted",
    "_ => shared_no_usage(),",
    "_ => Rc::new(super::types::TurnUsage::new(0.0,0.0)),",
    "done-null-absent",
  ),
  c(
    "fallback-lifts-legacy-total",
    "_ => shared_no_usage(),",
    "_ => state.conversation.as_ref().and_then(|c|c.legacy_usage.value().and_then(Option::as_ref)).cloned().unwrap_or_else(shared_no_usage),",
    "done-null-absent",
  ),
  c(
    "usage-value-is-discarded",
    "AgentField::Value(Some(usage)) => Rc::clone(usage),",
    "AgentField::Value(Some(_)) => shared_no_usage(),",
    "done-null-object",
  ),
  c(
    "pending-is-queued-array",
    "pending: &state.tools.running,",
    "pending: &state.tools.pending,",
    "suspended-empty-running",
  ),
  c(
    "empty-running-is-not-suspended",
    "matches!(conversation.awaiting, Awaiting::Tools { .. })",
    "matches!(conversation.awaiting, Awaiting::Tools { .. }) && !state.tools.running.is_empty()",
    "suspended-empty-running",
  ),
  c(
    "stale-is-idle",
    "RunPhase::Running { .. } | RunPhase::Stale { .. } => {",
    "RunPhase::Stale { .. } => AgentStatus::Idle, RunPhase::Running { .. } => {",
    "live-stale-llm",
  ),
  c(
    "compacting-is-suspended",
    "matches!(conversation.awaiting, Awaiting::Tools { .. })",
    "matches!(conversation.awaiting, Awaiting::Tools { .. }|Awaiting::Compacting{..})",
    "live-running-compacting",
  ),
  c(
    "all-conversations-are-suspended",
    "matches!(conversation.awaiting, Awaiting::Tools { .. })",
    "true",
    "live-running-llm",
  ),
  c(
    "null-cancel-time-is-coerced",
    "AgentEndedStatus::Cancelled { at: *at }",
    "AgentEndedStatus::Cancelled { at: at.number().unwrap_or(0.0).into() }",
    "cancel-null-cold",
  ),
  c(
    "undefined-failure-wire-is-null",
    `match failure {
                        AgentField::Value(value) => field::<S, _>(value)?,
                        AgentField::Absent | AgentField::Undefined => PlainData::Undefined,
                    }`,
    `match failure {
                        AgentField::Value(value) => field::<S, _>(value)?,
                        AgentField::Absent | AgentField::Undefined => PlainData::Null,
                    }`,
    "precedence-done-undefined",
    types,
  ),
  c(
    "cancel-wire-null-is-zero",
    '("at", field::<S, _>(at)?),',
    '("at", PlainData::Number(at.number().unwrap_or(0.0))),',
    "cancel-null-pure",
    types,
  ),
];
export function agentStatusMutations(options = {}) {
  const mutationCheck = createCheckWorktree(
    process.cwd(),
    "agent-status-mutations",
  );
  let mutationFailure;
  try {
    const baselineTarget =
        process.env.CARGO_TARGET_DIR ?? path.join(root, "target"),
      mutationTarget = mutationCheck.target,
      binary = options.binary;
    assert.ok(binary, "An explicit compiled baseline binary is required");
    assert.ok(
      options.libraries?.length,
      "Actual Cargo JSON library artifacts are required",
    );
    assert.notEqual(path.resolve(baselineTarget), path.resolve(mutationTarget));
    const artifacts = [binary, ...options.libraries],
      artifactHashes = Object.fromEntries(
        artifacts.map((f) => [f, hash(fs.readFileSync(f))]),
      ),
      files = [
        projection,
        types,
        "crates/tea/examples/agent_status_driver.rs",
        "packages/tea/src/agent/types.ts",
        "packages/tea/src/agent/internal.ts",
      ],
      sourceHashes = Object.fromEntries(
        files.map((f) => [f, hash(fs.readFileSync(path.join(root, f)))]),
      );
    const baseline = agentStatusParity({
      binary,
      quiet: true,
      reportFile: path.join(
        root,
        "target/parity/agent-status-mutation-baseline.json",
      ),
    });
    assert.equal(baseline.cases, 64);
    assert.equal(baseline.passed, 64);
    assert.equal(baseline.qualifiedObservations.length, 3);
    assert.equal(baseline.protocolRefusals, 3);
    const directory = mutationCheck.root,
      workspace = mutationCheck.root,
      originals = new Map(
        [projection, types].map((f) => [
          f,
          fs.readFileSync(path.join(root, f), "utf8"),
        ]),
      ),
      detected = [];

    const env = {
      ...process.env,
      CARGO_NET_OFFLINE: "true",
      CARGO_PROFILE_DEV_DEBUG: "0",
      CARGO_PROFILE_TEST_DEBUG: "0",
      CARGO_INCREMENTAL: "0",
      CARGO_BUILD_JOBS: "1",
    };
    try {
      for (const item of controls.filter(
        (x) => !options.only || options.only.includes(x.name),
      )) {
        for (const [f, s] of originals)
          fs.writeFileSync(path.join(workspace, f), s);
        const original = originals.get(item.file);
        assert.equal(
          original.split(item.before).length,
          2,
          `${item.name}: unique site`,
        );
        const mutant = original.replace(item.before, item.after);
        fs.writeFileSync(path.join(workspace, item.file), mutant);
        const args = [
            "build",
            "--locked",
            "--offline",
            "-p",
            "demlik-tea",
            "--example",
            "agent_status_driver",
            "--message-format=json",
          ],
          r = spawnSync(process.env.CARGO ?? "cargo", args, {
            cwd: workspace,
            env,
            encoding: "utf8",
            maxBuffer: 16 * 1024 * 1024,
          }),
          log = path.join(
            root,
            `target/agent-status-mutant-${item.name}-compile.log`,
          ),
          cargoJson = path.join(
            root,
            `target/agent-status-mutant-${item.name}-cargo.jsonl`,
          );
        fs.writeFileSync(log, r.stderr ?? "");
        fs.writeFileSync(cargoJson, r.stdout ?? "");
        if (r.error) throw r.error;
        assert.equal(r.status, 0, `${item.name}: did not compile; ${log}`);
        const messages = r.stdout
            .trim()
            .split("\n")
            .map((l) => JSON.parse(l)),
          actual = messages.findLast(
            (m) =>
              m.reason === "compiler-artifact" &&
              m.target.name === "agent_status_driver" &&
              m.executable,
          );
        assert.ok(actual);
        const reportFile = path.join(
            root,
            `target/parity/agent-status-mutants/${item.name}.json`,
          ),
          report = agentStatusParity({
            binary: actual.executable,
            caseIds: item.ids,
            allowFailures: true,
            quiet: true,
            reportFile,
          }),
          failures = report.failures.map((f) => f.id);
        assert.ok(
          item.ids.some((id) => failures.includes(id)),
          `${item.name}: no declared semantic witness`,
        );
        for (const id of failures)
          assert.ok(!Object.hasOwn(report.nativeEvidence, id));
        detected.push({
          name: item.name,
          file: item.file,
          compiled: true,
          detected: true,
          expected: item.ids,
          failures,
          originalSha256: hash(original),
          mutantSha256: hash(mutant),
          binarySha256: report.binarySha256,
          cargoJsonSha256: hash(fs.readFileSync(cargoJson)),
          reportFile,
        });
        fs.writeFileSync(
          path.join(root, "target/parity/agent-status-mutations-progress.json"),
          `${JSON.stringify(detected, null, 2)}\n`,
        );
        console.log(JSON.stringify({ detected: item.name }));
      }
      for (const [f, h] of Object.entries(sourceHashes))
        assert.equal(hash(fs.readFileSync(path.join(root, f))), h, f);
      for (const [f, h] of Object.entries(artifactHashes))
        assert.equal(hash(fs.readFileSync(f)), h, f);
      const report = {
          baseline: { strict: 64, qualifiedExcluded: 3, protocolRefusals: 3 },
          detected: detected.length,
          escaped: 0,
          controls: detected,
          sourceHashes,
          artifactHashes,
          activeSourceUnchanged: true,
          baselineArtifactsUnchanged: true,
          targets: {
            baselineTarget,
            mutationTarget,
            debug: 0,
            incremental: false,
            jobs: 1,
            cargoHome: env.CARGO_HOME,
          },
        },
        out =
          options.reportFile ??
          path.join(root, "target/parity/agent-status-mutations.json");
      fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
      console.log(
        JSON.stringify({ detected: detected.length, escaped: 0, report: out }),
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
) {
  const { agentStatusCheckpointParity } = await import(
    "./agent-state-parity.mjs"
  );
  const baseline = await agentStatusCheckpointParity(
    process.env.CARGO ?? "cargo",
  );
  agentStatusMutations({
    binary: baseline.binary,
    libraries: Object.values(baseline.cargoArtifacts.libraries).map(
      (a) => a.path,
    ),
  });
}
