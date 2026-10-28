import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { agentRoutedCases } from "./agent-routed-cases.mjs";
import { agentRoutedParity, compareRoutedView } from "./agent-routed-run.mjs";
import { assertCheckPath } from "./check-worktree.mjs";
import { buildTeaExample } from "./tea-example.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const sourcePins = {
  "packages/tea/src/agent/index.ts":
    "28edeb15977cf7008576574ee8589715272784f1feef260f36b70242da922d65",
  "packages/tea/src/agent/tool.ts":
    "56f6eea269084931535a9df469f75cc9a7368bbdb2dd4b24137030fd67252175",
  "packages/tea/src/agent/tool-cell.ts":
    "e27d7dbe68a1bfce9405e7849f60c545e3cc425ac761aaaa54f2a1fdae07fbfc",
};
const frozenSourceViews = {
  "agent-routed.promise.invoice":
    "e5c189ea910f7fc4f648abd305f9aca755c7fc5625b547b023f28817000d7943",
  "agent-routed.promise.declared":
    "63df762c6c1cac17142c29ad3d8b64095c2a404f5e8cd78e917b835696353744",
  "agent-routed.promise.thrown":
    "9f9a29da62470295c5f10e7e0e875fa5c5b6e00f3196cf3ebd2f28be4cdd78cc",
  "agent-routed.promise.rejected":
    "6c594e4352ba1751e26f9c26f9739fe568b9d7af3932bfd4bd604074ec4e6d13",
  "agent-routed.promise.malformed-args":
    "13da312b968fa1985c9c385c19963685c2c50eeda7eba5dc54df0c9fb9658ae2",
  "agent-routed.promise.bad-result":
    "207d6753e605d6be224f71c274f91bac00f9992b485507a78664c487d3fa734c",
  "agent-routed.promise.selected-B":
    "61ef276e47f030f6e50b45ee75c856a6eb8d0e69f5ee3487b8ab884fb0cf5b6c",
  "agent-routed.promise.cold-pending":
    "019afbc28579faa94a68a487d4b6bd535fd61267431420f1bb2db03bb6ebcc50",
  "agent-routed.promise.cancel-late":
    "8b9d82f5458ddc6cbf91e248591c3619a222689954a0043a391f86fd91d496fb",
  "agent-routed.promise.map-refusal":
    "ac0445764f71bf2e7d59b41d7f49260b6439c0c63bbc97e700b122af7881dee1",
  "agent-routed.effect.invoice":
    "e5c189ea910f7fc4f648abd305f9aca755c7fc5625b547b023f28817000d7943",
  "agent-routed.effect.declared":
    "63df762c6c1cac17142c29ad3d8b64095c2a404f5e8cd78e917b835696353744",
  "agent-routed.effect.thrown":
    "9f9a29da62470295c5f10e7e0e875fa5c5b6e00f3196cf3ebd2f28be4cdd78cc",
  "agent-routed.effect.rejected":
    "6c594e4352ba1751e26f9c26f9739fe568b9d7af3932bfd4bd604074ec4e6d13",
  "agent-routed.effect.malformed-args":
    "13da312b968fa1985c9c385c19963685c2c50eeda7eba5dc54df0c9fb9658ae2",
  "agent-routed.effect.bad-result":
    "207d6753e605d6be224f71c274f91bac00f9992b485507a78664c487d3fa734c",
  "agent-routed.effect.selected-B":
    "61ef276e47f030f6e50b45ee75c856a6eb8d0e69f5ee3487b8ab884fb0cf5b6c",
  "agent-routed.effect.cold-pending":
    "019afbc28579faa94a68a487d4b6bd535fd61267431420f1bb2db03bb6ebcc50",
  "agent-routed.effect.cancel-late":
    "8b9d82f5458ddc6cbf91e248591c3619a222689954a0043a391f86fd91d496fb",
  "agent-routed.effect.map-refusal":
    "ac0445764f71bf2e7d59b41d7f49260b6439c0c63bbc97e700b122af7881dee1",
};
const digest = /^[a-f0-9]{64}$/;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fileHash = (file) => hash(fs.readFileSync(file));
const qualified = (fixture) =>
  fixture.scenario === "cold-pending" || fixture.scenario === "map-refusal";

