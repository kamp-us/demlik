import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { agentModelParity } from "./agent-model-run.mjs";
import {
  createCheckWorktree,
  checkedExecFileSync as execFileSync,
} from "./check-worktree.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url)),
  hash = (x) => createHash("sha256").update(x).digest("hex"),
  file = "crates/tea/src/agent/model.rs";
const control = (name, before, after, id) => ({
  name,
  before,
  after,
  ids: [`agent-model.${id}`],
});
const controls = [
  control(
    "plain-skips-first-parse",
    "schema.parse((self.0)(messages).await?).map(Into::into)",
    "(self.0)(messages).await",
    "plain-loaded-transform-raw",
  ),
  control(
    "plain-parses-extra-time",
    "schema.parse((self.0)(messages).await?).map(Into::into)",
    "schema.parse(schema.parse((self.0)(messages).await?)?.into()).map(Into::into)",
    "wrapped-loaded-transform-raw",
  ),
  control(
    "model-id-is-lost",
    "model_of(input.model.as_ref())",
    "model_of(None)",
    "factory-unicode",
  ),
  control(
    "loader-precedes-factory",
    "let model = self.ports.model.model_of(input.model.as_ref())?;\n            let messages = self.ports.load_messages.load(input).await?;",
    "let messages = self.ports.load_messages.load(input).await?;\n            let model = self.ports.model.model_of(input.model.as_ref())?;",
    "factory-failure-loader",
  ),
  control(
    "schema-precedes-loader",
    "let messages = self.ports.load_messages.load(input).await?;\n            let schema = self.llm.schema_of(&input.purpose);",
    "let schema = self.llm.schema_of(&input.purpose);\n            let messages = self.ports.load_messages.load(input).await?;",
    "factory-failure-loader",
  ),
  control(
    "loader-called-twice",
    "let messages = self.ports.load_messages.load(input).await?;",
    "let _ = self.ports.load_messages.load(input).await?;\n            let messages = self.ports.load_messages.load(input).await?;",
    "plain-shared-loaded-repeated",
  ),
  control(
    "factory-failure-identity-erased",
    "model_of(input.model.as_ref())?",
    "model_of(input.model.as_ref()).map_err(|_|CallValue::Undefined)?",
    "factory-failure-factory",
  ),
  control(
    "loader-failure-identity-erased",
    "load_messages.load(input).await?",
    "load_messages.load(input).await.map_err(|_|CallValue::Undefined)?",
    "wrapped-failure-loader",
  ),
  control(
    "bind-failure-identity-erased",
    "model.with_structured_output(&schema)?",
    "model.with_structured_output(&schema).map_err(|_|CallValue::Undefined)?",
    "factory-failure-bind",
  ),
  control(
    "port-failure-identity-erased",
    "Err(cause) => Ok(self.llm.rejected(cause)),",
    "Err(_cause) => Ok(self.llm.rejected(CallValue::Undefined)),",
    "plain-failure-invoke",
  ),
  control(
    "plain-parse-failure-identity-erased",
    "schema.parse((self.0)(messages).await?).map(Into::into)",
    "schema.parse((self.0)(messages).await?).map(Into::into).map_err(|_|CallValue::Undefined)",
    "plain-failure-parse1",
  ),
  control(
    "default-loader-refuses-valid-call",
    "Ok(Messages::Shared(Rc::new(Vec::new())))",
    "Err(CallValue::Undefined)",
    "plain-empty-identity-raw",
  ),
  control(
    "plain-drops-original-messages",
    "schema.parse((self.0)(messages).await?).map(Into::into)",
    "schema.parse((self.0)(Messages::Shared(Rc::new(Vec::new()))).await?).map(Into::into)",
    "plain-shared-loaded-repeated",
  ),
  control(
    "valid-answer-is-rejected",
    "Ok(raw) => self.llm.decode(cmd, raw),",
    "Ok(raw) => self.llm.decode(cmd, raw).map(|_|self.llm.rejected(CallValue::Undefined)),",
    "promise-factory-success",
  ),
];
export async function agentModelMutations(options = {}) {
  const mutationCheck = createCheckWorktree(
    process.cwd(),
    "agent-model-mutations",
  );
  let mutationFailure;
  try {
    const baselineTarget =
        process.env.CARGO_TARGET_DIR ?? path.join(root, "target"),
      target = mutationCheck.target;
    assert.notEqual(path.resolve(target), path.resolve(baselineTarget));
    const binary =
        options.binary ??
        path.join(baselineTarget, "debug/examples/agent_model_driver"),
      binaryHash = hash(fs.readFileSync(binary)),
      original = fs.readFileSync(path.join(root, file), "utf8");
    const sources = [
        "packages/tea/src/agent/model.ts",
        "packages/tea/src/internal/llm-call/index.ts",
      ],
      sourceHashes = Object.fromEntries(
        sources.map((x) => [x, hash(fs.readFileSync(path.join(root, x)))]),
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
      const baseline = await agentModelParity({
        binary,
        quiet: true,
        reportFile: path.join(
          root,
          "target/parity/agent-model-mutation-baseline.json",
        ),
      });
      assert.equal(baseline.cases, 92);
      assert.equal(baseline.passed, 92);

      for (const item of controls.filter(
        (item) => !options.only || options.only.includes(item.name),
      )) {
        assert.equal(
          original.split(item.before).length,
          2,
          `unique ${item.name}`,
        );
        const mutant = original.replace(item.before, item.after);
        fs.writeFileSync(path.join(workspace, file), mutant);
        execFileSync(
          process.env.CARGO ?? "cargo",
          [
            "build",
            "--locked",
            "--offline",
            "-p",
            "demlik-tea",
            "--example",
            "agent_model_driver",
          ],
          { cwd: workspace, env, stdio: "pipe", maxBuffer: 16 * 1024 * 1024 },
        );
        const result = await agentModelParity({
          binary: path.join(target, "debug/examples/agent_model_driver"),
          caseIds: item.ids,
          allowFailures: true,
          quiet: true,
          reportFile: path.join(
            root,
            `target/parity/agent-model-mutants/${item.name}.json`,
          ),
        });
        const failures = result.failures.map((x) => x.id);
        assert.ok(
          item.ids.some((id) => failures.includes(id)),
          `${item.name}: no declared semantic witness mismatch`,
        );
        for (const id of failures)
          assert.ok(!Object.hasOwn(result.nativeEvidence, id));
        detected.push({
          name: item.name,
          file,
          compiled: true,
          detected: true,
          expected: item.ids,
          failures,
          originalSha256: hash(original),
          mutantSha256: hash(mutant),
        });
        console.log(
          JSON.stringify({ detected: item.name, witnesses: failures.length }),
        );
      }
      assert.equal(fs.readFileSync(path.join(root, file), "utf8"), original);
      assert.equal(hash(fs.readFileSync(binary)), binaryHash);
      for (const source of sources)
        assert.equal(
          hash(fs.readFileSync(path.join(root, source))),
          sourceHashes[source],
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
          runtimeCasesIncluded: baseline.runtimeCases,
          qualifiedObservationsExcluded: baseline.qualifiedObservations.length,
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
      const output =
        options.reportFile ??
        path.join(root, "target/parity/agent-model-mutations.json");
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
  await agentModelMutations();
