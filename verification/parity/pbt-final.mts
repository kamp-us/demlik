import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import { pbtFinalCases } from "./pbt-final-cases.mts";
import { executePbtInvoice } from "./pbt-final-reference.mts";
import { executePbtProperty } from "./pbt-property-reference.mts";

const native = z
  .object({
    id: z.string(),
    comparison: z.unknown(),
    diagnostics: z.unknown(),
    observedRustCalls: z.array(z.string()),
  })
  .strict();
export function pbtFinalParity(options: {
  binary: string;
  reportFile?: string;
  caseIds?: string[];
}) {
  const scope = JSON.parse(
    readFileSync(new URL("./scope.json", import.meta.url), "utf8"),
  );
  assert.equal(process.version, scope.referenceEngine.node);
  assert.equal(process.versions.v8, scope.referenceEngine.v8);
  const all = pbtFinalCases();
  const selected = (id: string) =>
    !options.caseIds || options.caseIds.includes(id);
  const counter = all.counter.filter((c) => selected(c.id)),
    invoice = all.invoice.filter((c) => selected(c.id));
  const cases = [...counter, ...invoice];
  assert(cases.length > 0);
  const source = [
    ...counter.map((c) => executePbtProperty(c.input, c.input.check)),
    ...invoice.map((c) => executePbtInvoice(c.input)),
  ];
  for (const s of source)
    if ("fastCheckVersion" in s) assert.equal(s.fastCheckVersion, "3.23.2");
  const commands = [counter, invoice].flatMap((group, i) => {
    if (!group.length) return [];
    const child = spawnSync(options.binary, i ? ["--invoice"] : [], {
      input: `${group.map((c) => JSON.stringify(c)).join("\n")}\n`,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
    return [
      {
        args: i ? ["--invoice"] : [],
        exit: child.status,
        stderr: child.stderr,
        rows: child.stdout
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((l) => native.parse(JSON.parse(l))),
      },
    ];
  });
  const actual = commands.flatMap((c) => c.rows);
  assert.equal(actual.length, cases.length);
  const failures = cases.flatMap((c, i) => {
    assert.equal(actual[i].id, c.id);
    assert.deepEqual(actual[i].observedRustCalls, [
      `pbt::property_${c.input.check}`,
    ]);
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
      "property_terminates/property_trace: exactly one post-complete-fold callback, shared fixed counter and opaque Poller/invoice histories; native generation/shrinking verified separately",
    runtime: scope.referenceEngine,
    binary: {
      path: resolve(options.binary),
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
    commands: commands.map(({ rows: _rows, ...c }) => c),
    qualifications: [
      "Shared fixed sequences use fast-check3.23.2 and native Proptest1.11.0. Seed streams, generated distributions, shrinking/minima/order, JS option coercions and global backend settings are not cross-language equivalence claims.",
      "Terminates checks one actual final state after a finite fold, including empty cases. It does not drive command handlers/timers or prove eventual runtime termination. Trace receives all chronological steps and the same actual final state.",
      "Native original evaluated messages/trace/E/panic are retained without callback replay. Framework-specific Error decoration/stack formatting and native typed errors are retained separately, not equated.",
      "Inner authored state/payload/command handle identity is distinct from fold bookkeeping Arc wrappers. No blanket Clone/serde/Send/Debug bounds are imposed on pure state/commands/context/error.",
      "False-result Source diagnostics invoke JSON.stringify(final), including toJSON/getter/cycle/BigInt effects. Native typed failure does not serialize S; these measured observations remain OPEN outside strict comparisons and mappings retain that known gap.",
      "Native standard deterministic strategy shrinking/replay and original-handle retention are tested separately. No arbitrary/nondeterministic custom value-tree equivalence is promised.",
    ],
    openGaps: [
      "Source false-result JSON.stringify(final)/toJSON diagnostic effects are not implemented by the unconstrained native typed runner.",
    ],
  };
  const file = options.reportFile ?? "target/parity/pbt-final.json";
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
      report: { type: "string" },
      "case-id": { type: "string", multiple: true },
    },
    strict: true,
  });
  assert(values["native-bin"]);
  const report = pbtFinalParity({
    binary: values["native-bin"],
    reportFile: values.report,
    caseIds: values["case-id"],
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