export function agentRoutedCheckpointParity(cargo, options = {}) {
  const reportFile = path.resolve(
    options.reportFile ?? path.join(root, "target/parity/agent-routed.json"),
  );
  let binary = options.binary;
  let producer = null;
  if (!binary) {
    for (const key of [
      "CARGO_TARGET_DIR",
      "DEMLIK_MUTATION_TARGET_DIR",
      "CARGO_BUILD_TARGET_DIR",
      "CARGO_BUILD_BUILD_DIR",
    ])
      assert.equal(process.env[key], undefined, `${key} must be unset`);
    producer = buildTeaExample(cargo, "agent_routed_driver", reportFile);
    assertCheckPath(producer.actualArtifact, path.join(root, "target"));
    assertCheckPath(
      producer.libraries.demlik_tea.path,
      path.join(root, "target"),
    );
    binary = producer.binary;
  }
  const raw = agentRoutedParity({ binary, output: `${reportFile}.raw.json` });
  const report = normalizeAgentRoutedReport(raw, producer);
  report.binaryOverride = producer
    ? null
    : { path: path.resolve(binary), sha256: raw.binaryHash, supplied: true };
  fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

function viewDigest(value) {
  const ordered = (input) =>
    Array.isArray(input)
      ? input.map(ordered)
      : input !== null && typeof input === "object"
        ? Object.fromEntries(
            Object.keys(input)
              .sort()
              .map((key) => [key, ordered(input[key])]),
          )
        : input;
  return hash(JSON.stringify(ordered(value)));
}

function processFrame(record, side, savedSource) {
  assert.equal(savedSource ? record.exit : record.status, 0);
  assert.equal(record.signal ?? null, null);
  assert.equal(record.error ?? null, null);
  assert.ok(path.isAbsolute(record.stdout) && path.isAbsolute(record.stderr));
  assert.equal(fs.readFileSync(record.stderr, "utf8"), "");
  const frames = fs
    .readFileSync(record.stdout, "utf8")
    .split("\n")
    .filter(Boolean)
    .map(JSON.parse);
  assert.equal(frames.length, 1, `${record.input.id}: one actual response`);
  const frame = frames[0];
  assert.equal(frame.id, record.input.id);
  assert.equal(frame.ok, true);
  assert.ok(Array.isArray(record.command));
  if (side === "source") {
    assert.equal(record.command.length, 4);
    assert.equal(path.basename(record.command[0]), "node");
    assert.equal(record.command[1], "--import");
    assert.equal(
      path.basename(record.command[3]),
      "agent-routed-reference.mts",
    );
  } else assert.equal(record.command.length, 1);
  if (!savedSource) assert.equal(record.label, `${side}.${frame.id}`);
  return frame;
}

export function normalizeAgentRoutedReport(raw, producer = null) {
  assert.equal(agentRoutedCases.length, 20);
  assert.equal(raw.cases, 20);
  assert.equal(raw.passed, 16);
  assert.equal(raw.qualifiedPassed, 4);
  assert.deepEqual(raw.failures, []);
  assert.deepEqual(raw.Source, sourcePins);
  assert.deepEqual(raw.sourceAfter, sourcePins);
  for (const [file, expected] of Object.entries(sourcePins))
    assert.equal(fileHash(path.join(root, file)), expected);
  const engine = JSON.parse(
    fs.readFileSync(path.join(root, "verification/parity/scope.json"), "utf8"),
  ).referenceEngine;
  assert.deepEqual(engine, { node: "v22.21.1", v8: "12.4.254.21-node.33" });
  assert.match(raw.binaryHash, digest);
  assert.equal(raw.binaryHashAfter, raw.binaryHash);
  assert.deepEqual(
    raw.observations.map((row) => row.id),
    agentRoutedCases.map((row) => row.id),
  );
  const strictIds = agentRoutedCases
    .filter((row) => !qualified(row))
    .map((row) => row.id);
  const qualifiedIds = agentRoutedCases.filter(qualified).map((row) => row.id);
  assert.deepEqual(Object.keys(raw.nativeEvidence), strictIds);
  assert.deepEqual(Object.keys(raw.qualifiedNativeEvidence), qualifiedIds);
  const sourceCode = fs.readFileSync(
    path.join(root, "crates/tea/examples/agent_routed_driver.rs"),
    "utf8",
  );
  const allowedCalls = new Set(
    [
      ...sourceCode.matchAll(
        /observe!\(\s*[^,]+,\s*([A-Za-z_][A-Za-z0-9_:]+)\s*[,)]/g,
      ),
    ].map((match) => match[1]),
  );
  assert.ok(allowedCalls.size);
  let saved = null;
  if (raw.sourceReport) {
    assert.equal(fileHash(raw.sourceReport.path), raw.sourceReport.sha256);
    saved = JSON.parse(fs.readFileSync(raw.sourceReport.path, "utf8"));
    assert.equal(saved.Source, "75de37ea01a81cd7949e6275b7ee9cfdeb4e312d");
    assert.deepEqual(saved.engine, engine);
    assert.equal(saved.complete, true);
    assert.deepEqual(
      saved.rows.map((row) => row.id),
      agentRoutedCases.map((row) => row.id),
    );
  } else
    assert.deepEqual(
      { node: process.version, v8: process.versions.v8 },
      engine,
    );
  assert.equal(raw.processes.length, saved ? 22 : 44);
  if (saved) assert.equal(saved.processes.length, 22);
  const processes = new Map();
  const nativePaths = new Set();
  const sourceRecords = saved
    ? saved.processes
    : raw.processes.filter((row) => row.label.startsWith("source."));
  const nativeRecords = raw.processes.filter((row) =>
    row.label.startsWith("native."),
  );
  assert.equal(nativeRecords.length, 22);
  assert.equal(sourceRecords.length, 22);
  for (const [side, records] of [
    ["source", sourceRecords],
    ["native", nativeRecords],
  ]) {
    for (const record of records) {
      const frame = processFrame(
        record,
        side,
        side === "source" && saved !== null,
      );
      if (side === "source" && !saved)
        assert.equal(record.command[0], process.execPath);
      if (side === "native") nativePaths.add(record.command[0]);
      const key = `${side}.${record.input.id}`;
      assert.ok(!processes.has(key), `duplicate process ${key}`);
      processes.set(key, { record, frame });
    }
  }
  const nativeEvidence = {},
    qualifiedNativeEvidence = {};
  for (const [index, fixture] of agentRoutedCases.entries()) {
    const row = raw.observations[index];
    assert.deepEqual(row.input, fixture);
    assert.equal(row.equal, true);
    const phases =
      fixture.scenario === "cold-pending" ? ["writer", "reader"] : ["run"];
    assert.deepEqual(Object.keys(row.rawSource), phases);
    assert.deepEqual(Object.keys(row.rawNative), phases);
    if (saved) {
      assert.deepEqual(saved.rows[index].input, fixture);
      assert.deepEqual(
        row.rawSource,
        phases.length === 1
          ? { run: saved.rows[index].source }
          : saved.rows[index].source,
      );
    }
    const view = (frames) =>
      phases.length === 1
        ? frames.run.view
        : Object.fromEntries(
            phases.map((phase) => [phase, frames[phase].view]),
          );
    assert.deepEqual(row.source, view(row.rawSource));
    assert.deepEqual(row.native, view(row.rawNative));
    const qualification = compareRoutedView(fixture, row.source, row.native);
    assert.deepEqual(row.qualification, qualification);
    assert.equal(qualification !== null, qualified(fixture));
    const sourceView = structuredClone(row.source);
    if (qualification) {
      const item =
        fixture.scenario === "cold-pending" ? sourceView.writer : sourceView;
      for (const diagnostic of item.diagnostics) delete diagnostic.error.stack;
    }
    assert.equal(
      viewDigest(sourceView),
      frozenSourceViews[fixture.id],
      `${fixture.id}: frozen Source view`,
    );
    const calls = row.rawNative[phases[0]].observedCalls;
    assert.ok(Array.isArray(calls) && calls.length);
    for (const call of calls)
      assert.ok(
        allowedCalls.has(call),
        `${fixture.id}: unobserved call ${call}`,
      );
    if (qualification)
      assert.deepEqual(raw.qualifiedNativeEvidence[fixture.id], {
        calls,
        qualification,
      });
    else assert.deepEqual(raw.nativeEvidence[fixture.id], calls);
    (qualification ? qualifiedNativeEvidence : nativeEvidence)[fixture.id] =
      calls;
    const directories = { source: new Set(), native: new Set() };
    for (const phase of phases) {
      const id = phase === "run" ? fixture.id : `${fixture.id}.${phase}`;
      for (const side of ["source", "native"]) {
        const key = `${side}.${id}`,
          observed = processes.get(key);
        assert.ok(observed, `missing actual process ${key}`);
        processes.delete(key);
        const { directory, ...input } = observed.record.input;
        assert.ok(path.isAbsolute(directory));
        directories[side].add(directory);
        assert.deepEqual(
          input,
          phase === "run" ? fixture : { ...fixture, id, mode: phase },
        );
        assert.deepEqual(
          observed.frame,
          (side === "source" ? row.rawSource : row.rawNative)[phase],
          `${key}: actual response/log mismatch`,
        );
      }
      const frame = row.rawNative[phase];
      assert.deepEqual(frame.observedCalls, calls);
      assert.ok(
        Number.isSafeInteger(frame.nativeOwnershipChecks) &&
          frame.nativeOwnershipChecks >= 0,
      );
      if (phase !== "writer" && fixture.scenario !== "map-refusal")
        assert.ok(
          frame.nativeOwnershipChecks > 0,
          `${id}: nonvacuous owner receipts`,
        );
    }
    assert.equal(directories.source.size, 1);
    assert.equal(directories.native.size, 1);
  }
  assert.equal(processes.size, 0);
  assert.equal(nativePaths.size, 1);
  const binary = [...nativePaths][0];
  assert.ok(path.isAbsolute(binary));
  if (fs.existsSync(binary)) assert.equal(fileHash(binary), raw.binaryHash);
  if (producer) {
    assert.equal(producer.binary, binary);
    assert.equal(producer.binarySha256, raw.binaryHash);
    assert.equal(fileHash(producer.binary), raw.binaryHash);
    assert.equal(fileHash(producer.actualArtifact), raw.binaryHash);
    assertCheckPath(producer.actualArtifact, path.join(root, "target"));
    assert.equal(fileHash(producer.cargoJson), producer.cargoJsonSha256);
    assert.equal(
      producer.source.path,
      path.join(root, "crates/tea/examples/agent_routed_driver.rs"),
    );
    assert.equal(fileHash(producer.source.path), producer.source.sha256);
    const library = producer.libraries.demlik_tea;
    assertCheckPath(library.path, path.join(root, "target"));
    assert.equal(fileHash(library.path), library.sha256);
  }
  return {
    ...raw,
    observations: 20,
    passed: 16,
    qualifiedPassed: 4,
    qualifiedEvidenceCases: 4,
    failures: [],
    nativeEvidence,
    qualifiedNativeEvidence,
    engine,
    sourceProcessRecords: sourceRecords,
    nativeProcessRecords: nativeRecords,
    binary,
    raw,
    producer,
    profile: {
      ownershipNotApplicable: [
        "cold writer before a tool settles",
        "map-refusal before a tool settles",
      ],
      pendingOnlyCodec: true,
      reporterEnvelopeEquivalence: "OPEN",
      Node26ProvisionalCredit: 0,
      newComparisonCredit: 0,
    },
  };
}
