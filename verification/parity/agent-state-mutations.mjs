import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { fanoutRestoreParity } from "./agent-state-fanout-restore.mts";
import { stateParity } from "./agent-state-run.mts";
import {
  createCheckWorktree,
  checkedExecFileSync as execFileSync,
} from "./check-worktree.mjs";
import { verifyFlow } from "./flow.mts";

const root = fileURLToPath(new URL("../..", import.meta.url)),
  hash = (v) => createHash("sha256").update(v).digest("hex"),
  state = "crates/tea/src/agent/state.rs",
  types = "crates/tea/src/agent/types.rs",
  fanout = "crates/tea/src/flow/fan_out.rs";
const c = (name, file, before, after, id, mode = "state") => ({
  name,
  file,
  before,
  after,
  ids: [id],
  mode,
});
const controls = [
  c(
    "null-usage-is-treated-as-absent",
    state,
    "let defined = matches!(self.usage, AgentField::Value(_));",
    "let defined = matches!(self.usage, AgentField::Value(Some(_)));",
    "agent-state.usage-null-none-absent",
  ),
  c(
    "legacy-null-is-treated-as-undefined",
    state,
    "!matches!(conv.legacy_usage, AgentField::Value(_))",
    "!matches!(conv.legacy_usage, AgentField::Value(Some(_)))",
    "agent-state.usage-current-null-null",
  ),
  c(
    "defined-null-context-is-reinitialized",
    state,
    "matches!(conv.context_tokens, AgentField::Value(_))",
    "matches!(conv.context_tokens, AgentField::Value(n) if n.number().is_some())",
    "agent-state.usage-current-null-absent",
  ),
  c(
    "noop-remints-state-owner",
    state,
    "return Rc::clone(self);",
    "return Rc::new(self.as_ref().clone());",
    "agent-state.usage-current-null-absent",
  ),
  c(
    "migration-keeps-legacy-copy",
    state,
    "next.legacy_usage = AgentField::Absent;",
    "next.legacy_usage = conv.legacy_usage.clone();",
    "agent-state.usage-current-null-null",
  ),
  c(
    "migration-invents-zero-context",
    state,
    "next.context_tokens = AgentField::Value(AgentNumber(None));",
    "next.context_tokens = AgentField::Value(0.0.into());",
    "agent-state.usage-absent-undefined-value",
  ),
  c(
    "defaults-are-gated-by-terminal-state",
    state,
    "let defined = matches!(self.usage, AgentField::Value(_));",
    "if self.is_settled(){return Rc::clone(self);} let defined = matches!(self.usage, AgentField::Value(_));",
    "agent-state.cold-absent-absent",
  ),
  c(
    "current-stage-is-gated-by-terminal-state",
    state,
    "pub fn current_stage(&self) -> Option<Rc<S>> {",
    "pub fn current_stage(&self) -> Option<Rc<S>> {if self.is_settled(){return None;}",
    "agent-state.stage-cancelled-two",
  ),
  c(
    "current-stage-picks-last-running",
    state,
    ".find(|item| item.status == QueueItemStatus::Running)",
    ".filter(|item| item.status == QueueItemStatus::Running).last()",
    "agent-state.stage-running-undefined-first",
  ),
  c(
    "missing-failure-is-normalized-to-null",
    state,
    "!matches!(self.failure, AgentField::Value(None))",
    "matches!(self.failure, AgentField::Value(Some(_)))",
    "agent-state.inspect-running-undefined-llm",
  ),
  c(
    "cancelled-is-not-terminal",
    state,
    "RunPhase::Done { .. } | RunPhase::Failed { .. } | RunPhase::Cancelled { .. }",
    "RunPhase::Done { .. } | RunPhase::Failed { .. }",
    "agent-state.inspect-cancelled-null-tools",
  ),
  c(
    "idle-is-terminal",
    state,
    "RunPhase::Done { .. } | RunPhase::Failed { .. } | RunPhase::Cancelled { .. }",
    "RunPhase::Idle | RunPhase::Done { .. } | RunPhase::Failed { .. } | RunPhase::Cancelled { .. }",
    "agent-state.inspect-idle-null-tools",
  ),
  c(
    "stale-is-terminal",
    state,
    "RunPhase::Done { .. } | RunPhase::Failed { .. } | RunPhase::Cancelled { .. }",
    "RunPhase::Stale { .. } | RunPhase::Done { .. } | RunPhase::Failed { .. } | RunPhase::Cancelled { .. }",
    "agent-state.inspect-stale-null-llm",
  ),
  c(
    "awaiting-kind-is-ignored",
    state,
    "conversation.awaiting.kind() == kind",
    "true",
    "agent-state.inspect-running-null-tools",
  ),
  c(
    "copied-state-remints-run-owner",
    types,
    "run: Rc::clone(&self.run),",
    "run: Rc::new(self.run.as_ref().clone()),",
    "agent-state.usage-absent-undefined-value",
  ),
  c(
    "copied-state-remints-tools-owner",
    types,
    "tools: Rc::clone(&self.tools),",
    "tools: Rc::new(self.tools.as_ref().clone()),",
    "agent-state.usage-absent-undefined-value",
  ),
  c(
    "fanout-missing-value-becomes-null",
    fanout,
    "crate::data::decode_missing(name).map(Rc::new)",
    'serde_json::from_str("null").map(Rc::new).map_err(E::custom)',
    "agent-state-fanout.done-undefined",
    "fanout",
  ),
  c(
    "fanout-restore-drops-pending-entry",
    fanout,
    "    pub pending: Vec<Rc<I>>,",
    '    #[serde(deserialize_with="_mutant_pending")]\n    pub pending: Vec<Rc<I>>,',
    "agent-state-fanout.duplicates-order",
    "fanout",
  ),
  c(
    "fanout-restore-reinitializes-joined",
    fanout,
    "    pub joined: bool,",
    '    #[serde(deserialize_with="_mutant_joined")]\n    pub joined: bool,',
    "agent-state-fanout.joined-empty",
    "fanout",
  ),
  c(
    "fanout-cumulative-wave-regression",
    fanout,
    "next.wave_done_from = state.done.len() as f64;",
    "next.wave_done_from = 0.0;",
    "flow.fan-out.duplicate-waves",
    "flow",
  ),
];
controls.find((x) => x.name === "fanout-restore-drops-pending-entry").append =
  "\nfn _mutant_pending<'de,D:serde::Deserializer<'de>,I:serde::Deserialize<'de>>(d:D)->Result<Vec<Rc<I>>,D::Error>{let mut v=Vec::<Rc<I>>::deserialize(d)?;if !v.is_empty(){v.remove(0);}Ok(v)}\n";
