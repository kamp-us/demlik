import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const [sourceDirectory, nativePath, reportPath] = process.argv.slice(2);
assert(
  sourceDirectory && nativePath && reportPath,
  "provide Source directory, native JSONL and report path",
);
const scenarios = new Map([
  ["complete", "invoice.run-complete"],
  ["machine", "invoice.machine-complete"],
  ["resume-brain", "invoice.resume-awaiting-brain"],
  ["resume-tool", "invoice.resume-awaiting-tool"],
  ["terminal", "invoice.terminal-no-work"],
  ["declared-failure", "invoice.declared-tool-failure-recovery"],
]);
const native = (await readFile(nativePath, "utf8"))
  .trim()
  .split("\n")
  .map(JSON.parse);
assert.equal(native.length, scenarios.size);
const rows = [];
for (const [scenario, id] of scenarios) {
  const candidate = native.filter((row) => row.scenario === scenario);
  assert.equal(candidate.length, 1, `${id}: exactly one native job`);
  const source = JSON.parse(
    await readFile(path.join(sourceDirectory, id, "stdout"), "utf8"),
  );
  const processReceipt = JSON.parse(
    await readFile(path.join(sourceDirectory, id, "process.json"), "utf8"),
  );
  assert.equal(processReceipt.exit, 0, `${id}: actual Source process passed`);
  assert.equal(
    source.assertionsPassed,
    true,
    `${id}: Source's independent assertions passed`,
  );
  assert.equal(
    candidate[0].phases.length,
    source.receipts.length,
    `${id}: phase count`,
  );
  assert.equal(candidate[0].report, source.report, `${id}: actual report file`);
  let lexicalSaveMatches = 0;
  for (const [index, expected] of source.receipts.entries()) {
    const actual = candidate[0].phases[index];
    const label = `${id}/phase-${index}`;
    assert.deepEqual(
      actual.prompts,
      expected.prompts.map((prompt) => prompt.messages),
      `${label}: complete prompts`,
    );
    assert.deepEqual(
      actual.events,
      expected.events,
      `${label}: complete semantic events`,
    );
    assert.deepEqual(
      actual.hooks,
      expected.hooks,
      `${label}: complete failure hooks`,
    );
    assert.deepEqual(
      actual.saves,
      expected.saves.map((save) => JSON.parse(save.wire)),
      `${label}: every saved state`,
    );
    assert.deepEqual(
      actual.final,
      expected.final,
      `${label}: complete final state`,
    );
    assert.deepEqual(
      actual.nativeTrace,
      [
        "demlik_tea::agent::DefineAgentConfig::new",
        "demlik_tea::agent::define_agent",
        `demlik_tea::agent::DefinedAgent::${scenario === "machine" ? "machine" : "run"}`,
      ],
      `${label}: observed compiled public calls`,
    );
    assert.deepEqual(
      actual.handlerCalls.map(({ tool, args, rawSame }) => ({
        tool,
        args,
        rawSame,
      })),
      expected.handlerCalls.map(({ tool, args, rawSame }) => ({
        tool,
        args,
        rawSame,
      })),
      `${label}: handlers and parsed arguments`,
    );
    assert(
      expected.handlerCalls.every(
        (call) =>
          call.hostObjectSame === false &&
          call.servicesSame === true &&
          call.tokenSame === true,
      ),
      `${label}: Source wraps the host while retaining its services and token`,
    );
    assert(
      actual.handlerCalls.every((call) => call.hostObjectSame === true),
      `${label}: Rust's ToolContext.host retains the exact application host`,
    );
    assert.equal(actual.saveWires.length, expected.saves.length);
    for (const [save, wire] of actual.saveWires.entries()) {
      assert.deepEqual(
        JSON.parse(wire),
        JSON.parse(expected.saves[save].wire),
        `${label}: actual Store wire ${save}`,
      );
      assert.equal(
        wire,
        expected.saves[save].wire,
        `${label}: byte-exact Store wire ${save}`,
      );
      if (wire === expected.saves[save].wire) lexicalSaveMatches += 1;
    }
    assert.deepEqual(
      JSON.parse(actual.finalWire),
      JSON.parse(expected.finalWire),
      `${label}: actual final wire`,
    );
    assert.equal(
      actual.finalWire,
      expected.finalWire,
      `${label}: byte-exact final wire`,
    );
  }
  rows.push({
    id,
    nativeScenario: scenario,
    phases: source.receipts.length,
    saveCount: source.receipts.reduce(
      (sum, phase) => sum + phase.saves.length,
      0,
    ),
    lexicalSaveMatches,
    status: "qualified",
    qualifications: [
      {
        profile: "NATIVE-HOST-CONTEXT",
        fields: ["handlerCalls[*].hostObjectSame"],
        source: false,
        native: true,
        reason:
          "TypeScript passes a fresh context object with the original services/token. Rust exposes the original application host through ToolContext.host. Both actual owner profiles are mandatory; this field is not claimed identical.",
      },
    ],
  });
}
const report = {
  scope:
    "Six serial defined-Agent invoice jobs: complete prompts, events, failure hooks, all saves, final states and handler/owner profiles",
  status: "passed",
  rows,
  phases: rows.reduce((sum, row) => sum + row.phases, 0),
  limitations: [
    "Restart retains in-process canonical Rust and TypeScript state; no decoded cold restart claim.",
    "Source's additional parser/content/turn identity probes are retained in its captures; this comparator does not award those probes new shared credit.",
    "No policies, streaming, compaction, snapshots, provider SDK or arbitrary callback-error profile is claimed.",
    "JSON value equality is required for every wire; lexical matches are reported separately.",
  ],
  globalParityCreditAdded: 0,
};
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(
  JSON.stringify({
    status: report.status,
    jobs: rows.length,
    phases: report.phases,
    saves: rows.reduce((sum, row) => sum + row.saveCount, 0),
    lexicalSaveMatches: rows.reduce(
      (sum, row) => sum + row.lexicalSaveMatches,
      0,
    ),
  }),
);
