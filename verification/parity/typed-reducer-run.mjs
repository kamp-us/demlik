import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkedExecFileSync as execFileSync } from "./check-worktree.mjs";
import { buildTeaExample } from "./tea-example.mjs";
import {
  invalidTypedReducerRequests,
  typedReducerCases,
} from "./typed-reducer-cases.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

function independentPure(input, comparison) {
  assert.equal(comparison.init, 0);
  assert.equal(comparison.subs, 0);
  assert.equal(comparison.effects, 0);
  assert.equal(comparison.seedN, 5);
  const outcome = comparison.outcome;
  if (input.scenario === "empty" || input.scenario === "ordered") {
    assert.equal(outcome.ok, true);
    assert.equal(outcome.n, input.scenario === "empty" ? 5 : 9);
    assert.equal(outcome.owner, true);
    assert.deepEqual(
      outcome.cmds,
      input.verb.startsWith("msgs")
        ? null
        : input.scenario === "empty"
          ? []
          : [7, 10, 9],
    );
    assert.equal(
      outcome.seedSame,
      input.verb.endsWith("shared") ? input.scenario === "empty" : null,
    );
  } else {
    assert.equal(outcome.ok, false);
    assert.equal(
      outcome.kind,
      input.scenario.startsWith("missing-")
        ? "lookup"
        : input.scenario === "nested-no-cell"
          ? "nested-no-cell"
          : input.scenario === "panic"
            ? "panic"
            : "declared",
    );
    if (["declared", "nested-no-cell"].includes(outcome.kind))
      assert.equal(outcome.sameOriginal, true);
  }
  const visits = {
    empty: [],
    ordered: ["add:5", "add:7", "add:10"],
    "reject-first": ["reject:5"],
    "reject-middle": ["add:5", "reject:7"],
    "missing-first": [],
    "missing-middle": ["add:5"],
    "nested-no-cell": ["reject:5"],
    panic: ["reject:5"],
  };
  assert.deepEqual(comparison.trace, visits[input.scenario]);
}

function independentActor(input, c) {
  const supervised = [
    "declared",
    "nested-no-cell",
    "panic",
    "identity-panic",
    "rehydrate-panic",
  ].includes(input.scenario);
  const stopped = supervised && input.policy === "stop";
  const restarted =
    supervised &&
    input.policy === "restart" &&
    input.scenario !== "rehydrate-panic";
  assert.equal(c.n, stopped ? 7 : restarted ? 43 : 10);
  assert.equal(c.owner, true);
  assert.equal(c.effects, stopped ? 1 : 2);
  assert.equal(c.stopIdempotent, true);
  assert.equal(
    c.sameAfterTrigger,
    !(restarted || input.scenario === "success"),
  );
  assert.deepEqual(
    c.saved,
    stopped ? [5, 7, 7] : restarted ? [5, 7, 40, 43, 43] : [5, 7, 10, 10],
  );
  assert.equal(
    c.restarts.length,
    supervised && input.policy === "restart" ? 1 : 0,
  );
  if (c.restarts.length)
    assert.deepEqual(c.restarts[0], {
      state: 7,
      msg: "reject",
      kind:
        input.scenario === "rehydrate-panic"
          ? "declared"
          : input.scenario === "identity-panic"
            ? "panic"
            : input.scenario,
      sameReport: true,
    });
  assert.equal(
    c.reports.length,
    supervised || input.scenario === "identity-drop" ? 1 : 0,
  );
  if (c.reports.length) {
    assert.deepEqual(c.reports[0].saved, [5, 7]);
    assert.equal(c.reports[0].effects, 1);
    assert.equal(
      c.reports[0].phase,
      input.scenario === "identity-drop" ? "identity-drop" : "reduce",
    );
    assert.equal(
      c.reports[0].sameOriginal,
      ["declared", "nested-no-cell", "rehydrate-panic"].includes(input.scenario)
        ? true
        : null,
    );
  }
  assert.deepEqual(c.record, {
    anchor: 5,
    msgs: stopped
      ? ["add"]
      : restarted
        ? ["add", "reject", "add"]
        : ["add", "add"],
    states: stopped ? [7] : restarted ? [7, 40, 43] : [7, 10],
    final: c.n,
    sameFinal: true,
  });
  assert.deepEqual(c.receipts[0], { msg: "add", ok: true });
  if (input.scenario === "success")
    assert.deepEqual(c.receipts, [
      { msg: "add", ok: true },
      { msg: "add", ok: true },
    ]);
  else {
    assert.equal(c.receipts.length, 3);
    if (input.scenario === "identity-drop" || restarted)
      assert.deepEqual(c.receipts[1], { msg: "reject", ok: true });
    else
      assert.deepEqual(c.receipts[1], {
        msg: input.scenario === "lookup" ? "unknown" : "reject",
        ok: false,
        kind: ["panic", "identity-panic", "rehydrate-panic"].includes(
          input.scenario,
        )
          ? "panic"
          : input.scenario,
        sameReport: supervised && input.scenario !== "rehydrate-panic",
      });
    assert.deepEqual(
      c.receipts[2],
      stopped
        ? { msg: "add", ok: false, kind: "stopped", sameReport: false }
        : { msg: "add", ok: true },
    );
  }
  if (input.scenario === "declared" && input.policy === "restart")
    assert.deepEqual(c.trace, [
      "load",
      "migrate",
      "init:5",
      "save:5",
      "subs:5",
      "boot:5",
      "ready",
      "reduce:add:5",
      "save:7",
      "subs:7",
      "effect:7",
      "observe:add:7",
      "receipt:add:ok",
      "reduce:reject:7",
      "report:reduce:declared",
      "rehydrate:reject:7",
      "save:40",
      "subs:40",
      "observe:reject:40",
      "receipt:reject:ok",
      "reduce:add:40",
      "save:43",
      "subs:43",
      "effect:43",
      "observe:add:43",
      "receipt:add:ok",
      "save:43",
      "stopped",
    ]);
}

