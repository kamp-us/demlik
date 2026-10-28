import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  assertCheckPath,
  cargoCheckEnvironment,
  compiledCheckLibrary,
  createCheckWorktree,
} from "./check-worktree.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const sha = (value) => createHash("sha256").update(value).digest("hex");
const owner = "crates/tea/src/agent/knob/runtime.rs";
export const routedFaults = [
  {
    name: "routed-next-brain-dropped",
    before:
      "                .map_err(AgentMachineError::Agent)\n            },\n        )\n    }\n}\n\nstruct NoCompactInterpreter",
    after:
      "                .map(|mut step| {step.commands.clear();step})\n                .map_err(AgentMachineError::Agent)\n            },\n        )\n    }\n}\n\nstruct NoCompactInterpreter",
    example: "agent_routed_driver",
    kind: "strict-shared",
    contract:
      "A settled tool emits the next brain command through the existing Agent transition.",
  },
  {
    name: "routed-original-time-lost",
    before:
      "                let time = at\n                    .and_then(NumberOrNull::number)\n                    .ok_or(AgentMachineError::UnsupportedStamp { at })?;",
    after:
      "                let time = at\n                    .and_then(NumberOrNull::number)\n                    .ok_or(AgentMachineError::UnsupportedStamp { at })? + 1.0;",
    example: "agent_routed_driver",
    kind: "strict-shared",
    contract:
      "The reader forwards original Settled.at into state progress and the next brain budget.",
  },
  {
    name: "routed-reader-refusal-swallowed",
    before: "                    .map_err(AgentMachineError::ToolContract)?",
    after: "                    .unwrap_or(None)",
    example: "agent_routed_public",
    kind: "native-only",
    contract:
      "A late caller-owned failure projection refusal returns the original typed contract failure, never an empty successful Step.",
  },
];
export async function runRoutedControls({
  output,
  sourceReport,
  baselineReport,
  cargo = process.env.CARGO ?? "cargo",
}) {
  const evidence = path.resolve(output);
  fs.mkdirSync(evidence, { recursive: true });
  assert.equal(
    execFileSync("git", ["status", "--porcelain"], {
      cwd: root,
      encoding: "utf8",
    }),
    "",
  );
  const baseline = JSON.parse(fs.readFileSync(baselineReport));
  assert.equal(baseline.cases, 20);
  assert.equal(baseline.passed, 16);
  assert.equal(baseline.qualifiedPassed, 4);
  assert.deepEqual(baseline.failures, []);
  assert.equal(
    baseline.observations.find((r) => r.id === "agent-routed.promise.invoice")
      .equal,
    true,
  );
  const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  const check = createCheckWorktree(root, "agent-routed-controls", evidence);
  const results = [];
  let active = null;
  const save = () =>
    fs.writeFileSync(
      path.join(evidence, "controls.json"),
      `${JSON.stringify({ sourceCommit, results, active, complete: results.length === routedFaults.length }, null, 2)}\n`,
    );
  try {
    for (const dir of [
      "node_modules",
      "packages/tea/node_modules",
      "verification/parity/node_modules",
    ]) {
      const from = path.join(root, dir),
        to = path.join(check.root, dir);
      if (fs.existsSync(from) && !fs.existsSync(to))
        fs.symlinkSync(fs.realpathSync(from), to, "dir");
    }
    const { agentRoutedParity } = await import(
      pathToFileURL(
        path.join(check.root, "verification/parity/agent-routed-run.mjs"),
      ).href
    );
    for (const fault of routedFaults) {
      const directory = path.join(evidence, fault.name);
      fs.mkdirSync(directory, { recursive: true });
      const file = path.join(check.root, owner),
        original = fs.readFileSync(file, "utf8");
      assert.equal(
        original.split(fault.before).length - 1,
        1,
        "one earned mutation site",
      );
      active = {
        name: fault.name,
        kind: fault.kind,
        contract: fault.contract,
        baselineSHA256: sha(original),
        status: "prepared",
      };
      save();
      try {
        const modified = original.replace(fault.before, fault.after);
        fs.writeFileSync(file, modified);
        fs.writeFileSync(path.join(directory, "original.rs"), original);
        fs.writeFileSync(path.join(directory, "modified.rs"), modified);
        active.modifiedSHA256 = sha(modified);
        save();
        const args = [
          "build",
          "--locked",
          "--offline",
          "-p",
          "demlik-tea",
          "--lib",
          "--example",
          fault.example,
          "--message-format=json",
        ];
        const built = spawnSync(cargo, args, {
          cwd: check.root,
          env: cargoCheckEnvironment({
            CARGO_NET_OFFLINE: "true",
            CARGO_PROFILE_DEV_DEBUG: "0",
            CARGO_PROFILE_TEST_DEBUG: "0",
            CARGO_INCREMENTAL: "0",
            CARGO_BUILD_JOBS: "1",
          }),
          encoding: "utf8",
          maxBuffer: 64 * 1024 * 1024,
          timeout: 240000,
        });
        fs.writeFileSync(
          path.join(directory, "cargo.stdout.jsonl"),
          built.stdout ?? "",
        );
        fs.writeFileSync(
          path.join(directory, "cargo.stderr"),
          built.stderr ?? "",
        );
        active.build = {
          command: [cargo, ...args],
          status: built.status,
          signal: built.signal,
          error: built.error ? String(built.error) : null,
        };
        const events = (built.stdout ?? "")
          .split("\n")
          .filter((x) => x.startsWith("{"))
          .map(JSON.parse);
        active.availableArtifacts = [];
        for (const event of events.filter(
          (e) => e.reason === "compiler-artifact",
        )) {
          const source =
            event.executable ??
            (event.target.name === "demlik_tea"
              ? event.filenames.find((file) => file.endsWith(".rlib"))
              : null);
          if (
            !source ||
            (event.target.name !== fault.example &&
              event.target.name !== "demlik_tea")
          )
            continue;
          const file = assertCheckPath(source, check.target);
          const retained = event.executable
            ? "executed-bin"
            : "modified-library.rlib";
          fs.copyFileSync(file, path.join(directory, retained));
          if (event.executable)
            fs.chmodSync(path.join(directory, retained), 0o755);
          active.availableArtifacts.push({
            event,
            retained,
            sha256: sha(fs.readFileSync(file)),
            actualExecutionClaimed: false,
          });
        }
        save();
        assert.equal(built.status, 0);
        assert.equal(built.error, undefined);
        const library = compiledCheckLibrary(
          events,
          "demlik_tea",
          check.root,
          check.target,
        );
        const selected = events.filter(
          (e) =>
            e.reason === "compiler-artifact" &&
            e.target.name === fault.example &&
            e.target.kind.includes("example") &&
            e.executable,
        );
        assert.equal(selected.length, 1);
        const artifact = selected[0];
        assert.equal(artifact.fresh, false);
        assertCheckPath(artifact.target.src_path, check.root);
        assertCheckPath(artifact.manifest_path, check.root);
        const selectedBinary = assertCheckPath(
          artifact.executable,
          check.target,
        );
        const binary = path.join(directory, "executed-bin");
        fs.copyFileSync(selectedBinary, binary);
        fs.chmodSync(binary, 0o755);
        fs.copyFileSync(
          library.path,
          path.join(directory, "modified-library.rlib"),
        );
        active.producer = {
          library: library.artifact,
          consumer: artifact,
          librarySHA256: sha(fs.readFileSync(library.path)),
          binarySHA256: sha(fs.readFileSync(binary)),
          sourceSHA256: sha(fs.readFileSync(file)),
          libraryRetained: true,
        };
        save();
        if (fault.kind === "strict-shared") {
          const comparison = agentRoutedParity({
            binary,
            output: path.join(directory, "comparison.json"),
            sourceReport,
            onlyId: "agent-routed.promise.invoice",
            allowFailures: true,
          });
          assert.equal(comparison.cases, 1);
          assert.equal(comparison.processes.length, 1);
          assert.equal(comparison.failures.length, 1);
          assert.equal(comparison.passed, 0);
          assert.equal(comparison.qualifiedPassed, 0);
          assert.equal(comparison.binaryHash, active.producer.binarySHA256);
          const row = comparison.observations[0];
          assert.equal(row.id, "agent-routed.promise.invoice");
          assert.deepEqual(row.native.reports, []);
          assert.deepEqual(row.native.diagnostics, []);
          if (fault.name === "routed-next-brain-dropped") {
            assert.equal(row.source.modelCalls, 3);
            assert.equal(row.native.modelCalls, 1);
            assert.equal(row.native.toolCalls, 1);
            assert.ok(
              row.native.commits.some((c) => c.tag === "read_invoice_ok"),
            );
          } else {
            const a = row.source.commits.find(
                (c) => c.tag === "read_invoice_ok",
              ),
              b = row.native.commits.find((c) => c.tag === "read_invoice_ok");
            assert.equal(a.message.at, 20.5);
            assert.equal(b.message.at, 20.5);
            assert.equal(a.state.run.lastProgressAt, 20.5);
            assert.equal(b.state.run.lastProgressAt, 21.5);
          }
          active.witness = {
            id: row.id,
            strictSemanticMismatch: true,
            protocolValid: true,
            comparison: "comparison.json",
          };
        } else {
          const executed = spawnSync(binary, [], {
            cwd: check.root,
            encoding: "utf8",
            timeout: 30000,
            maxBuffer: 8 * 1024 * 1024,
          });
          fs.writeFileSync(
            path.join(directory, "public.stdout"),
            executed.stdout ?? "",
          );
          fs.writeFileSync(
            path.join(directory, "public.stderr"),
            executed.stderr ?? "",
          );
          active.process = {
            command: [binary],
            status: executed.status,
            signal: executed.signal,
            error: executed.error ? String(executed.error) : null,
          };
          save();
          assert.equal(executed.error, undefined);
          assert.equal(executed.status, 101);
          assert.match(
            executed.stderr,
            /routed-reader-refusal-must-not-be-swallowed/,
          );
          active.witness = {
            name: "routed-reader-refusal-must-not-be-swallowed",
            nativeOnly: true,
            SourceCaseCredit: 0,
          };
        }
        assert.equal(
          sha(fs.readFileSync(binary)),
          active.producer.binarySHA256,
        );
        active.detected = true;
        active.status = "detected";
        results.push(active);
        save();
      } finally {
        fs.writeFileSync(file, original);
        assert.equal(sha(fs.readFileSync(file)), sha(original));
        active.sourceRestored = true;
        save();
      }
    }
  } catch (error) {
    active = { ...active, failure: String(error), stack: error.stack };
    save();
    throw error;
  } finally {
    check.remove();
    save();
  }
  return { sourceCommit, results, complete: true };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [output, sourceReport, baselineReport] = process.argv.slice(2);
  await runRoutedControls({ output, sourceReport, baselineReport });
}
