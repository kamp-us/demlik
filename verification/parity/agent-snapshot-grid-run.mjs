import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  agentSnapshotGridCases,
  snapshotAnchorExpectations,
  snapshotAuthoringGate,
} from "./agent-snapshot-grid-cases.mjs";
import {
  agentSnapshotMessagesCases,
  snapshotMessagesAuthoringGate,
  snapshotMessagesOpenId,
  snapshotMessagesQualification,
} from "./agent-snapshot-messages-cases.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url)),
  require = createRequire(import.meta.url),
  sha = (v) => createHash("sha256").update(v).digest("hex");
const engine = JSON.parse(
  fs.readFileSync(new URL("./scope.json", import.meta.url)),
).referenceEngine;
const hostEnvelopeQualified = new Set([
  "agent-snapshot.promise.writer-fail",
  "agent-snapshot.promise.save-fail",
  "agent-snapshot.effect.writer-fail",
  "agent-snapshot.effect.save-fail",
]);
const hostEnvelopeQualification =
  "Original application cause, identity, follow-up phase/cardinality, initial dispatch receipt, state and wires match. Raw Source reporter error/context/display versus typed native Handler/Save Debug envelope remains different and retained outside the comparison view.";
function hashes() {
  const files = execFileSync(
    "git",
    [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
      "--",
      "crates/tea/src",
      "crates/tea/examples/agent_snapshot_grid",
      "crates/tea/examples/agent_snapshot_grid_driver.rs",
      "verification/parity/agent-snapshot-grid-cases.mjs",
      "verification/parity/agent-snapshot-grid-reference.mts",
      "verification/parity/agent-snapshot-grid-run.mjs",
      "verification/parity/agent-snapshot-messages-cases.mjs",
      "verification/parity/agent-snapshot-messages-run.mjs",
      "crates/tea/examples/agent_snapshot_messages_driver.rs",
      "packages/tea/src",
    ],
    { cwd: root, encoding: "utf8" },
  )
    .split("\0")
    .filter(Boolean);
  return Object.fromEntries(
    files.sort().map((f) => [f, sha(fs.readFileSync(path.join(root, f)))]),
  );
}
function literal(row, expected, cold = false) {
  if (cold) {
    assert.deepEqual(row.view.writer.counts, expected.writer);
    assert.deepEqual(row.view.reader.counts, expected.reader);
    assert.deepEqual(row.view.reader.readyCounts, [0, 0, 0, 0]);
    assert.deepEqual(row.view.reader.loaded, {
      status: "tracked",
      checks: 1,
      same: true,
    });
    assert.equal(row.view.reader.state.run.phase, "done");
    return;
  }
  const v = row.view;
  assert.deepEqual(v.counts, expected.counts);
  assert.equal(v.state.run.phase, expected.phase);
  assert.equal(v.failure?.phase ?? null, expected.failure);
  assert.equal(v.state.run.snapshot.lastSavedSeq, null);
  assert.equal(v.state.run.snapshot.lastSavedAt, null);
  assert.deepEqual(v.loaded, {
    status: "not-applicable",
    checks: 0,
    same: true,
  });
  if (v.failure) assert.equal(v.failure.same, true);
  assert.equal(v.reports.length, expected.reports ?? 0);
  for (const report of v.reports) {
    assert.equal(report.phase, "follow-up");
    assert.equal(report.same, true);
    assert.deepEqual(report.cause, { source: "snapshot-fixture", token: 17 });
  }
  if (expected.held) {
    assert.equal(v.held.earlyDonePending, true);
    assert.equal(v.held.lateDoneSame, true);
    assert.equal(v.held.resultSame, true);
  }
  if (v.anchors) {
    assert.equal(v.anchors.length, 4);
    for (const anchor of v.anchors) {
      const want = snapshotAnchorExpectations[anchor.id];
      assert.ok(want);
      assert.equal(anchor.snapshot.seq, want.seq);
      assert.deepEqual(
        anchor.commands.map((c) => c.seq),
        want.writes,
      );
      assert.ok(anchor.commands.every((c) => !Object.hasOwn(c, "payload")));
    }
  }
}
function messagesLiteral(row, c, kind) {
  const checkMessages = (v, expectedCount, now) => {
    assert.equal(v.messages.length, expectedCount);
    if (!expectedCount) {
      assert.deepEqual(v.messageOwners, {
        status: "not-applicable",
        checks: 0,
        same: null,
      });
      return;
    }
    assert.equal(v.messages.at(-1).type, "agent_cancel");
    assert.equal(v.messages.at(-1).at, now + 2.25);
    if (expectedCount === 4) {
      assert.deepEqual(
        v.messages.slice(0, 3).map((m) => m.callId),
        ["follow-context", "follow-first", "follow-second"],
      );
      assert.deepEqual(
        v.messages.slice(0, 3).map((m) => m.at),
        [now + 1, now + 1.25, now + 1.5],
      );
      assert.deepEqual(v.messageOwners, {
        status: "tracked",
        checks: 3,
        same: true,
      });
      for (const message of v.messages.slice(0, 3))
        assert.deepEqual(message.result, {
          label: "original",
          unknown: { values: [1, null, "kept"] },
        });
    } else
      assert.deepEqual(v.messageOwners, {
        status: "not-applicable",
        checks: 0,
        same: null,
      });
  };
  if (c.cold) {
    literal(row, c.expected, true);
    checkMessages(row.view.writer, 0, 17.25);
    checkMessages(row.view.reader, 4, 57.25);
    return;
  }
  const v = row.view,
    e = c.expected;
  assert.deepEqual(
    v.counts,
    kind === "source" ? (e.sourceCounts ?? e.counts) : e.counts,
  );
  assert.equal(v.state.run.phase, e.phase);
  assert.equal(v.failure, null);
  assert.equal(v.state.run.snapshot.lastSavedSeq, null);
  assert.equal(v.state.run.snapshot.lastSavedAt, null);
  assert.equal(v.reports.length, e.reports ?? 0);
  checkMessages(v, e.messages, 17.25);
  if (c.input.scenario === "writer-fail") {
    assert.equal(v.reports[0].phase, "follow-up");
    assert.equal(v.reports[0].same, true);
    assert.deepEqual(v.reports[0].cause, {
      source: "snapshot-fixture",
      token: 17,
    });
  }
  if (c.input.scenario === "held-stop") {
    assert.equal(v.held.stateSameAfterStop, true);
    assert.equal(v.held.stateSameAfterLate, true);
    assert.equal(v.held.initialDispatchRejected, false);
    assert.equal(row.storeBytes, v.held.afterStop.storeBytes);
    assert.equal(row.namedBytes, v.held.afterStop.namedBytes);
  }
  if (e.messages) {
    const returned = v.trace.findIndex((event) => event[0] === "returned"),
      nextModel = v.trace.findIndex(
        (event, i) => i > returned && event[0] === "model",
      ),
      cancel = v.trace.findIndex(
        (event) => event[0] === "commit" && event[1] === "agent_cancel",
      );
    assert.ok(
      returned >= 0 && nextModel > returned && cancel > nextModel,
      "returned Cancel is queued; the current transition starts its next handler first",
    );
  }
}
export function agentSnapshotGridParity(options = {}) {
  assert.equal(process.version, engine.node);
  assert.equal(process.versions.v8, engine.v8);
  const output = path.resolve(
    options.output ?? path.join(root, "target/parity/agent-snapshot-grid.json"),
  );
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const before = hashes(),
    binary = options.binary && path.resolve(options.binary),
    binaryHash = binary ? sha(fs.readFileSync(binary)) : null;
  assert.ok(
    binary || options.sourceOnly,
    "actual Cargo-selected binary required",
  );
  const cases = options.messages
    ? agentSnapshotMessagesCases
    : agentSnapshotGridCases;
  const selected = options.only
    ? cases.filter((c) => c.id === options.only)
    : cases;
  assert.ok(selected.length);
  assert.equal(new Set(selected.map((c) => c.id)).size, selected.length);
  const rows = [],
    processes = [];
  let active = null;
  const invoke = (kind, input, phase) => {
    const prefix = `${output}.${input.id}.${kind}.${phase}`,
      program = kind === "source" ? "pnpm" : binary,
      args =
        kind === "source"
          ? [
              "exec",
              "node",
              "--import",
              require.resolve("tsx"),
              path.join(
                root,
                "verification/parity/agent-snapshot-grid-reference.mts",
              ),
            ]
          : [];
    const result = spawnSync(program, args, {
      cwd: root,
      input: `${JSON.stringify(input)}\n`,
      encoding: "utf8",
      timeout: 20000,
      maxBuffer: 32 << 20,
    });
    fs.writeFileSync(`${prefix}.stdout`, result.stdout ?? "");
    fs.writeFileSync(`${prefix}.stderr`, result.stderr ?? "");
    const processRecord = {
      kind,
      phase,
      program,
      args,
      input,
      status: result.status,
      signal: result.signal,
      error: result.error
        ? {
            name: result.error.name,
            message: result.error.message,
            code: result.error.code,
          }
        : null,
      stdout: `${prefix}.stdout`,
      stderr: `${prefix}.stderr`,
      binarySha256: kind === "native" ? binaryHash : null,
    };
    processes.push(processRecord);
    fs.writeFileSync(
      `${prefix}.process.json`,
      `${JSON.stringify(processRecord, null, 2)}\n`,
    );
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    const lines = result.stdout.trim().split("\n");
    assert.equal(lines.length, 1, "one structured public workflow");
    const row = JSON.parse(lines[0]);
    assert.equal(row.id, input.id);
    assert.ok(row.observedCalls.length);
    return row;
  };
  try {
    for (const c of selected) {
      active = c.id;
      const outputs = {};
      for (const kind of options.sourceOnly
        ? ["source"]
        : ["source", "native"]) {
        const directory = path.join(
          root,
          options.messages
            ? "target/parity/agent-snapshot-messages-io"
            : "target/parity/agent-snapshot-grid-io",
          c.id,
          kind,
        );
        fs.rmSync(directory, { recursive: true, force: true });
        fs.mkdirSync(directory, { recursive: true });
        if (c.cold) {
          const writer = invoke(
              kind,
              { id: c.id, ...c.input, mode: "writer", path: directory },
              "writer",
            ),
            reader = invoke(
              kind,
              { id: c.id, ...c.input, mode: "reader", path: directory },
              "reader",
            );
          outputs[kind] = {
            id: c.id,
            view: { writer: writer.view, reader: reader.view },
            raw: { writer, reader },
            observedCalls: [...writer.observedCalls, ...reader.observedCalls],
          };
        } else
          outputs[kind] = invoke(
            kind,
            { id: c.id, ...c.input, path: directory },
            "main",
          );
      }
      const literals = {};
      for (const [kind, row] of Object.entries(outputs)) {
        try {
          if (options.messages) messagesLiteral(row, c, kind);
          else literal(row, c.expected, c.cold);
          literals[kind] = { passed: true };
        } catch (error) {
          literals[kind] = {
            passed: false,
            message: error.message,
            actual: error.actual,
            expected: error.expected,
          };
        }
      }
      let equal = null,
        difference = null;
      const wireChecks = [];
      if (outputs.native) {
        try {
          assert.deepEqual(outputs.native.view, outputs.source.view);
          for (const phase of c.cold ? ["writer", "reader"] : ["main"]) {
            const n = c.cold ? outputs.native.raw[phase] : outputs.native,
              s = c.cold ? outputs.source.raw[phase] : outputs.source;
            for (const field of ["storeBytes", "namedBytes"]) {
              assert.equal(n[field], s[field], `${phase} ${field}`);
              wireChecks.push({ phase, field, present: s[field] !== null });
            }
          }
          equal = true;
        } catch (error) {
          equal = false;
          difference = error.message;
        }
      }
      rows.push({
        id: c.id,
        input: c.input,
        expected: c.expected,
        literals,
        equal,
        difference,
        qualification: options.messages
          ? [
              snapshotMessagesQualification,
              ...(c.hostEnvelope ? [hostEnvelopeQualification] : []),
            ].join(" ")
          : hostEnvelopeQualified.has(c.id)
            ? hostEnvelopeQualification
            : null,
        ...(options.messages ? { open: c.open } : {}),
        wireChecks,
        source: outputs.source,
        native: outputs.native ?? null,
      });
    }
    assert.deepEqual(
      hashes(),
      before,
      "source fixed during workflow comparison",
    );
    const failures = rows
        .filter((r) => r.equal === false)
        .map((r) => ({ id: r.id, difference: r.difference })),
      literalFailures = rows.flatMap((r) =>
        Object.entries(r.literals)
          .filter(([, v]) => !v.passed)
          .map(([kind, v]) => ({ id: r.id, kind, ...v })),
      );
    const report = {
      suite: options.messages
        ? "agent-snapshot-messages"
        : "agent-snapshot-grid",
      cases: rows.length,
      passed: rows.filter((r) => r.equal === true).length,
      failures,
      literalFailures,
      sourceOnly: !!options.sourceOnly,
      binary: binary ? { path: binary, sha256: binaryHash } : null,
      sourceHashes: before,
      sourceUnchanged: true,
      processes,
      observations: rows,
      nativeEvidence: Object.fromEntries(
        rows
          .filter(
            (r) =>
              r.equal === true &&
              !options.messages &&
              !hostEnvelopeQualified.has(r.id),
          )
          .map((r) => [r.id, r.native.observedCalls]),
      ),
      qualifiedNativeEvidence: Object.fromEntries(
        rows
          .filter(
            (r) =>
              r.equal === true &&
              (options.messages || hostEnvelopeQualified.has(r.id)),
          )
          .map((r) => [r.id, r.native.observedCalls]),
      ),
      authoringGate: options.messages
        ? snapshotMessagesAuthoringGate
        : snapshotAuthoringGate,
      qualifications: [
        ...(options.messages ? [snapshotMessagesQualification] : []),
        hostEnvelopeQualification,
        "Fixed injected clocks and authored dense data/profile only; no arbitrary executor, JS heap/prototype/panic or raw-at closure.",
        options.messages
          ? "All matched rows are runtime-only qualified, not published typed handler parity. Original payload handles and finite message order are checked; arbitrary raw inputs/live returned arrays remain OPEN."
          : "Plain snapshot writers return no messages. Returned-message behavior remains OPEN and unmeasured; existing host context dispatch is preserved.",
        "Named IO copies bytes already written by the actual runtime FileStore; Source undefined payload is never replaced with full State.",
        "Cold writer exits during accepted checkpoint IO after real named bytes; no graceful-stop/awaited cleanup claim, and loaded identity is the actual decoded reader owner.",
      ],
      openGaps: [
        ...(options.messages
          ? [
              {
                id: snapshotMessagesOpenId,
                reason:
                  "Original Effect held-stop Source invokes one extra load/model prefix after writer cleanup; native does not. State, exact wires and late-message rejection match, but whole counts/trace differ. OPEN with zero comparison credit; eager Promise versus lazy future is a hypothesis, not an engine repair.",
              },
              "Published TypeScript snapshot handler refuses Msg/list returns (TS2322); raw JavaScript inputs/live returned arrays and general host cancellation ordering remain OPEN.",
            ]
          : [
              "Arbitrary returned snapshot messages; no equivalence claim or qualified credit.",
            ]),
        "Existing native host error wrapper versus raw JS throw/Effect diagnostics and arbitrary opaque/cyclic codecs remain OPEN.",
      ],
      comparisonProfile:
        "Complete authored view, original application cause/identity and exact Store/named bytes; no universal host-envelope equality.",
      ...(options.messages
        ? {
            strictTypedParityCredit: 0,
            openCases: rows.filter((r) => r.open && r.equal === false).length,
            qualifiedPassed: rows.filter((r) => r.equal === true).length,
          }
        : {}),
    };
    fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
    if (!options.allowFailures) {
      assert.equal(
        failures.filter(
          (r) => !options.messages || r.id !== snapshotMessagesOpenId,
        ).length,
        0,
      );
      assert.equal(literalFailures.length, 0);
    }
    return report;
  } catch (error) {
    fs.writeFileSync(
      `${output}.incomplete.json`,
      `${JSON.stringify({ active, error: { name: error.name, message: error.message, stack: error.stack }, sourceHashes: before, sourceUnchanged: JSON.stringify(hashes()) === JSON.stringify(before), processes, observations: rows }, null, 2)}\n`,
    );
    throw error;
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2),
    get = (k) => {
      const i = args.indexOf(k);
      return i < 0 ? undefined : args[i + 1];
    };
  const r = agentSnapshotGridParity({
    binary: get("--binary"),
    output: get("--output"),
    only: get("--only"),
    sourceOnly: args.includes("--source-only"),
    allowFailures: args.includes("--allow-failures"),
  });
  console.log(
    JSON.stringify({
      cases: r.cases,
      passed: r.passed,
      failures: r.failures.length,
      literalFailures: r.literalFailures.length,
    }),
  );
}