export async function typedReducerParity(options = {}) {
  const reportFile =
    options.reportFile ??
    path.join(root, "target/typed-reducer-conformance/pairs.json");
  const built = options.binary
    ? undefined
    : buildTeaExample(
        process.env.CARGO ?? "cargo",
        "typed_reducer_driver",
        reportFile,
      );
  options = { ...options, binary: options.binary ?? built.binary, reportFile };
  const scope = JSON.parse(
    await readFile(path.join(here, "scope.json"), "utf8"),
  );
  assert.equal(process.version, scope.referenceEngine.node);
  assert.equal(process.versions.v8, scope.referenceEngine.v8);
  assert.ok(options.binary, "supply an actual Cargo-selected compiled driver");
  const selected = options.caseIds
    ? typedReducerCases.filter((test) => options.caseIds.includes(test.id))
    : typedReducerCases;
  if (options.caseIds) assert.equal(selected.length, options.caseIds.length);
  assert.equal(
    new Set(typedReducerCases.map((test) => test.id)).size,
    typedReducerCases.length,
  );
  const input = `${[...selected.map((test) => JSON.stringify(test)), ...invalidTypedReducerRequests].join("\n")}\n`;
  const invoke = (program, args) =>
    execFileSync(program, args, {
      cwd: root,
      input,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      timeout: 30_000,
    });
  const nativeBytes = invoke(options.binary, []);
  const sourceBytes = invoke(process.execPath, [
    "--import",
    require.resolve("tsx"),
    path.join(here, "typed-reducer-reference.mts"),
  ]);
  const parse = (bytes) =>
    bytes
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  const native = parse(nativeBytes),
    source = parse(sourceBytes);
  assert.equal(
    native.length,
    selected.length + invalidTypedReducerRequests.length,
  );
  assert.equal(source.length, native.length);
  const failures = [],
    nativeEvidence = {},
    errorProfiles = [];
  for (const [index, test] of selected.entries()) {
    try {
      for (const answer of [native[index], source[index]]) {
        assert.equal(answer.id, test.id, "trusted case identity/order");
        assert.equal(answer.ok, true, JSON.stringify(answer.error));
        if (test.input.suite === "pure")
          independentPure(test.input, answer.output.comparison);
        else independentActor(test.input, answer.output.comparison);
      }
      assert.deepEqual(
        native[index].output.comparison,
        source[index].output.comparison,
        test.id,
      );
      assert.ok(native[index].observedCalls.length);
      nativeEvidence[test.id] = native[index].observedCalls;
      errorProfiles.push({
        id: test.id,
        native: native[index].output.errorProfile,
        source: source[index].output.errorProfile,
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
      assert.equal(answer.ok, false);
      assert.equal(answer.error.kind, "protocol");
    }
  const files = [
    "crates/tea/src/core.rs",
    "crates/tea/src/core/identity.rs",
    "crates/tea/src/runtime/engine.rs",
    "crates/tea/src/runtime/types.rs",
    "crates/tea/src/runtime/scope.rs",
    "crates/tea/src/runtime/drive.rs",
    "crates/tea/src/persistence/recorder.rs",
    "crates/tea/examples/typed_reducer_driver.rs",
    "crates/tea/examples/typed_reducer/pure.rs",
    "crates/tea/examples/typed_reducer/actor.rs",
    "verification/parity/typed-reducer-cases.mjs",
    "verification/parity/typed-reducer-reference.mts",
    "verification/parity/typed-reducer-actor-reference.mts",
    "verification/parity/typed-reducer-run.mjs",
    "packages/tea/src/pure/core.ts",
    "packages/tea/src/internal/engine/builtins.ts",
    "packages/tea/src/internal/engine/loop.ts",
    "packages/tea/src/promise/run.ts",
    "packages/tea/src/effect/run.ts",
  ];
  const report = {
    scope:
      "Typed native reducer Result mapped to Source reducer throws at actual pure fold/actor seams; one canonical fold and actor",
    reference: scope.reference,
    node: process.version,
    v8: process.versions.v8,
    cases: selected.length,
    passed: selected.length - failures.length,
    protocolRefusals: invalidTypedReducerRequests.length,
    failures,
    nativeEvidence,
    errorProfiles,
    qualifications: [
      "Comparison is the declared domain/data/identity/ordering projection. Raw error profiles are retained separately: native ApplyError::Reduce/RuntimeError::Reduce transport is not a claim that arbitrary Source throws have native names/prototypes.",
      "Native panics remain separate from declared Result errors. Source Error throws and native catch_unwind panic transport compare only their explicit boundary behavior and message.",
      "Controlled caller schedules only. No Promise scheduler, JS mutable getter/prototype or serialization framework is introduced; pure borrowed errors and actor-owned static lifetimes have independent compiled proofs.",
    ],
    binary: {
      path: path.resolve(options.binary),
      sha256: hash(await readFile(options.binary)),
    },
    inputSha256: hash(input),
    sourceOutputSha256: hash(sourceBytes),
    nativeOutputSha256: hash(nativeBytes),
    sourceHashes: Object.fromEntries(
      await Promise.all(
        files.map(async (file) => [
          file,
          hash(await readFile(path.join(root, file))),
        ]),
      ),
    ),
  };
  await mkdir(path.dirname(reportFile), { recursive: true });
  report.rawProof = {
    input: `${reportFile}.input.jsonl`,
    source: `${reportFile}.source.jsonl`,
    native: `${reportFile}.native.jsonl`,
  };
  await Promise.all([
    writeFile(report.rawProof.input, input),
    writeFile(report.rawProof.source, sourceBytes),
    writeFile(report.rawProof.native, nativeBytes),
  ]);
  await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  if (!options.quiet)
    console.log(
      JSON.stringify({
        cases: report.cases,
        passed: report.passed,
        failures: report.failures.length,
        reportFile,
      }),
    );
  return { ...report, reportFile };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const at = process.argv.indexOf("--binary");
  const report = await typedReducerParity({
    binary: at < 0 ? undefined : process.argv[at + 1],
  });
  if (report.failures.length) process.exitCode = 1;
}
