import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { agentTurnCases } from "./agent-turn-cases.mjs";
import { assertCheckPath, cargoCheckEnvironment } from "./check-worktree.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url)),
  require = createRequire(import.meta.url),
  hash = (value) => createHash("sha256").update(value).digest("hex");
const engine = JSON.parse(
  fs.readFileSync(new URL("./scope.json", import.meta.url)),
).referenceEngine;
function sourceHashes() {
  const files = execFileSync(
    "git",
    [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
      "--",
      "Cargo.toml",
      "Cargo.lock",
      "crates/tea/Cargo.toml",
      "crates/tea/src",
      "crates/tea/examples/agent_turn",
      "crates/tea/examples/agent_turn_driver.rs",
      "crates/tea/tests/agent_turn_owners.rs",
      "packages/tea/src",
      "verification/parity/agent-turn-cases.mjs",
      "verification/parity/agent-turn-reference.mts",
      "verification/parity/agent-turn-run.mjs",
      "verification/parity/check-worktree.mjs",
      "verification/parity/scope.json",
    ],
    { cwd: root, encoding: "utf8" },
  )
    .split("\0")
    .filter(Boolean);
  return Object.fromEntries(
    files
      .sort()
      .map((file) => [file, hash(fs.readFileSync(path.join(root, file)))]),
  );
}
function assertExpected(input, view) {
  assert.equal(view.savedSame, true);
  assert.equal(view.schemaSame, true);
  for (const [key, value] of Object.entries(view.ownership))
    assert.equal(value, true, key);
  for (const codec of view.codecs) {
    assert.equal(codec.recordRoundTrip, true);
    assert.equal(codec.conversationRoundTrip, true);
    assert.equal(codec.decodedCallUndefined, "missing");
    if (input.turnMode !== "bare") {
      assert.ok(Object.hasOwn(codec.record.call, "unknownCall"));
      assert.ok(Object.hasOwn(codec.record.call, "__proto__"));
      assert.ok(Object.hasOwn(codec.conversation.turns[0], "unknownTurn"));
    }
  }
  for (const selection of view.selections)
    assert.deepEqual(selection.slice(1), ["first", "invoice.json"]);
  const { scenario, turnMode } = input;
  const more = ["usage-missing", "usage-undefined"].includes(turnMode);
  if (scenario === "fresh-boot") {
    assert.equal(view.state.phase, "idle");
    assert.equal(view.modelCalls, 0);
    assert.equal(view.toolCalls, 0);
  } else if (
    ["model-error", "parse-error", "retry-exhaust"].includes(scenario)
  ) {
    assert.equal(view.state.failure, "llm");
    assert.equal(view.state.causeSame, true);
    assert.equal(view.doneSame, true);
    assert.equal(
      view.state.failureReason,
      scenario === "parse-error"
        ? "structured-output parse failed: not an AgentTurn"
        : "invoice model rejected",
    );
    assert.equal(view.toolCalls, 0);
    assert.equal(view.modelCalls, scenario === "retry-exhaust" ? 2 : 1);
  } else if (["tool-io-error", "restart-tool-io-error"].includes(scenario)) {
    assert.equal(view.state.phase, "running");
    assert.equal(view.state.awaiting, "tools");
    if (scenario === "restart-tool-io-error")
      assert.ok(view.dispatchFailures.includes("tool-io"));
    else assert.ok(view.reports.some((row) => row[1] === "tool-io"));
    assert.equal(view.toolCalls, 1);
  } else if (["cancel", "late-tool-fail"].includes(scenario)) {
    assert.equal(view.state.phase, "cancelled");
    assert.equal(view.modelCalls, 1);
    assert.equal(view.toolCalls, 1);
    assert.deepEqual(view.state.records, []);
    assert.equal(view.state.output, null);
  } else if (scenario === "deadline") {
    assert.equal(view.state.phase, "failed");
    assert.equal(view.modelCalls, 1);
    assert.equal(view.toolCalls, 1);
  } else {
    assert.equal(view.state.phase, "done");
    assert.equal(
      view.state.output,
      scenario === "bad-total"
        ? "Invoice requires review"
        : "Invoice total confirmed: 15",
    );
    assert.equal(
      view.modelCalls,
      (more ? 6 : 5) + (scenario === "retry-once" ? 1 : 0),
    );
    assert.equal(view.toolCalls, more ? 3 : 2);
    assert.equal(view.codecs.length, more ? 3 : 2);
    if (["usage-missing", "usage-undefined", "usage-totals"].includes(turnMode))
      assert.deepEqual(view.state.usage, {
        inputTokens: 15,
        outputTokens: 5,
        reasoningTokens: 3,
        cachedInputTokens: 4,
      });
    else
      assert.deepEqual(view.state.usage, { inputTokens: 0, outputTokens: 0 });
    if (more) {
      assert.ok(
        view.usageReadings.some(
          (r) => r[1] === "collect" && r[2] === "tools" && r[4] === 9,
        ),
      );
      assert.ok(
        view.usageReadings.some(
          (r) => r[1] === "collect" && r[2] === "tools" && r[4] === null,
        ),
      );
      assert.ok(
        view.rawTurns.some(
          (r) =>
            r.usage ===
            (turnMode === "usage-missing" ? "missing" : "undefined"),
        ),
      );
    }
    if (turnMode === "presence")
      assert.deepEqual(
        view.rawTurns.slice(0, 3).map((r) => r.provider),
        ["missing", "undefined", "null"],
      );
    if (turnMode === "array-args")
      assert.ok(view.codecs.every((c) => Array.isArray(c.record.call.args)));
  }
  if (scenario.startsWith("restart") || scenario === "terminal-boot") {
    assert.equal(view.restart.loadedSame, true);
    assert.equal(view.restart.newModelCallsAtReady, 0);
    assert.equal(view.restart.newToolCallsAtReady, 0);
  }
  if (["retry-once", "retry-exhaust"].includes(scenario))
    assert.equal(view.requestReused, true);
}

