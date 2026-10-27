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

const root = fileURLToPath(new URL("../..", import.meta.url)),
  require = createRequire(import.meta.url),
  sha = (v) => createHash("sha256").update(v).digest("hex");
const engine = JSON.parse(
  fs.readFileSync(new URL("./scope.json", import.meta.url)),
).referenceEngine;
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
  const selected = options.only
    ? agentSnapshotGridCases.filter((c) => c.id === options.only)
    : agentSnapshotGridCases;
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
          "target/parity/agent-snapshot-grid-io",
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
          literal(row, c.expected, c.cold);
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
      suite: "agent-snapshot-grid",
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
          .filter((r) => r.equal === true)
          .map((r) => [r.id, r.native.observedCalls]),
      ),
      qualifiedNativeEvidence: {},
      authoringGate: snapshotAuthoringGate,
      qualifications: [
        "Fixed injected clocks and authored dense data/profile only; no arbitrary executor, JS heap/prototype/panic or raw-at closure.",
        "Plain snapshot writers return no messages. Returned-message behavior remains OPEN and unmeasured; existing host context dispatch is preserved.",
        "Named IO copies bytes already written by the actual runtime FileStore; Source undefined payload is never replaced with full State.",
        "Cold writer exits during accepted checkpoint IO after real named bytes; no graceful-stop/awaited cleanup claim, and loaded identity is the actual decoded reader owner.",
      ],
      openGaps: [
        "Arbitrary returned snapshot messages; no equivalence claim or qualified credit.",
        "Existing native host error wrapper versus raw JS throw/Effect diagnostics and arbitrary opaque/cyclic codecs remain OPEN.",
      ],
      comparisonProfile:
        "Complete authored view, original application cause/identity and exact Store/named bytes; no universal host-envelope equality.",
    };
    fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
    if (!options.allowFailures) {
      assert.equal(failures.length, 0);
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
