import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  agentCompactionCases,
  compactionAuthoringGate,
} from "./agent-compaction-cases.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url)),
  require = createRequire(import.meta.url),
  sha = (x) => createHash("sha256").update(x).digest("hex");
const engine = JSON.parse(
  fs.readFileSync(new URL("./scope.json", import.meta.url)),
).referenceEngine;
function hashes() {
  const names = execFileSync(
    "git",
    [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
      "--",
      "crates/tea/src",
      "crates/tea/examples/agent_compaction",
      "crates/tea/examples/agent_compaction_driver.rs",
      "verification/parity/agent-compaction-cases.mjs",
      "verification/parity/agent-compaction-reference.mts",
      "verification/parity/agent-compaction-run.mjs",
      "packages/tea/src",
    ],
    { cwd: root, encoding: "utf8" },
  )
    .split("\0")
    .filter(Boolean);
  return Object.fromEntries(
    names.sort().map((f) => [f, sha(fs.readFileSync(path.join(root, f)))]),
  );
}
function literal(row, expected, cold = false) {
  const v = row.view;
  if (cold) {
    assert.deepEqual(v.writer.counts, expected.writerCounts);
    assert.deepEqual(v.reader.counts, expected.readerCounts);
    assert.deepEqual(v.reader.readyCounts, [0, 0, 0]);
    assert.equal(v.reader.readySame, true);
    return;
  }
  if (v.frames) {
    const f = v.frames.at(-1),
      s = f.state,
      c = s.conversation;
    for (const [key, want] of Object.entries(expected)) {
      const got =
        key === "awaiting"
          ? c.awaiting.kind
          : key === "lastTags"
            ? f.cmds.map((x) => x.type)
            : key === "turnCount"
              ? c.turnCount
              : key === "folding"
                ? c.awaiting.folding
                : key === "turns"
                  ? c.turns.length
                  : key === "records"
                    ? c.toolRecords.length
                    : key === "contextTokens"
                      ? c.contextTokens
                      : key === "failure"
                        ? s.failure.reason
                        : key === "phase"
                          ? s.run.phase
                          : key === "retry"
                            ? Object.keys(s.compaction.retry).length > 0
                            : key === "brainRetry"
                              ? s.resilience.retry.invoice.attempt
                              : key === "compactRetry"
                                ? s.compaction.retry.$compact.attempt
                                : key === "rngDraws"
                                  ? f.log.filter((x) => x[0] === "rng").length
                                  : undefined;
      assert.deepEqual(got, want, key);
    }
  } else {
    assert.equal(v.state.run.phase, expected.cancelled ? "cancelled" : "done");
    assert.equal(v.doneSame, true);
  }
}
export function assertCompactionIdentity(input, row) {
  if (input.mode === "pure") return;
  const view = row.view,
    loaded = input.mode === "reader",
    guard = ["retry", "exhaust"].includes(input.scenario);
  assert.deepEqual(
    view.identityDomains.loaded,
    { status: loaded ? "tracked" : "not-applicable", checks: loaded ? 1 : 0 },
    "loaded-State identity domain",
  );
  if (loaded)
    assert.equal(
      view.readySame,
      true,
      "original decoded State retained at ready",
    );
  assert.equal(
    view.identityDomains.guard.status,
    guard ? "tracked" : "not-applicable",
    "guard identity domain",
  );
  if (guard) {
    assert.ok(
      view.identityDomains.guard.errors > 0,
      "expected actual guard rejection",
    );
    assert.equal(
      view.identityDomains.guard.checks,
      view.identityDomains.guard.errors,
      "every guard instance must be checked",
    );
    assert.equal(
      view.causeSame,
      true,
      "actual original guard instance retained",
    );
  } else {
    assert.equal(
      view.identityDomains.guard.errors,
      0,
      "no guard rejection claimed",
    );
    assert.equal(
      view.identityDomains.guard.checks,
      0,
      "no untracked identity credit",
    );
  }
}
export function agentCompactionParity(options = {}) {
  assert.equal(process.version, engine.node);
  assert.equal(process.versions.v8, engine.v8);
  const out = path.resolve(
    options.output ?? path.join(root, "target/parity/agent-compaction.json"),
  );
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const before = hashes(),
    tsx = require.resolve("tsx"),
    binary = options.binary && path.resolve(options.binary);
  assert.ok(
    binary || options.sourceOnly,
    "an actual Cargo-selected --binary is required",
  );
  const binaryHash = binary ? sha(fs.readFileSync(binary)) : null;
  const selected = options.only
    ? agentCompactionCases.filter((c) => c.id === options.only)
    : agentCompactionCases;
  assert.ok(selected.length);
  assert.equal(new Set(selected.map((c) => c.id)).size, selected.length);
  const observations = [],
    processes = [];
  let active = null;
  function invoke(kind, input, logicalId, phase) {
    const prefix = `${out}.${logicalId}.${kind}.${phase}`;
    const args =
      kind === "source"
        ? [
            "exec",
            "node",
            "--import",
            tsx,
            path.join(
              root,
              "verification/parity/agent-compaction-reference.mts",
            ),
          ]
        : [];
    const command = kind === "source" ? "pnpm" : binary;
    const run = spawnSync(command, args, {
      cwd: root,
      input: `${JSON.stringify(input)}\n`,
      encoding: "utf8",
      timeout: 15000,
      maxBuffer: 32 * 1024 * 1024,
    });
    fs.writeFileSync(`${prefix}.stdout`, run.stdout ?? "");
    fs.writeFileSync(`${prefix}.stderr`, run.stderr ?? "");
    const record = {
      kind,
      logicalId,
      phase,
      command,
      args,
      input,
      status: run.status,
      signal: run.signal,
      error: run.error
        ? {
            name: run.error.name,
            message: run.error.message,
            code: run.error.code,
          }
        : null,
      stdout: `${prefix}.stdout`,
      stderr: `${prefix}.stderr`,
      binarySha256: kind === "native" ? binaryHash : null,
    };
    fs.writeFileSync(
      `${prefix}.process.json`,
      `${JSON.stringify(record, null, 2)}\n`,
    );
    processes.push(record);
    assert.ifError(run.error);
    assert.equal(run.status, 0, run.stderr);
    const lines = run.stdout.trim().split("\n");
    assert.equal(lines.length, 1, "exactly one structured driver row");
    const row = JSON.parse(lines[0]);
    assert.equal(row.id, input.id);
    assert.ok(row.observedCalls.length);
    return row;
  }
  try {
    for (const c of selected) {
      active = c.id;
      const outputs = {};
      for (const kind of options.sourceOnly
        ? ["source"]
        : ["source", "native"]) {
        const directory = path.join(
          root,
          "target/parity/agent-compaction-io",
          c.id,
          kind,
        );
        fs.rmSync(directory, { recursive: true, force: true });
        fs.mkdirSync(directory, { recursive: true });
        if (c.cold) {
          const writer = invoke(
            kind,
            { id: c.id, ...c.input, mode: "writer", path: directory },
            c.id,
            "writer",
          );
          const reader = invoke(
            kind,
            { id: c.id, ...c.input, mode: "reader", path: directory },
            c.id,
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
            {
              id: c.id,
              ...c.input,
              ...(c.input.mode === "pure" ? {} : { path: directory }),
            },
            c.id,
            "main",
          );
      }
      const expected = {};
      for (const [kind, row] of Object.entries(outputs)) {
        try {
          literal(row, c.expected, c.cold);
          if (c.cold) {
            for (const phase of ["writer", "reader"])
              assertCompactionIdentity(
                { ...c.input, mode: phase },
                row.raw[phase],
              );
          } else assertCompactionIdentity(c.input, row);
          expected[kind] = { passed: true };
        } catch (error) {
          expected[kind] = {
            passed: false,
            message: error.message,
            actual: error.actual,
            expected: error.expected,
          };
        }
      }
      let equal = null,
        difference = null,
        wireChecks = [];
      if (outputs.native) {
        try {
          assert.deepEqual(outputs.native.view, outputs.source.view);
          if (c.cold) {
            for (const phase of ["writer", "reader"]) {
              assert.equal(
                outputs.native.raw[phase].checkpointBytes,
                outputs.source.raw[phase].checkpointBytes,
                `${phase} exact checkpoint bytes`,
              );
              wireChecks.push(phase);
            }
          } else if (outputs.source.checkpointBytes !== undefined) {
            assert.equal(
              outputs.native.checkpointBytes,
              outputs.source.checkpointBytes,
              "exact checkpoint bytes",
            );
            wireChecks.push("main");
          }
          equal = true;
        } catch (error) {
          equal = false;
          difference = error.message;
        }
      }
      observations.push({
        id: c.id,
        input: c.input,
        expected: c.expected,
        literal: expected,
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
      "source immutable during paired comparison",
    );
    const failures = observations
      .filter((r) => r.equal === false)
      .map((r) => ({ id: r.id, difference: r.difference }));
    const report = {
      suite: "agent-compaction",
      sourceOnly: !!options.sourceOnly,
      cases: observations.length,
      passed: observations.filter((r) => r.equal === true).length,
      failures,
      literalFailures: observations.flatMap((r) =>
        Object.entries(r.literal)
          .filter(([, v]) => !v.passed)
          .map(([kind, v]) => ({ id: r.id, kind, ...v })),
      ),
      nativeEvidence: observations
        .filter((r) => r.equal === true)
        .map((r) => r.id),
      qualifiedNativeEvidence: [],
      qualifications: [
        "Dense owned guard data; raw JS prototypes/getters/function reflection remain OPEN.",
        "Native timer adapter follows the actual Source subscribeWith absolute deadline boundary; arbitrary Ready/join/custom-executor scheduling is not claimed.",
        "The actor's existing static host-message/error boundary remains; pure compact data has no blanket Clone/serde/Send.",
        "Compact messages are supplied by the caller plain handler; no provider/defineAgent/router/children or malformed raw-at closure.",
        "Cold writer exits with an accepted compact handler pending after its state save; a new process loads and explicitly Boots. No graceful stop/awaited cleanup claim for the simulated crash.",
      ],
      identityLawProfiles: {
        readySame:
          "Only actual loaded State owners; true on fresh/null means no supplied model owner.",
        causeSame:
          "Tracked guard instances only. Manually injected late failures have no tracked guard instance; opaque original cause retention is separately executed in the native ownership test.",
      },
      binary: binary ? { path: binary, sha256: binaryHash } : null,
      sourceHashes: before,
      sourceUnchanged: true,
      processes,
      authoringGate: compactionAuthoringGate,
      observations,
    };
    fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
    if (!options.allowFailures) {
      assert.equal(failures.length, 0);
      assert.equal(report.literalFailures.length, 0);
    }
    return report;
  } catch (error) {
    fs.writeFileSync(
      `${out}.incomplete.json`,
      `${JSON.stringify({ status: "incomplete", active, error: { name: error.name, message: error.message, stack: error.stack }, sourceHashes: before, sourceUnchanged: JSON.stringify(hashes()) === JSON.stringify(before), processes, observations }, null, 2)}\n`,
    );
    throw error;
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2),
    get = (name) => {
      const i = args.indexOf(name);
      return i < 0 ? undefined : args[i + 1];
    };
  const r = agentCompactionParity({
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
