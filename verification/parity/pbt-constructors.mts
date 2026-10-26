import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import { pbtConstructorCases } from "./pbt-constructors-cases.mts";
import { executeConstructorInvoice } from "./pbt-constructors-invoice.mts";
import { executePbtConstructor } from "./pbt-constructors-reference.mts";

const output = z
  .object({
    id: z.string(),
    comparison: z.object({ status: z.string() }).passthrough(),
    diagnostics: z.unknown(),
    observedRustCalls: z.array(z.string()),
  })
  .strict();
const errorOwnership = z
  .object({
    category: z.literal("case"),
    phase: z.literal("trace"),
    messagesOriginal: z.literal(true),
    error: z
      .object({
        originalError: z.literal(true),
        originalCause: z.literal(true),
        originalSnapshot: z.literal(true),
      })
      .passthrough(),
  })
  .passthrough();
export function pbtConstructorsParity({
  binary,
  reportFile = "target/parity/pbt-constructors.json",
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
  const cases = pbtConstructorCases().filter(
    (c) => !caseIds || caseIds.includes(c.id),
  );
  assert(cases.length);
  assert.equal(new Set(cases.map((c) => c.id)).size, cases.length);
  const source = cases.map((c) =>
    c.input.kind === "invoice"
      ? executeConstructorInvoice(c.input)
      : executePbtConstructor(c.input),
  );
  const run = spawnSync(binary, [], {
    input: `${cases.map((c) => JSON.stringify(c)).join("\n")}\n`,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  const actual = run.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => output.parse(JSON.parse(l)));
  assert.equal(actual.length, cases.length);
  const failures = cases.flatMap((c, i) => {
    assert.equal(actual[i].id, c.id);
    assert(
      actual[i].observedRustCalls.includes(
        c.input.kind === "constant"
          ? "demlik_tea::pbt::constant_msg"
          : "demlik_tea::pbt::record_msg",
      ),
    );
    const reasons: unknown[] = [];
    try {
      assert.deepEqual(actual[i].comparison, source[i].comparison);
    } catch {
      reasons.push("source-comparison");
    }
    if (c.input.kind === "invoice" && c.input.rule === "error") {
      const checked = errorOwnership.safeParse(actual[i].diagnostics);
      if (!checked.success)
        reasons.push({
          kind: "native-original-error-owners",
          issues: checked.error.issues,
        });
    }
    return reasons.length
      ? [
          {
            id: c.id,
            reference: source[i].comparison,
            native: actual[i].comparison,
            reasons,
            nativeDiagnostics: actual[i].diagnostics,
          },
        ]
      : [];
  });
  const report = {
    scope:
      "Two constructor fixed/shared typed payload profiles; native seed/shrink laws separate",
    runtime: scope.referenceEngine,
    nativeCommand: {
      executable: resolve(binary),
      args: [],
      exit: run.status,
      stderr: run.stderr,
    },
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
      reference: source[i].comparison,
      sourceDiagnostics: source[i].diagnostics,
      equal: !failures.some((f) => f.id === c.id),
    })),
    qualifications: [
      "Native authored message/field types and presence model, without general JS record reflection, discriminator overrides, symbol/key/prototype/getter/descriptor behavior or unpairedUTF16tags.",
      "Proptest1.11 and fast-check3.23.2 RNG/generation/current/shrink/error profiles differ. These pairs use fixed values and actual original owners; no equal-seed stream claim.",
      "Default fast-check3.23.2 Error decoration does not expose callback/fold errors through cause. Full Source inspect/stack and callback observation are retained; native post-return typed error/message/cause/snapshot ownership is separately required, not equated to that outer Error.",
      "The prior27Source-only observations remain separate; native generation/shrink laws and controls are not added to strict comparison counts.",
    ],
    openGaps: [
      "Arbitrary JS record reflection/raw UTF16tags and backend-specific behavior remain outside this typed profile.",
    ],
  };
  mkdirSync(dirname(resolve(reportFile)), { recursive: true });
  writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}
