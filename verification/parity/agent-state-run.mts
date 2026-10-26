import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import { stateCases } from "./agent-state-cases.mts";
import { execute, input } from "./agent-state-reference.mts";

const root = fileURLToPath(new URL("../..", import.meta.url)),
  hash = (value: string | Buffer) =>
    createHash("sha256").update(value).digest("hex");
export async function stateParity(
  options: {
    binary?: string;
    caseIds?: readonly string[];
    reportFile?: string;
    allowFailures?: boolean;
    quiet?: boolean;
  } = {},
) {
  assert.equal(process.version, "v22.21.1");
  assert.equal(process.versions.v8, "12.4.254.21-node.33");
  const binary =
    options.binary ??
    path.join(root, "target/debug/examples/agent_state_driver");
  const all = stateCases();
  assert.equal(new Set(all.map((x) => x.id)).size, all.length);
  const cases = options.caseIds
    ? all.filter((x) => options.caseIds?.includes(x.id))
    : all;
  if (options.caseIds) assert.equal(cases.length, options.caseIds.length);
  const requests = cases.map((x) => ({ id: x.id, input: input(x.script) }));
  const encoded = `${requests.map((x) => JSON.stringify(x)).join("\n")}\n`;
  const run = spawnSync(binary, [], {
    cwd: root,
    input: encoded,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stderr, "");
  const native = run.stdout
    .trim()
    .split("\n")
    .map((x) =>
      z
        .object({
          id: z.string(),
          ok: z.boolean(),
          output: z.record(z.string(), z.unknown()).optional(),
          error: z.string().optional(),
          observedCalls: z.array(z.string()),
        })
        .strict()
        .parse(JSON.parse(x)),
    );
  assert.equal(native.length, cases.length);
  const failures: Array<{
      id: string;
      message: string;
      source: unknown;
      native: unknown;
    }> = [],
    nativeEvidence: Record<string, string[]> = {},
    rawWireObservations: unknown[] = [];
  for (let i = 0; i < cases.length; i++) {
    const test = cases[i],
      response = native[i],
      source = execute(requests[i].input);
    try {
      assert.equal(response.id, test.id);
      assert.equal(response.ok, true);
      assert.ok(response.output);
      const { wire: sourceWire, ...sourceValue } = source,
        { wire: nativeWire, ...nativeValue } = response.output;
      assert.deepEqual(nativeValue, sourceValue);
      const expected =
        test.script.operation === "inspect"
          ? [
              "current_stage",
              "is_settled",
              "require_awaiting",
              "require_awaiting",
              "require_awaiting",
            ]
          : ["with_usage_defaults"];
      assert.deepEqual(
        response.observedCalls,
        expected.map((x) => `demlik_tea::agent::types::AgentState::${x}`),
      );
      if (test.id === "agent-state.usage-current-null-absent")
        assert.equal(response.output.stateSame, true);
      if (test.id === "agent-state.usage-null-null-null") {
        assert.equal(response.output.stateSame, false);
        assert.equal(response.output.usageOrigin, "zero");
        assert.equal(response.output.legacyKind, "absent");
      }
      if (test.id === "agent-state.stage-cancelled-two")
        assert.deepEqual(response.output.stage, { name: "original" });
      if (test.id === "agent-state.stage-running-undefined-first")
        assert.deepEqual(response.output.stage, { $undefined: true });
      if (
        test.script.failure === "undefined" ||
        test.script.failure === "absent"
      ) {
        if (test.script.operation === "inspect")
          assert.equal(response.output.settled, true);
      }
      nativeEvidence[test.id] = [...new Set(response.observedCalls)];
      if (sourceWire !== undefined)
        rawWireObservations.push({
          id: test.id,
          equal: sourceWire === nativeWire,
          source: sourceWire,
          native: nativeWire,
        });
    } catch (error) {
      failures.push({
        id: test.id,
        message: error instanceof Error ? error.message : String(error),
        source,
        native: response,
      });
    }
  }
  const report = {
    reference: "75de37ea01a81cd7949e6275b7ee9cfdeb4e312d",
    node: process.version,
    v8: process.versions.v8,
    cases: cases.length,
    passed: cases.length - failures.length,
    failures,
    nativeEvidence,
    rawWireObservations,
    inputSha256: hash(encoded),
    binarySha256: hash(fs.readFileSync(binary)),
    sourceHashes: Object.fromEntries(
      [
        "packages/tea/src/agent/types.ts",
        "packages/tea/src/agent/internal.ts",
        "crates/tea/src/agent/types.rs",
        "crates/tea/src/agent/state.rs",
        "crates/tea/src/agent/wire.rs",
        "crates/tea/src/flow/fan_out.rs",
      ].map((f) => [f, hash(fs.readFileSync(path.join(root, f)))]),
    ),
    profile:
      "Canonical known state fields, decoded JSON values, explicit legacy/failure presence and original owner identities. Raw wire strings retained separately; arbitrary property insertion order is not asserted. Unknown extra properties/getters/prototypes/sparse/custom-iterator arrays remain Source-only; prerequisite own-tool-result reflection stays qualified. No Agent factory/machine/provider/SDK/children/status-projection claim.",
  };
  const file =
    options.reportFile ?? path.join(root, "target/parity/agent-state.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  if (!options.quiet)
    console.log(
      JSON.stringify({
        cases: report.cases,
        passed: report.passed,
        failures: failures.slice(0, 3).map((x) => ({
          id: x.id,
          message: x.message.split("\n")[0],
        })),
        reportFile: file,
      }),
    );
  if (!options.allowFailures) assert.deepEqual(failures, []);
  return report;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  await stateParity();
