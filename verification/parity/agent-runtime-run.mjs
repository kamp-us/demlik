import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { agentRuntimeCases } from "./agent-runtime-cases.mjs";
import {
  assertCheckPath,
  cargoCheckEnvironment,
  checkedExecFileSync as execFileSync,
  checkedSpawnSync as spawnSync,
} from "./check-worktree.mjs";

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
      "crates/tea/examples/agent_runtime",
      "crates/tea/examples/agent_runtime_driver.rs",
      "packages/tea/src",
      "verification/parity/agent-runtime-cases.mjs",
      "verification/parity/agent-runtime-reference.mts",
      "verification/parity/agent-runtime-run.mjs",
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
export function runAgentRuntimeConformance(options = {}) {
  assert.equal(process.version, engine.node);
  assert.equal(process.versions.v8, engine.v8);
  const out = path.resolve(
    options.output ?? path.join(root, "target/parity/agent-runtime.json"),
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
      "agent_runtime_driver",
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
          r.target.name === "agent_runtime_driver" &&
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
    new Set(agentRuntimeCases.map((c) => c.id)).size,
    agentRuntimeCases.length,
  );
  const input = `${agentRuntimeCases
    .map((c) => JSON.stringify({ id: c.id, ...c.input }))
    .join("\n")}\n`;
  const tsx = require.resolve("tsx");
  const source = spawnSync(
    process.execPath,
    [
      "--import",
      tsx,
      path.join(root, "verification/parity/agent-runtime-reference.mts"),
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
  assert.equal(sourceRows.length, agentRuntimeCases.length);
  assert.equal(nativeRows.length, agentRuntimeCases.length);
  const cases = agentRuntimeCases.map((c, index) => {
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
  const result = runAgentRuntimeConformance({ binary, output });
  console.log(
    JSON.stringify({
      cases: result.cases,
      passed: result.passed,
      failures: result.failures.length,
    }),
  );
  if (result.failures.length) process.exitCode = 1;
}