export function pbtConstructorsNative({
  binary,
  reportFile = "target/parity/pbt-constructors-native.json",
  caseIds,
}: {
  binary: string;
  reportFile?: string;
  caseIds?: string[];
}) {
  const cases = [
    {
      id: "constructors.native.constant-owner",
      input: { kind: "native", law: "constant" },
    },
    {
      id: "constructors.native.seed-replay",
      input: { kind: "native", law: "seedReplay" },
    },
    {
      id: "constructors.native.field-shrink",
      input: { kind: "native", law: "fieldShrink" },
    },
  ].filter((c) => !caseIds || caseIds.includes(c.id));
  assert(cases.length);
  const run = spawnSync(binary, [], {
    input: `${cases.map((c) => JSON.stringify(c)).join("\n")}\n`,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  const rows = run.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => output.parse(JSON.parse(l)));
  assert.equal(rows.length, cases.length);
  const expected: Record<string, Record<string, unknown>> = {
    "constructors.native.constant-owner": {
      status: "ok",
      sameCurrent: true,
      sameAcrossTrees: true,
      noShrink: true,
      originalPayload: true,
      borrowedInvoice: "invoice-42",
      capability: 31,
    },
    "constructors.native.seed-replay": {
      status: "ok",
      sameSeedLogical: true,
      differentSeedLogical: true,
      prefixHandles: true,
      originalPayloads: true,
      boundedTail: true,
      histories: 48,
    },
    "constructors.native.field-shrink": {
      status: "case",
      minimum: 13,
      originalMessages: true,
      originalTrace: true,
      originalError: true,
      originalCause: true,
      originalSnapshot: true,
      originalCommands: true,
      commandPayloads: true,
      modelOwner: true,
      capability: 37,
      invoice: "invoice-42",
    },
  };
  const failures = rows.flatMap((row, i) => {
    assert.equal(row.id, cases[i].id);
    try {
      for (const [k, v] of Object.entries(expected[row.id])) {
        assert.deepEqual(Reflect.get(row.comparison, k), v);
      }
      return [];
    } catch {
      return [
        { id: row.id, expected: expected[row.id], actual: row.comparison },
      ];
    }
  });
  const report = {
    scope:
      "Native-only Proptest seeded generation/shrink/actual-failure ownership laws, no Source equality",
    binary: {
      path: resolve(binary),
      sha256: createHash("sha256").update(readFileSync(binary)).digest("hex"),
    },
    nativeCommand: {
      executable: resolve(binary),
      args: [],
      exit: run.status,
      stderr: run.stderr,
    },
    nativeCases: cases.length,
    passed: cases.length - failures.length,
    failures,
    semanticPairs: 0,
    cases: rows.map((row, i) => ({
      ...cases[i],
      ...row,
      expected: expected[row.id],
      passed: !failures.some((f) => f.id === row.id),
    })),
    qualifications: [
      "Independent native generation runs intentionally compare logical values; no cross-language stream/shrink equivalence or reconstruction of a failed evaluation.",
      "The actual failed messages/trace/error/snapshot/commands are captured directly; no callback replay or value-to-owner lookup table.",
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
      "native-only": { type: "boolean" },
      report: { type: "string" },
      "case-id": { type: "string", multiple: true },
    },
    strict: true,
  });
  assert(values["native-bin"]);
  const r = (
    values["native-only"] ? pbtConstructorsNative : pbtConstructorsParity
  )({
    binary: values["native-bin"],
    reportFile: values.report,
    caseIds: values["case-id"],
  });
  console.log(
    JSON.stringify({
      compared: "compared" in r ? r.compared : 0,
      nativeCases: "nativeCases" in r ? r.nativeCases : 0,
      passed: r.passed,
      failures: r.failures.map((f) => f.id),
    }),
  );
  if (r.failures.length) process.exitCode = 1;
}
