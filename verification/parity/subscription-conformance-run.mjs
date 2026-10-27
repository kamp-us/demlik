import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  invalidSubscriptionRequests,
  subscriptionCases,
} from "./subscription-conformance-cases.mjs";
import { buildTeaExample } from "./tea-example.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const qualified = new Set([
  "subscription.effect.mixed-cleanup",
  "subscription.effect.mixed-all",
  "subscription.effect.mixed-cleanup.producer",
]);
const qualification =
  "OPEN: Source Effect Stream finalizer failure remains in the completed fiber Exit; Fiber.interrupt awaits and discards that Exit through asVoid(fiberAwait), resolving void to the runner disposal. Native SubscriptionWork cleanup Result is reported under sub-cleanup. These different adapter contracts are observed, never unqualified strict evidence.";
function independent(input, c) {
  assert.equal(
    c.restarts,
    0,
    "a projection refusal must never enter reducer supervision",
  );
  assert.equal(c.stopIdempotent, true);
  assert.ok(
    c.reports.every(
      (r) =>
        r.phase !== "reduce" && r.phase !== "interpret" && r.phase !== "boot",
    ),
  );
  for (const s of c.snapshots) if (s.n !== null) assert.equal(s.original, true);
  const boot = c.snapshots.find((s) => s.label === "boot");
  if (
    ["load-failure", "migrate-refusal", "migrate-throw"].includes(
      input.scenario,
    )
  ) {
    assert.deepEqual(c.saved, []);
    assert.equal(c.effects, 0);
    assert.equal(c.reduceCount, 0);
    assert.equal(
      c.trace.some((s) => s.startsWith("init:")),
      false,
    );
    assert.equal(c.receipts[0].kind, "restore");
  }
  if (["boot-projection", "stored-projection"].includes(input.scenario)) {
    assert.deepEqual(c.saved, [1]);
    assert.equal(c.effects, 0);
    assert.equal(c.bootCallbacks, 0);
    assert.equal(c.reduceCount, 0);
    assert.equal(c.receipts[0].kind, "projection:first");
    assert.equal(c.receipts[0].sameOriginal, true);
    for (const r of c.receipts.slice(1))
      assert.equal(r.sameCached, true, "boot must keep its first failure");
    assert.equal(boot.active.includes("signal:0"), true);
  }
  if (["recover", "two-failures"].includes(input.scenario)) {
    const failed = c.snapshots.find((s) => s.label === "set:1");
    assert.deepEqual(failed.saved, [0, 1]);
    assert.equal(failed.effects, 1);
    assert.equal(failed.commits, 0);
    assert.ok(failed.active.includes("fragile:0"));
    assert.ok(failed.active.includes("steady:1"));
    assert.ok(!failed.active.includes("obsolete:0"));
    assert.equal(
      failed.active.includes("second:0"),
      input.scenario === "two-failures",
    );
    assert.deepEqual(c.saved, [0, 1, 2, 3, 3]);
    assert.equal(c.effects, 3);
    assert.equal(c.commits, 2);
    assert.equal(c.reduceCount, 3);
    const failure =
      input.origin === "caller"
        ? c.receipts.find((r) => r.label === "set:1")
        : c.reports.find((r) => r.phase === "follow-up");
    assert.equal(failure.kind, "projection:first");
    assert.equal(failure.sameOriginal, true);
  }
  if (input.scenario.startsWith("held-load")) {
    assert.deepEqual(c.saved, []);
    assert.equal(c.effects, 0);
    assert.equal(c.reduceCount, 0);
    const late = c.snapshots.find((s) => s.label === "late-boot");
    assert.equal(late.loadedSame, true);
    assert.equal(late.n, 4);
    assert.deepEqual(late.active, []);
    assert.equal(c.receipts.at(-1).kind, "stopped");
    if (input.scenario === "held-load-dispatch")
      assert.equal(
        c.receipts.find((r) => r.label === "queued").kind,
        "discarded",
      );
  }
  if (["held-save", "held-save-projection"].includes(input.scenario)) {
    const held = c.snapshots.find((s) => s.label === "save-held");
    assert.equal(held.n, 1);
    assert.deepEqual(held.saved, [0]);
    assert.equal(held.effects, 1);
    assert.ok(c.reports.some((r) => r.kind === "drain-timeout"));
    assert.deepEqual(c.saved, [0, 1, 1]);
    assert.equal(
      c.receipts.find((r) => r.label === "held").ok,
      input.scenario === "held-save",
    );
  }
  if (input.scenario === "stored") assert.equal(boot.loadedSame, true);
  if (input.scenario === "storeless") assert.deepEqual(c.saved, []);
  if (["mixed-runner", "mixed-all"].includes(input.scenario)) {
    assert.equal(c.reduceCount, 1);
    assert.equal(c.effects, 1);
    assert.equal(c.commits, 0);
    assert.ok(
      c.reports.some(
        (r) => r.phase === "sub" && r.kind === "runner" && r.sameOriginal,
      ),
    );
    if (input.origin === "caller") {
      assert.equal(
        c.receipts.find((r) => r.label === "set:1").kind,
        "projection:first",
      );
      assert.ok(
        c.trace.indexOf("receipt:set:1:projection:first") <
          c.trace.indexOf("cleanup:fragile:0:begin"),
        "caller sees the first failure before stop tears down retained sibling",
      );
    }
  }
}
function qualify(source, native) {
  const c = structuredClone(native.output.comparison);
  const removed = c.reports.filter(
    (r) => r.phase === "sub-cleanup" && r.kind === "cleanup",
  );
  assert.equal(removed.length, 1);
  assert.equal(removed[0].sameOriginal, true);
  c.reports = c.reports.filter((r) => !removed.includes(r));
  c.trace = c.trace.filter((x) => x !== "report:sub-cleanup:cleanup");
  assert.deepEqual(
    c,
    source.output.comparison,
    "only the declared cleanup adapter gap may differ",
  );
  assert.ok(
    source.output.errorProfile.some(
      (p) =>
        p.finalizer === "obsolete:0" &&
        p.exit === "failure" &&
        p.sameOriginal === true,
    ),
    "retain actual Source finalizer Exit and original Cause",
  );
  assert.ok(native.output.errorProfile.some((p) => p.kind === "cleanup"));
}
export async function subscriptionConformance(options = {}) {
  for (const variable of [
    "CARGO_TARGET_DIR",
    "CARGO_BUILD_TARGET_DIR",
    "CARGO_BUILD_BUILD_DIR",
  ])
    assert.equal(process.env[variable], undefined, `${variable} must be unset`);
  assert.equal(
    execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: root,
      encoding: "utf8",
    }).trim(),
    root.slice(0, -1),
  );
  const selected = options.ids
    ? subscriptionCases.filter((c) => options.ids.includes(c.id))
    : subscriptionCases;
  assert.equal(new Set(subscriptionCases.map((c) => c.id)).size, 68);
  if (options.ids)
    assert.equal(
      selected.length,
      new Set(options.ids).size,
      "all named witnesses exist",
    );
  const reportFile =
    options.reportFile ??
    path.join(root, "target/parity/subscription-conformance/report.json");
  await mkdir(path.dirname(reportFile), { recursive: true });
  const proof = options.binary
    ? null
    : buildTeaExample(
        process.env.CARGO ?? "cargo",
        "subscription_conformance_driver",
        reportFile,
      );
  const binary = options.binary ?? proof.binary;
  if (proof) {
    const metadata = JSON.parse(
      execFileSync(
        process.env.CARGO ?? "cargo",
        ["metadata", "--no-deps", "--format-version=1", "--offline"],
        { cwd: root, encoding: "utf8" },
      ),
    );
    assert.equal(metadata.target_directory, path.join(root, "target"));
    assert.ok(proof.actualArtifact.startsWith(path.join(root, "target/")));
  }
  const requests = `${[...selected, ...invalidSubscriptionRequests]
    .map((x) => JSON.stringify(x))
    .join("\n")}\n`;
  const invoke = async (label, program, args) => {
    const result = spawnSync(program, args, {
      cwd: root,
      input: requests,
      encoding: "utf8",
      timeout: 60_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    await writeFile(`${reportFile}.${label}.stderr`, result.stderr ?? "");
    assert.equal(result.error, undefined, `${label}: process execution`);
    assert.equal(result.signal, null, `${label}: process signal`);
    assert.equal(
      result.status,
      0,
      `${label}: process status, ${result.stderr}`,
    );
    return result.stdout;
  };
  const nativeBytes = await invoke("native", binary, []),
    sourceBytes = await invoke("source", process.execPath, [
      "--import",
      require.resolve("tsx"),
      path.join(here, "subscription-conformance-reference.mts"),
    ]);
  const parse = (bytes) => bytes.trim().split("\n").map(JSON.parse);
  const native = parse(nativeBytes),
    source = parse(sourceBytes);
  assert.equal(
    native.length,
    selected.length + invalidSubscriptionRequests.length,
  );
  assert.equal(source.length, native.length);
  const failures = [],
    nativeEvidence = {},
    qualifiedNativeEvidence = {},
    qualifications = [],
    errorProfiles = [];
  for (const [index, test] of selected.entries()) {
    try {
      for (const answer of [native[index], source[index]]) {
        assert.equal(answer.id, test.id, "trusted index/case ID");
        assert.equal(answer.ok, true);
        independent(test.input, answer.output.comparison);
      }
      assert.ok(
        native[index].observedCalls.includes(
          test.input.profile === "promise"
            ? "demlik_tea::runtime::try_launch"
            : "demlik_tea::runtime::try_run",
        ),
      );
      if (qualified.has(test.id)) {
        qualify(source[index], native[index]);
        qualifiedNativeEvidence[test.id] = native[index].observedCalls;
        qualifications.push({
          id: test.id,
          status: "open",
          reason: qualification,
          source: source[index],
          native: native[index],
        });
      } else {
        assert.deepEqual(
          native[index].output.comparison,
          source[index].output.comparison,
          test.id,
        );
        nativeEvidence[test.id] = native[index].observedCalls;
      }
      errorProfiles.push({
        id: test.id,
        source: source[index].output.errorProfile,
        native: native[index].output.errorProfile,
      });
    } catch (error) {
      failures.push({
        id: test.id,
        message: error.message,
        source: source[index],
        native: native[index],
      });
    }
  }
  for (const answers of [source, native])
    for (const answer of answers.slice(selected.length)) {
      assert.equal(answer.id, null);
      assert.equal(answer.ok, false);
      assert.equal(answer.error.kind, "protocol");
    }
  const files = [
    "crates/tea/src/core.rs",
    "crates/tea/src/core/subscriptions.rs",
    "crates/tea/src/runtime/engine.rs",
    "crates/tea/src/runtime/types.rs",
    "crates/tea/src/runtime/scope.rs",
    "crates/tea/src/runtime/work.rs",
    "crates/tea/src/runtime/persistence.rs",
    "crates/tea/examples/subscription_conformance_driver.rs",
    "crates/tea/tests/subscription_runtime.rs",
    "packages/tea/src/internal/engine/loop.ts",
    "packages/tea/src/internal/engine/restore.ts",
    "packages/tea/src/pure/core.ts",
    "packages/tea/src/promise/run.ts",
    "packages/tea/src/effect/run.ts",
    "packages/tea/src/effect/handle.ts",
    "packages/tea/src/effect/failures.ts",
  ];
  const sourceHashes = Object.fromEntries(
    await Promise.all(
      files.map(async (f) => [f, hash(await readFile(path.join(root, f)))]),
    ),
  );
  await writeFile(`${reportFile}.source.jsonl`, sourceBytes);
  await writeFile(`${reportFile}.native.jsonl`, nativeBytes);
  await writeFile(`${reportFile}.requests.jsonl`, requests);
  const report = {
    suite: "typed-subscription-runtime",
    node: { version: process.version, v8: process.versions.v8 },
    cases: selected.filter((c) => !qualified.has(c.id)).length,
    passed: Object.keys(nativeEvidence).length,
    qualifiedCases: selected.filter((c) => qualified.has(c.id)).length,
    qualifiedPassed: qualifications.length,
    observations: selected.length,
    protocolRejects: invalidSubscriptionRequests.length,
    failures,
    nativeEvidence,
    qualifiedNativeEvidence,
    qualifications,
    errorProfiles,
    profile: {
      comparison:
        "controlled caller/producer actions, exact full trace/state/save/report/receipt and authored cause identity; native declared Result wrappers and Source Effect wrappers retained separately",
      sourceBootState:
        "before ready succeeds the oracle retains the original init owner; no failed-ready public getState API is claimed",
      outside: [
        "8 uncoordinated ready-future scheduling gaps",
        "raw JS tags/prototypes/panic versus declared Result",
        "Source optional agent profile resume versus native refusal",
        "raw builtin AgentTurn projection",
        "malformed original-command errOf/decode",
        "missing/null settlement stamp into Agent f64",
        "Agent to_machine/brain wiring not constructed; untagged state admission has separate native/type proof",
      ],
    },
    binary: {
      path: binary,
      sha256: hash(await readFile(binary)),
      cargo: proof,
    },
    sourceHashes,
  };
  await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  if (!options.quiet)
    console.log(
      JSON.stringify({
        reportFile,
        cases: report.cases,
        passed: report.passed,
        qualified: report.qualifiedPassed,
        failures: failures.length,
      }),
    );
  return report;
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const report = await subscriptionConformance();
  if (report.failures.length) process.exitCode = 1;
}