export function runAgentTurnConformance(options = {}) {
  assert.equal(process.version, engine.node);
  assert.equal(process.versions.v8, engine.v8);
  const out = path.resolve(
    options.output ?? path.join(root, "target/parity/agent-turn.json"),
  );
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const before = sourceHashes();
  let binary = options.binary,
    producer = null;
  if (!binary) {
    const env = cargoCheckEnvironment();
    for (const key of [
      "CARGO_TARGET_DIR",
      "CARGO_BUILD_TARGET",
      "CARGO_BUILD_TARGET_DIR",
      "CARGO_BUILD_BUILD_DIR",
      "CARGO_TARGET_TMPDIR",
      "RUSTC_WRAPPER",
      "RUSTC_WORKSPACE_WRAPPER",
      "RUSTFLAGS",
      "CARGO_ENCODED_RUSTFLAGS",
    ])
      delete env[key];
    const command = [
      "build",
      "--locked",
      "--offline",
      "-p",
      "demlik-tea",
      "--example",
      "agent_turn_driver",
      "--message-format=json",
    ];
    const built = spawnSync(process.env.CARGO ?? "cargo", command, {
      cwd: root,
      env,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
    fs.writeFileSync(`${out}.cargo.jsonl`, built.stdout ?? "");
    fs.writeFileSync(`${out}.cargo.stderr`, built.stderr ?? "");
    assert.ifError(built.error);
    assert.equal(built.status, 0, built.stderr);
    const rows = built.stdout
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
      executables = rows.filter(
        (r) =>
          r.reason === "compiler-artifact" &&
          r.target.name === "agent_turn_driver" &&
          r.executable,
      ),
      libraries = rows.filter(
        (r) =>
          r.reason === "compiler-artifact" &&
          r.target.name === "demlik_tea" &&
          r.target.kind.includes("lib"),
      );
    assert.equal(executables.length, 1);
    assert.equal(libraries.length, 1);
    for (const artifact of [executables[0], libraries[0]]) {
      assertCheckPath(artifact.target.src_path, root);
      assertCheckPath(artifact.manifest_path, root);
    }
    binary = assertCheckPath(
      executables[0].executable,
      path.join(root, "target"),
    );
    const libraryFiles = libraries[0].filenames.filter((file) =>
      file.endsWith(".rlib"),
    );
    assert.equal(libraryFiles.length, 1);
    const libraryPath = assertCheckPath(
      libraryFiles[0],
      path.join(root, "target"),
    );
    producer = {
      command,
      library: libraries[0],
      executable: executables[0],
      libraryPath,
      librarySha256: hash(fs.readFileSync(libraryPath)),
    };
  }
  const binaryHash = hash(fs.readFileSync(binary));
  const immutable = `${out}.native-${binaryHash}.bin`;
  if (fs.existsSync(immutable))
    assert.equal(hash(fs.readFileSync(immutable)), binaryHash);
  else fs.copyFileSync(binary, immutable);
  fs.chmodSync(immutable, 0o755);
  assert.equal(hash(fs.readFileSync(binary)), hash(fs.readFileSync(immutable)));
  assert.equal(
    new Set(agentTurnCases.map((c) => c.id)).size,
    agentTurnCases.length,
  );
  const input = `${agentTurnCases
    .map((c) => JSON.stringify({ id: c.id, ...c.input }))
    .join("\n")}\n`;
  const tsx = require.resolve("tsx");
  const source = spawnSync(
    process.execPath,
    [
      "--import",
      tsx,
      path.join(root, "verification/parity/agent-turn-reference.mts"),
    ],
    {
      cwd: root,
      input,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      timeout: 90000,
    },
  );
  const native = spawnSync(immutable, [], {
    cwd: root,
    input,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: 90000,
  });
  for (const [name, run] of [
    ["source", source],
    ["native", native],
  ]) {
    fs.writeFileSync(`${out}.${name}.stdout`, run.stdout ?? "");
    fs.writeFileSync(`${out}.${name}.stderr`, run.stderr ?? "");
    fs.writeFileSync(
      `${out}.${name}.process.json`,
      `${JSON.stringify({ exit: run.status, signal: run.signal, error: run.error ? String(run.error) : null }, null, 2)}\n`,
    );
    assert.ifError(run.error);
    assert.equal(run.status, 0, run.stderr);
  }
  const sourceRows = source.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line)),
    nativeRows = native.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  assert.equal(sourceRows.length, agentTurnCases.length);
  assert.equal(nativeRows.length, agentTurnCases.length);
  const cases = agentTurnCases.map((c, index) => {
    const native = nativeRows[index],
      source = sourceRows[index];
    assert.equal(native.id, c.id);
    assert.equal(source.id, c.id);
    assert.ok(
      Array.isArray(native.calls) &&
        native.calls.includes("demlik_tea::agent::Agent::to_machine"),
    );
    let equal = true,
      error = null;
    try {
      assert.deepEqual(native.view, source.view);
      assertExpected(c.input, source.view);
      assertExpected(c.input, native.view);
    } catch (e) {
      equal = false;
      error = String(e);
    }
    return { ...c, equal, error, source, native };
  });
  const report = {
    cases: cases.length,
    passed: cases.filter((c) => c.equal).length,
    failures: cases
      .filter((c) => !c.equal)
      .map((c) => ({ id: c.id, error: c.error })),
    nativeEvidence: Object.fromEntries(
      cases.filter((c) => c.equal).map((c) => [c.id, c.native.calls]),
    ),
    reference: JSON.parse(
      fs.readFileSync(new URL("./scope.json", import.meta.url)),
    ).reference,
    engine,
    producer,
    sourceHashes: before,
    binary: { path: immutable, sha256: hash(fs.readFileSync(immutable)) },
    qualifications: [
      "Default GuardedSchema executes inside an application-owned error-union parser; the configured parser handle and original raw output are retained. Native concrete representation remains a separate unchanged consumer. Dense owned PlainData does not model arbitrary prototype getters, sparse/named arrays, functions or mutable JS heap graphs.",
      "Strict equality is the declared view; original source diagnostics are retained. No universal Error/stack/platform diagnostics equivalence.",
      "Source toMachine Promise brain handler is adapted into actual Effect declared channels; no new retry/settlement implementation.",
      "Controlled deadline host uses Source subscribeWith and native canonical Timer; not a new default-Date.now timing claim.",
      "Cancellation is explicitly dispatched by the bare tool before background registration. No held-call preemption or arbitrary-executor ordering claim.",
      "Restart retains actual in-process state references at a persisted-before-effect failure window; no process-kill/durable codec claim.",
    ],
    openGaps: [
      "OPEN measured Source accepts null/omitted at in manual settlements; native wiring refuses them observably (including valid nonfinite→JSON-null restore).",
      "OPEN native panic versus JS catches; native callback throw/error decoration, mutable function/prototype/thenable profiles are not universal JS equivalence.",
      "reserved raw tag collisions/reflection",
      "OPEN full default AgentState codec: StructuredOutputError has no Serialize/Deserialize. Only record/conversation codecs and retained in-process state are proved here.",
      "OPEN advanced router/concurrency/children/provider/compaction/snapshot/tool-policy profiles and inherited callable/type aliases; no broad alias closure.",
      "OPEN malformed restored subscription profile: Source missing-compaction throws TypeError, native retains typed UnsupportedRestoredProfile and fails ready.",
      "Owned deadline callback requires static message/cause and host-error family; borrowed services/state-only Stage construction is proved locally, actor launch requires owned static lifetime.",
    ],
    rows: cases,
  };
  assert.deepEqual(
    sourceHashes(),
    before,
    "Source/native inputs stay frozen through build and comparison",
  );
  fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const args = process.argv.slice(2);
  let binary, output;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--binary") binary = args[++i];
    else if (args[i] === "--output") output = args[++i];
    else throw new Error(`unknown argument ${args[i]}`);
  }
  const result = runAgentTurnConformance({ binary, output });
  console.log(
    JSON.stringify({
      cases: result.cases,
      passed: result.passed,
      failures: result.failures.length,
    }),
  );
  if (result.failures.length) process.exitCode = 1;
}
