import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import { pbtPropertyCases } from "./pbt-property-cases.mts";
import { executePbtProperty } from "./pbt-property-reference.mts";
export { pbtPropertyCases };
const native = z
  .object({
    id: z.string(),
    comparison: z.unknown(),
    diagnostics: z.unknown(),
    observedRustCalls: z.array(z.string()),
  })
  .strict();
export function pbtPropertyParity(options: {
  binary: string;
  reportFile?: string;
  caseIds?: string[];
}) {
  const cases = pbtPropertyCases().filter(
    (c) => !options.caseIds || options.caseIds.includes(c.id),
  );
  assert(cases.length > 0, "No selected fixed-sequence cases");
  const source = cases.map((c) => executePbtProperty(c.input));
  const child = spawnSync(options.binary, [], {
    input: `${cases.map((c) => JSON.stringify(c)).join("\n")}\n`,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
  const actual = child.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => native.parse(JSON.parse(l)));
  assert.equal(actual.length, cases.length);
  const failures = cases.flatMap((c, i) => {
    assert.equal(actual[i].id, c.id);
    try {
      assert.deepEqual(actual[i].comparison, source[i].comparison);
      return [];
    } catch {
      return [
        {
          id: c.id,
          reference: source[i].comparison,
          native: actual[i].comparison,
        },
      ];
    }
  });
  const report = {
    scope:
      "pbt::property_invariant fixed shared sequences and msg_sequence exact-tail/prefix shape laws; native generation/shrinking are separately verified",
    runtime: {
      node: process.version,
      v8: process.versions.v8,
      fastCheck: source[0].fastCheckVersion,
    },
    binary: {
      path: options.binary,
      sha256: createHash("sha256")
        .update(readFileSync(options.binary))
        .digest("hex"),
    },
    compared: cases.length,
    passed: cases.length - failures.length,
    failures,
    cases: cases.map((c, i) => ({
      ...c,
      ...actual[i],
      sourceDiagnostics: source[i].diagnostics,
      equal: !failures.some((f) => f.id === c.id),
    })),
    qualifications: [
      "Fixed shared sequences and exact-size constant tails are compared. Proptest and fast-check seed streams, generated distributions, shrink ordering and minima are not cross-language equivalence claims.",
      "Native u32 run counts/u64 seeds are a bounded typed adaptation. Source JS number/coercion/global-fast-check settings and all arbitrary custom/nondeterministic value-tree contracts are not covered.",
      "Native original evaluated messages/full trace/E/panic are retained. Backend-recreated minimum handles are discarded. Source default fast-check error decoration may not retain a thrown raw cause; full actual framework/native diagnostics are stored separately.",
      "Caller-chosen shared inner state/message/payload handles are observed, separate from the fold trace bookkeeping Arc wrappers. Generated messages/strategies require Debug; pure state/commands/context/error require no universal Clone/serde/Send/Debug.",
      "Only msg_sequence/property_invariant are implemented here. This does not bind arbMsg/table/record/constant/other runners, global mocking or Wasm/backend/browser behavior.",
    ],
  };
  const file = options.reportFile ?? "target/parity/pbt-property.json";
  mkdirSync(dirname(resolve(file)), { recursive: true });
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const { values } = parseArgs({
    options: {
      "native-bin": { type: "string" },
      "native-binary": { type: "string" },
      report: { type: "string" },
      "case-id": { type: "string", multiple: true },
    },
    strict: true,
  });
  const binary = values["native-bin"] ?? values["native-binary"];
  assert(binary);
  const report = pbtPropertyParity({
    binary,
    reportFile: values.report,
    caseIds: values["case-id"],
  });
  console.log(
    JSON.stringify({
      compared: report.compared,
      passed: report.passed,
      failures: report.failures,
    }),
  );
  if (report.failures.length) process.exitCode = 1;
}
