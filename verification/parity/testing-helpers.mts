import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import { testingHelperCases } from "./testing-helpers-cases.mts";

const native = z
  .object({
    id: z.string(),
    comparison: z.unknown(),
    observedRustCalls: z.array(z.string()),
    nativeDiagnostics: z.unknown(),
    nativeComparisons: z.array(z.unknown()),
  })
  .strict();
const source = z
  .object({
    runtime: z.object({ node: z.string(), v8: z.string() }).strict(),
    developmentChecks: z.boolean(),
    cases: z.array(
      z
        .object({
          id: z.string(),
          input: z.unknown(),
          comparison: z.unknown(),
          sourceCalls: z.array(z.string()),
          sourceDiagnostics: z.unknown().optional(),
        })
        .strict(),
    ),
  })
  .strict();
export { testingHelperCases };
export function testingHelpersParity(options: {
  binary: string;
  reportFile?: string;
  caseIds?: string[];
}) {
  const file = resolve(
    options.reportFile ?? "target/parity/testing-helpers.json",
  );
  mkdirSync(dirname(file), { recursive: true });
  const sourceReport = `${file}.source.json`,
    probeReport = `${file}.source-probes.json`;
  const oracle = spawnSync(
    "pnpm",
    [
      "exec",
      "vitest",
      "run",
      "--config",
      "verification/parity/testing-helpers-source.config.mts",
    ],
    {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      env: {
        ...process.env,
        TEA_TESTING_SOURCE_REPORT: sourceReport,
        TEA_TESTING_PROBE_REPORT: probeReport,
      },
    },
  );
  assert.equal(oracle.status, 0, `${oracle.stdout}\n${oracle.stderr}`);
  const reference = source.parse(
    JSON.parse(readFileSync(sourceReport, "utf8")),
  );
  const cases = testingHelperCases().filter(
    (c) => !options.caseIds || options.caseIds.includes(c.id),
  );
  const p = spawnSync(options.binary, [], {
    input: `${cases.map((c) => JSON.stringify(c)).join("\n")}\n`,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  assert.equal(p.status, 0, p.stderr);
  const actual = p.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((s) => native.parse(JSON.parse(s)));
  assert.equal(actual.length, cases.length);
  const byId = new Map(reference.cases.map((c) => [c.id, c]));
  const failures = cases.flatMap((c, i) => {
    assert.equal(actual[i].id, c.id);
    const expected = byId.get(c.id);
    assert(expected);
    try {
      assert.deepEqual(actual[i].comparison, expected.comparison);
      return [];
    } catch {
      return [
        {
          id: c.id,
          reference: expected.comparison,
          native: actual[i].comparison,
        },
      ];
    }
  });
  const report = {
    runtime: reference.runtime,
    sourceDevelopmentChecks: reference.developmentChecks,
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
      ...byId.get(c.id),
      ...actual[i],
      equal: !failures.some((f) => f.id === c.id),
    })),
    oracle: {
      runner: "installed Vitest",
      stdout: oracle.stdout,
      stderr: oracle.stderr,
      report: sourceReport,
      probes: probeReport,
    },
    qualifications: [
      "Explicit caller comparison profiles for valid pure Counter/Poller data only; no universal Vitest deep-equality, asymmetric/prototype/function/reflection or matcher-traversal equivalence.",
      "Source DEV freeze and top-level function-command checks are not implemented by native generic helpers, including replay-based helpers with updates; typed Step rules out async/non-tuple result shapes.",
      "Source full framework diagnostics and native operation/index/length/caller-cause data are retained side by side; their decorations/messages are not asserted identical.",
      "Poller replay value uses its canonical JSON persistence projection plus actual last-result presence/reference; inherited optional idempotency-policy own-presence limitations remain qualified.",
      "Inner caller-chosen model/payload handles are observed; no automatic shared JavaScript heap, global mocks or testing runtime drive implementation.",
    ],
  };
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const { values } = parseArgs({
    options: { "native-bin": { type: "string" }, report: { type: "string" } },
    strict: true,
  });
  assert(values["native-bin"]);
  const report = testingHelpersParity({
    binary: values["native-bin"],
    reportFile: values.report,
  });
  console.log(
    JSON.stringify({
      compared: report.compared,
      passed: report.passed,
      failures: report.failures.map((f) => f.id),
    }),
  );
  if (report.failures.length) process.exitCode = 1;
}
