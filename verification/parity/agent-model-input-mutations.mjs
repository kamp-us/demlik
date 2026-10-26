import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { agentModelParity } from "./agent-model-run.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const hash = (file) =>
  createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const ids = ["agent-model.input-missing", "agent-model.input-undefined"];
const ownerTest =
  "library_error_retains_its_live_cause_but_serializes_like_a_js_error";
const controls = [
  {
    name: "missing-input-is-handler-refusal",
    file: "crates/tea/src/agent/model.rs",
    edits: [
      [
        "return Ok(self.llm.rejected_access_error(cause));",
        "let _ = self.llm.rejected_access_error(cause); return Err(LlmCallError::MissingInput { command: crate::Tagged::tag(cmd).into() });",
      ],
    ],
  },
  {
    name: "caught-error-leaks-json-diagnostics",
    file: "crates/tea/src/llm_call/wire.rs",
    edits: [
      [
        "CauseField::AccessError(_) => {",
        "CauseField::AccessError(error) => {",
      ],
      [
        'map.serialize_entry("cause", &PlainData::Object(IndexMap::new()))?;',
        'map.serialize_entry("cause", error)?;',
      ],
    ],
  },
  {
    name: "access-cause-is-reminted-by-reader",
    file: "crates/tea/src/llm_call.rs",
    edits: [
      [
        "CauseField::AccessError(cause) => LlmCause::AccessError(Rc::clone(cause)),",
        "CauseField::AccessError(cause) => LlmCause::AccessError(Rc::new((**cause).clone())),",
      ],
    ],
    nativeOwnerLaw: true,
  },
];

export async function agentModelInputMutations(options) {
  const directory = path.join(root, "target/parity/model-input-mutants");
  fs.mkdirSync(directory, { recursive: true });
  const target = path.resolve(
    options.mutationTarget ??
      path.join(root, "target/parity/agent-model-input-mutation-build"),
  );
  assert.notEqual(
    target,
    path.resolve(process.env.CARGO_TARGET_DIR ?? path.join(root, "target")),
  );
  const baselineHashes = new Map(
    [options.binary, options.ownerBinary].map((file) => [file, hash(file)]),
  );
  const baseline = await agentModelParity({
    binary: options.binary,
    caseIds: ids,
    quiet: true,
    reportFile: path.join(directory, "baseline-pairs.json"),
  });
  assert.equal(baseline.passed, 2);
  const ownerBaseline = spawnSync(options.ownerBinary, ["--exact", ownerTest], {
    encoding: "utf8",
  });
  assert.equal(
    ownerBaseline.status,
    0,
    ownerBaseline.stdout + ownerBaseline.stderr,
  );
  const originals = new Map(
    controls.map((control) => [
      control.file,
      fs.readFileSync(path.join(root, control.file), "utf8"),
    ]),
  );
  const workspace = fs.mkdtempSync(
    path.join(os.tmpdir(), "demlik-model-input-faults-"),
  );
  const results = [];
  try {
    for (const entry of ["Cargo.toml", "Cargo.lock", "crates"])
      fs.cpSync(path.join(root, entry), path.join(workspace, entry), {
        recursive: true,
      });
    for (const control of controls) {
      for (const [file, source] of originals)
        fs.writeFileSync(path.join(workspace, file), source);
      let source = originals.get(control.file);
      for (const [before, after] of control.edits) {
        assert.equal(
          source.split(before).length,
          2,
          `unique fault site: ${control.name}`,
        );
        source = source.replace(before, after);
      }
      fs.writeFileSync(path.join(workspace, control.file), source);
      const name = control.nativeOwnerLaw
        ? "agent_model_input"
        : "agent_model_driver";
      const args = control.nativeOwnerLaw
        ? ["test", "--no-run", "--test", name]
        : ["build", "--example", name];
      args.push(
        "--locked",
        "--offline",
        "--message-format=json",
        "-p",
        "demlik-tea",
      );
      const compiler = process.env.CARGO ?? "cargo";
      const build = spawnSync(compiler, args, {
        cwd: workspace,
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
        env: {
          ...process.env,
          CARGO_TARGET_DIR: target,
          CARGO_PROFILE_DEV_DEBUG: "0",
          CARGO_PROFILE_TEST_DEBUG: "0",
          CARGO_INCREMENTAL: "0",
          CARGO_BUILD_JOBS: "1",
        },
      });
      fs.writeFileSync(
        path.join(directory, `${control.name}.build.jsonl`),
        build.stdout,
      );
      fs.writeFileSync(
        path.join(directory, `${control.name}.build.stderr`),
        build.stderr,
      );
      assert.equal(build.status, 0, build.stderr);
      const messages = build.stdout
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      const artifacts = messages.filter(
        (message) =>
          message.reason === "compiler-artifact" &&
          message.target.name === name &&
          message.executable,
      );
      assert.equal(artifacts.length, 1);
      const actual = artifacts[0].executable;
      const binary = path.join(
        directory,
        `${control.name}-${hash(actual)}.bin`,
      );
      fs.copyFileSync(actual, binary);
      let witness;
      if (control.nativeOwnerLaw) {
        const run = spawnSync(binary, ["--exact", ownerTest], {
          encoding: "utf8",
        });
        fs.writeFileSync(
          path.join(directory, `${control.name}.run.log`),
          run.stdout + run.stderr,
        );
        assert.equal(run.status, 101);
        assert.ok(run.stdout.includes(`test ${ownerTest} ... FAILED`));
        assert.ok(run.stdout.includes("Rc::ptr_eq(retained, &original)"));
        witness = {
          kind: "native-owner-law",
          test: ownerTest,
          exit: run.status,
        };
      } else {
        const report = await agentModelParity({
          binary,
          caseIds: ids,
          quiet: true,
          allowFailures: true,
          reportFile: path.join(directory, `${control.name}.json`),
        });
        assert.equal(report.failures.length, 2);
        assert.ok(
          report.failures.every(
            (failure) =>
              ids.includes(failure.id) &&
              failure.native.ok === true &&
              failure.source.ok === true,
          ),
        );
        assert.equal(Object.keys(report.nativeEvidence).length, 0);
        witness = {
          kind: "source-native-semantic",
          ids: report.failures.map((failure) => failure.id),
        };
      }
      results.push({
        name: control.name,
        file: control.file,
        edits: control.edits,
        compiled: true,
        detected: true,
        buildCommand: [compiler, ...args],
        binary,
        actualArtifact: actual,
        binarySha256: hash(binary),
        sourceSha256: createHash("sha256")
          .update(originals.get(control.file))
          .digest("hex"),
        mutantSha256: createHash("sha256").update(source).digest("hex"),
        witness,
      });
      console.log(
        JSON.stringify({ detected: control.name, kind: witness.kind }),
      );
    }
    for (const [file, source] of originals)
      assert.equal(fs.readFileSync(path.join(root, file), "utf8"), source);
    for (const [file, before] of baselineHashes)
      assert.equal(hash(file), before);
    const report = {
      detected: results.length,
      escaped: 0,
      sourceNativeControls: 2,
      nativeOwnerControls: 1,
      controls: results,
      activeSourceUnchanged: true,
      baselineArtifactsUnchanged: true,
    };
    fs.writeFileSync(
      options.reportFile ??
        path.join(root, "target/parity/model-input-mutations.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );
    return report;
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}
