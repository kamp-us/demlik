import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import { composeCases } from "./compose-cases.mts";
import { executeCompose } from "./compose-reference.mts";

const output = z
  .object({
    id: z.string(),
    comparison: z.unknown(),
    observedRustCalls: z.array(z.string()),
  })
  .strict();
export function composeParity({
  binary,
  reportFile = "target/parity/compose.json",
  caseIds,
}: {
  binary: string;
  reportFile?: string;
  caseIds?: string[];
}) {
  const scope = JSON.parse(
    readFileSync(new URL("./scope.json", import.meta.url), "utf8"),
  );
  assert.equal(process.version, scope.referenceEngine.node);
  assert.equal(process.versions.v8, scope.referenceEngine.v8);
  const cases = composeCases().filter(
    (c) => !caseIds || caseIds.includes(c.id),
  );
  assert(cases.length > 0);
  assert.equal(new Set(cases.map((c) => c.id)).size, cases.length);
  const source = cases.map((c) => executeCompose(c.input));
  const child = spawnSync(binary, [], {
    input: `${cases.map((c) => JSON.stringify(c)).join("\n")}\n`,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
  const actual = child.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => output.parse(JSON.parse(line)));
  assert.equal(actual.length, cases.length);
  const failures = cases.flatMap((c, i) => {
    assert.equal(actual[i].id, c.id);
    assert(actual[i].observedRustCalls.length);
    try {
      assert.deepEqual(actual[i].comparison, source[i]);
      return [];
    } catch {
      return [{ id: c.id, reference: source[i], native: actual[i].comparison }];
    }
  });
  const report = {
    scope:
      "Pure root composition: named ordered reads, original values/errors/fallback, caller-captured receiver/live iterator and borrowed opaque invoice Update/replay. Direct specific-lift consumers are separately rerun.",
    runtime: scope.referenceEngine,
    binary: {
      path: resolve(binary),
      sha256: createHash("sha256").update(readFileSync(binary)).digest("hex"),
    },
    compared: cases.length,
    passed: cases.length - failures.length,
    failures,
    cases: cases.map((c, i) => ({
      ...c,
      ...actual[i],
      reference: source[i],
      equal: !failures.some((f) => f.id === c.id),
    })),
    qualifications: [
      "Native None represents Source undefined/defer and Err(E) represents the original thrown read value. Parsed verifier callbacks perform that representation change; generic helpers do not inspect domain values.",
      "A native replacement method owns one-field rebuilding and sibling retention. This typed Model profile does not reflect arbitrary JS spread/getters/proxies/symbols/prototypes/descriptors; the measured Source-only profiles remain separate.",
      "Vec movement preserves its allocation and elements, not shared mutable JS command-array aliases. No such alias equivalence is claimed from moved pointers.",
      "Native callbacks explicitly capture a Weak reader owner. The Source method receiver and native captured owner are actually observed; there is no generic JS callable/this runtime.",
      "Live ordering comes from the caller's standard iterator. Source uses its actual live array; native uses std::iter::from_fn over Rc/RefCell indices and yields an Rc reader after dropping guards. Custom arbitrary executor/iterator equivalence is not claimed.",
      "An empty iterator needs an item/domain type; Ok-only readers need a ReadStep/default-Infallible or Ok error annotation. The existing compiler proof retains both measured inference limitations.",
      "The source invoice replay uses valid pure data and nested opaque capabilities. Native lacks Source DEV freeze/assertPureResult machinery; existing DEV qualifications still apply. No typed Cell/runtime reduce-error widening or agent wiring is included.",
    ],
    openGaps: [
      "Arbitrary JS record-spread reflection and shared mutable command-array alias behavior are outside the typed native Model/Vec seam.",
      "Source DEV mutation/result-shape guards and arbitrary typed non-Send reducer errors remain separate existing native core/runtime gaps.",
    ],
  };
  mkdirSync(dirname(resolve(reportFile)), { recursive: true });
  writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
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
  const r = composeParity({
    binary,
    reportFile: values.report,
    caseIds: values["case-id"],
  });
  console.log(
    JSON.stringify({
      compared: r.compared,
      passed: r.passed,
      failures: r.failures.map((f) => f.id),
    }),
  );
  if (r.failures.length) process.exitCode = 1;
}
