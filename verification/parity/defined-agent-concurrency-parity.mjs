import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildTeaExample } from "./tea-example.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const hash = (file) =>
  createHash("sha256").update(fs.readFileSync(file)).digest("hex");
export function definedAgentConcurrencyParity(cargo, options = {}) {
  assert.equal(process.version, "v22.21.1");
  assert.equal(process.versions.v8, "12.4.254.21-node.33");
  for (const key of [
    "CARGO_TARGET_DIR",
    "DEMLIK_MUTATION_TARGET_DIR",
    "CARGO_BUILD_TARGET_DIR",
    "CARGO_BUILD_BUILD_DIR",
  ])
    assert.equal(process.env[key], undefined, key);
  assert.equal(
    options.binary,
    undefined,
    "execute the actual Cargo-selected consumer snapshot",
  );
  execFileSync(
    "git",
    [
      "diff",
      "--exit-code",
      "75de37ea01a81cd7949e6275b7ee9cfdeb4e312d",
      "--",
      "packages/tea/src",
      "packages/tea/package.json",
    ],
    { cwd: root },
  );
  assert.equal(
    execFileSync(
      "git",
      ["ls-files", "--others", "--exclude-standard", "--", "packages/tea/src"],
      { cwd: root, encoding: "utf8" },
    ),
    "",
  );
  fs.mkdirSync(path.join(root, "target/parity"), { recursive: true });
  const proof = fs.mkdtempSync(
    path.join(root, "target/parity/defined-agent-concurrency-"),
  );
  function execute(name, command, args, stderr = "") {
    const r = spawnSync(command, args, {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      timeout: 120000,
    });
    for (const stream of ["stdout", "stderr"])
      fs.writeFileSync(path.join(proof, `${name}.${stream}`), r[stream] ?? "");
    fs.writeFileSync(
      path.join(proof, `${name}.process.json`),
      JSON.stringify(
        {
          command: [command, ...args],
          status: r.status,
          exit: r.status,
          signal: r.signal,
          error: r.error?.message ?? null,
        },
        null,
        2,
      ),
    );
    assert.equal(r.status, 0, `${name}: ${r.stderr}`);
    assert.equal(r.signal, null);
    if (typeof stderr === "string") assert.equal(r.stderr, stderr);
    else assert.match(r.stderr, stderr);
    return r.stdout;
  }
  const source = execute("source", process.execPath, [
    "--import",
    path.join(root, "verification/parity/node_modules/tsx/dist/loader.mjs"),
    path.join(root, "verification/parity/defined-agent-concurrency-source.mts"),
  ]);
  const producer = buildTeaExample(
    cargo,
    "defined_agent_concurrency",
    path.join(proof, "producer"),
  );
  const native = execute("native", producer.binary, []);
  const rows = (text) => text.trim().split("\n").map(JSON.parse);
  const expected = rows(source),
    actual = rows(native);
  assert.equal(expected.length, 6);
  assert.equal(actual.length, 6);
  const results = [],
    nativeEvidence = {};
  for (const [i, row] of expected.entries()) {
    const candidate = actual[i];
    assert.equal(candidate.id, row.id);
    const { nativeTrace, ...phase } = candidate.phase;
    assert.deepEqual(nativeTrace, [
      "demlik_tea::agent::DefineAgentConfig::new",
      ...(row.id === "unset"
        ? []
        : ["demlik_tea::agent::DefineAgentConfig::tool_concurrency"]),
      "demlik_tea::agent::define_agent",
      row.id === "raw"
        ? "demlik_tea::agent::DefinedAgent::machine"
        : "demlik_tea::agent::DefinedAgent::run",
    ]);
    assert.deepEqual(
      phase,
      row.phase,
      `${row.id}: full raw phase, including every saved JSON string`,
    );
    assert.equal(phase.maxActive, ["unset", "one"].includes(row.id) ? 1 : 2);
    assert.equal(phase.calls, 2);
    const id = `tea.defined-agent-concurrency.${row.id}`;
    nativeEvidence[id] = nativeTrace;
    results.push({
      id,
      passed: true,
      qualifiedPassed: false,
      maxActive: phase.maxActive,
      calls: phase.calls,
      saves: phase.saves.length,
    });
  }
  const stopped = rows(
    execute(
      "stop",
      producer.binary,
      ["--stop"],
      /^@demlik\/tea: Discard: RuntimeDiscardedError\n@demlik\/tea: Discard: DispatchDiscardedError\n@demlik\/tea: Discard: DispatchDiscardedError\n$/,
    ),
  );
  assert.equal(stopped.length, 1);
  assert.equal(stopped[0].id, "stop");
  assert.deepEqual(stopped[0].phase.log, [
    "start:0",
    "start:1",
    "end:1",
    "end:0",
  ]);
  assert.equal(stopped[0].phase.maxActive, 2);
  assert.equal(stopped[0].phase.calls, 1);
  assert.deepEqual(stopped[0].phase.settlements, []);
  assert.equal(hash(producer.binary), producer.binarySha256);
  const report = {
    status: "passed",
    reference: "75de37ea01a81cd7949e6275b7ee9cfdeb4e312d",
    engine: { node: process.version, v8: process.versions.v8 },
    sourceProductTree: execFileSync(
      "git",
      [
        "rev-parse",
        "75de37ea01a81cd7949e6275b7ee9cfdeb4e312d:packages/tea/src",
      ],
      { cwd: root, encoding: "utf8" },
    ).trim(),
    authoredSourceSha256: hash(
      path.join(
        root,
        "verification/parity/defined-agent-concurrency-source.mts",
      ),
    ),
    nativeOwnerSha256: hash(path.join(root, "crates/tea/src/agent/defined.rs")),
    nativeConsumerSha256: hash(
      path.join(root, "crates/tea/examples/defined_agent_concurrency.rs"),
    ),
    cases: 6,
    passed: 6,
    qualifiedPassed: 0,
    failures: [],
    nativeEvidence,
    qualifiedNativeEvidence: {},
    rows: results,
    results,
    producer,
    executionBinary: producer.binary,
    rustBinarySha256: producer.binarySha256,
    binaryAfterSha256: hash(producer.binary),
    libraryAfterSha256: Object.fromEntries(
      Object.entries(producer.libraries).map(([name, library]) => {
        const after = hash(library.path);
        assert.equal(after, library.sha256);
        return [name, after];
      }),
    ),
    rawRecords: { proof },
    proof,
    qualifications: [],
    limitations: [
      "Controlled async gates and fixed logical clock; no wall-clock speed claim.",
      "No per-tool timeout/retry, signal, streaming, children, overlay, or compaction credit.",
      "Native no-host tools retain original raw turn cursor, result Rc and nested Rc; JavaScript retains raw argument and result object identity.",
    ],
    nativeLifecycle: { stopWhileFollowerWaits: true, lateMessagesDiscarded: 3 },
    globalParityCreditAdded: 0,
  };
  fs.writeFileSync(
    path.join(proof, "report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  if (options.reportFile)
    fs.writeFileSync(
      path.resolve(options.reportFile),
      `${JSON.stringify(report, null, 2)}\n`,
    );
  return report;
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  console.log(
    JSON.stringify(definedAgentConcurrencyParity(process.env.CARGO ?? "cargo")),
  );