controls.find((x) => x.name === "fanout-restore-reinitializes-joined").append =
  "\nfn _mutant_joined<'de,D:serde::Deserializer<'de>>(d:D)->Result<bool,D::Error>{let _=bool::deserialize(d)?;Ok(false)}\n";
export async function stateMutations(options = {}) {
  const mutationCheck = createCheckWorktree(
    process.cwd(),
    "agent-state-mutations",
  );
  let mutationFailure;
  try {
    const target = mutationCheck.target,
      baselineTarget =
        process.env.CARGO_TARGET_DIR ?? path.join(root, "target");
    assert.notEqual(path.resolve(target), path.resolve(baselineTarget));
    const binaries = {
        state: path.join(baselineTarget, "debug/examples/agent_state_driver"),
        fanout: path.join(
          baselineTarget,
          "debug/examples/agent_fanout_restore_driver",
        ),
        flow: path.join(baselineTarget, "debug/flow_driver"),
      },
      hashes = Object.fromEntries(
        Object.entries(binaries).map(([k, v]) => [k, hash(fs.readFileSync(v))]),
      ),
      originals = new Map(
        [state, types, fanout].map((f) => [
          f,
          fs.readFileSync(path.join(root, f), "utf8"),
        ]),
      );
    const directory = mutationCheck.root,
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
      const baseline = await stateParity({
        binary: binaries.state,
        quiet: true,
        reportFile: path.join(
          root,
          "target/parity/agent-state-mutation-baseline.json",
        ),
      });
      assert.equal(baseline.cases, 205);
      assert.equal(baseline.passed, 205);
      const restore = fanoutRestoreParity({
        binary: binaries.fanout,
        reportFile: path.join(
          root,
          "target/parity/agent-state-fanout-mutation-baseline.json",
        ),
      });
      assert.equal(restore.passed, 8);
      const flow = verifyFlow(
        path.join(
          root,
          "target/parity/agent-state-flow-mutation-baseline.json",
        ),
        binaries.flow,
        false,
      );
      assert.equal(flow.passed, 48);

      for (const item of controls.filter(
        (x) => !options.only || options.only.includes(x.name),
      )) {
        for (const [f, s] of originals)
          fs.writeFileSync(path.join(workspace, f), s);
        const original = originals.get(item.file);
        assert.equal(
          original.split(item.before).length,
          2,
          `${item.name} unique site`,
        );
        const mutant =
          original.replace(item.before, item.after) + (item.append ?? "");
        fs.writeFileSync(path.join(workspace, item.file), mutant);
        const args = [
          "build",
          "--locked",
          "--offline",
          "-p",
          item.mode === "flow" ? "demlik-parity" : "demlik-tea",
          ...(item.mode === "flow"
            ? ["--bin", "flow_driver"]
            : [
                "--example",
                item.mode === "fanout"
                  ? "agent_fanout_restore_driver"
                  : "agent_state_driver",
              ]),
        ];
        try {
          execFileSync(process.env.CARGO ?? "cargo", args, {
            cwd: workspace,
            env,
            stdio: "pipe",
            maxBuffer: 16 * 1024 * 1024,
          });
        } catch (error) {
          fs.writeFileSync(
            path.join(
              root,
              `target/agent-state-mutant-${item.name}-compile.log`,
            ),
            String(error.stderr),
          );
          throw error;
        }
        const output = path.join(
          root,
          `target/parity/agent-state-mutants/${item.name}.json`,
        );
        fs.mkdirSync(path.dirname(output), { recursive: true });
        let failures;
        if (item.mode === "state") {
          const r = await stateParity({
            binary: path.join(target, "debug/examples/agent_state_driver"),
            caseIds: item.ids,
            allowFailures: true,
            quiet: true,
            reportFile: output,
          });
          failures = r.failures.map((x) => x.id);
          for (const id of failures)
            assert.ok(!Object.hasOwn(r.nativeEvidence, id));
        } else if (item.mode === "fanout") {
          const r = fanoutRestoreParity({
            binary: path.join(
              target,
              "debug/examples/agent_fanout_restore_driver",
            ),
            caseIds: item.ids,
            allowFailures: true,
            reportFile: output,
          });
          failures = r.failures.map((x) => x.id);
          for (const id of failures)
            assert.ok(!Object.hasOwn(r.nativeEvidence, id));
        } else {
          const r = verifyFlow(
            output,
            path.join(target, "debug/flow_driver"),
            false,
          );
          failures = r.failures.map((x) => x.id);
        }
        assert.ok(
          item.ids.some((id) => failures.includes(id)),
          `${item.name} lacked declared witness`,
        );
        detected.push({
          name: item.name,
          file: item.file,
          compiled: true,
          detected: true,
          expected: item.ids,
          failures,
          originalSha256: hash(original),
          mutantSha256: hash(mutant),
        });
        console.log(JSON.stringify({ detected: item.name }));
      }
      for (const [f, s] of originals)
        assert.equal(fs.readFileSync(path.join(root, f), "utf8"), s);
      for (const [k, v] of Object.entries(binaries))
        assert.equal(hash(fs.readFileSync(v)), hashes[k]);
      const report = {
        baseline: { state: 205, restore: 8, flow: 48 },
        detected: detected.length,
        escaped: 0,
        controls: detected,
        activeSourceUnchanged: true,
        baselineArtifactsUnchanged: true,
        baselineArtifactsSha256: hashes,
        targets: {
          baselineTarget,
          mutationTarget: target,
          debug: 0,
          incremental: false,
          jobs: 1,
        },
      };
      const file =
        options.reportFile ??
        path.join(root, "target/parity/agent-state-mutations.json");
      fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
      console.log(
        JSON.stringify({
          detected: detected.length,
          escaped: 0,
          reportFile: file,
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
  await stateMutations();
