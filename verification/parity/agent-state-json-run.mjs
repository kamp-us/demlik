import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { agentStateJsonCases } from "./agent-state-json-cases.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url)),
  require = createRequire(import.meta.url),
  hash = (b) => createHash("sha256").update(b).digest("hex");
const scope = JSON.parse(
    fs.readFileSync(new URL("./scope.json", import.meta.url)),
  ),
  engine = scope.referenceEngine;
function sources() {
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
      "crates/tea/examples/agent_state_json_driver.rs",
      "packages/tea/src",
      "verification/parity/agent-state-json-cases.mjs",
      "verification/parity/agent-state-json-reference.mts",
      "verification/parity/agent-state-json-run.mjs",
    ],
    { cwd: root, encoding: "utf8" },
  )
    .split("\0")
    .filter(Boolean);
  return Object.fromEntries(
    files.sort().map((f) => [f, hash(fs.readFileSync(path.join(root, f)))]),
  );
}
function expected(c, source, native) {
  const { checkpoint } = c.input;
  for (const whole of [source, native]) {
    const w = whole.writer.view,
      r = whole.reader.view;
    assert.equal(r.ready.loadedSame, true);
    assert.equal(r.ready.modelCalls, 0);
    assert.equal(r.ready.toolCalls, 0);
    assert.deepEqual(
      r.ready.wire,
      w.wire,
      "fresh decoder sees exact checkpoint JSON facts",
    );
    for (const v of [w, r]) {
      assert.equal(v.savedSame, true);
      assert.equal(v.schemaSame, true);
    }
    const counts = {
      brain: [0, 0, 5, 2],
      tools: [1, 0, 4, 2],
      "tool-error": [1, 1, 4, 1],
      done: [5, 2, 0, 0],
      "model-error": [1, 0, 0, 0],
      "guard-error": [1, 0, 0, 0],
    }[checkpoint];
    assert.deepEqual(
      [w.modelCalls, w.toolCalls, r.modelCalls, r.toolCalls],
      counts,
    );
    assert.equal(w.cut, ["brain", "tools", "tool-error"].includes(checkpoint));
    assert.equal(r.cut, false);
    assert.equal(r.settled, true);
    if (["model-error", "guard-error"].includes(checkpoint)) {
      const reason =
        checkpoint === "model-error"
          ? "invoice model rejected"
          : "structured-output parse failed: not an AgentTurn";
      assert.equal(w.cause.originalSame, true);
      assert.equal(
        w.cause.kind,
        checkpoint === "model-error" ? "live-model" : "live-guard",
      );
      assert.equal(r.ready.cause.kind, "plain-data");
      assert.equal(r.ready.cause.originalSame, false);
      assert.deepEqual(r.ready.cause.value, {});
      for (const v of [w, r]) {
        assert.equal(v.wire.failure.error.reason, reason);
        assert.deepEqual(v.wire.failure.error.error, {});
        assert.deepEqual(v.wire.resilience.calls.collect.error.error, {});
        assert.equal(v.wire.failure.reason, "llm");
      }
    } else {
      assert.equal(r.wire.run.phase, "done");
      assert.equal(
        r.wire.output.content,
        checkpoint === "tool-error"
          ? "Invoice requires review"
          : "Invoice total confirmed: 15",
      );
    }
    if (checkpoint === "tools") {
      assert.equal(r.decodedCommandSame, true);
      assert.equal(r.decodedRecordSame, true);
      const call = r.ready.wire.tools.running[0];
      assert.deepEqual(call.unknownCall, { ordinal: 1 });
      assert.equal(call.args.unknownArg, "kept");
      assert.deepEqual(call.args.__proto__, { args: true });
      assert.ok(!Object.hasOwn(call.args, "unknownUndefined"));
    }
    if (checkpoint === "tool-error")
      assert.deepEqual(w.wire.conversation.toolRecords[0].outcome, {
        kind: "error",
        reason: "invoice total mismatch",
      });
  }
}
export function runAgentStateJson(options = {}) {
  assert.equal(process.version, engine.node);
  assert.equal(process.versions.v8, engine.v8);
  assert.ok(
    options.binary,
    "explicit actual-Cargo selected --binary required; wrapper never builds",
  );
  const out = path.resolve(
    options.output ?? path.join(root, "target/parity/agent-state-json.json"),
  );
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const before = sources(),
    binaryHash = hash(fs.readFileSync(options.binary)),
    binary = `${out}.native-${binaryHash}.bin`;
  if (fs.existsSync(binary))
    assert.equal(hash(fs.readFileSync(binary)), binaryHash);
  else fs.copyFileSync(options.binary, binary);
  fs.chmodSync(binary, 0o755);
  const selected = options.cases
    ? agentStateJsonCases.filter((c) => options.cases.includes(c.id))
    : agentStateJsonCases;
  assert.ok(selected.length);
  assert.equal(new Set(selected.map((c) => c.id)).size, selected.length);
  if (options.cases) assert.equal(selected.length, options.cases.length);
  fs.mkdirSync(path.join(root, "target/parity"), { recursive: true });
  const temporary = fs.mkdtempSync(
      path.join(root, "target/parity/agent-state-json-"),
    ),
    rows = [],
    failures = [];
  const tsx = require.resolve("tsx");
  const report = () => ({
    cases: rows.length,
    passed: rows.filter((r) => r.equal).length,
    failures,
    nativeEvidence: Object.fromEntries(
      rows
        .filter((r) => r.equal)
        .map((r) => [
          r.id,
          [...new Set([...r.native.writer.calls, ...r.native.reader.calls])],
        ]),
    ),
    reference: scope.reference,
    engine,
    sourceHashes: before,
    binary: { path: binary, sha256: binaryHash },
    rows,
    qualifications: [
      "Actual application-owned Model/Guard/Data cause codec, actual built-in guard, file stores and agent/runtime. This does not implement serde for default GuardedSchema::Error.",
      "Caller migrate accepts only same-version authored checkpoints; Source checks the outer carrier and native uses its conditional typed decoder. No arbitrary restored-shape validation equivalence.",
      "Fresh writer/reader processes, finite injected clocks and controlled post-save refusal. No SIGKILL, power-loss or arbitrary scheduling claim.",
      "Original live Error/cause/root identity is distinct from new JSON-decoded data. Error nested wire{} loses name/message/stack/rejected-turn details; the outer reason remains.",
      "Unknown dense raw turn/call/args/provider data is preserved where JSON supports it. Undefined object fields disappear, shared aliases are duplicated by JSON. No universal JS heap/error/reflection codec.",
    ],
    openGaps: [
      "Default GuardedSchema AgentState Serialize/Deserialize E0277 remainsOPEN; previous actual reds are inherited, never rebuilt by this suite.",
      "Default error-owner live/decoded API decision remains separate.",
      "Existing raw stamp, panic, advanced provider/router/child/compaction/policy profiles remainOPEN.",
    ],
  });
  const save = () =>
    fs.writeFileSync(out, `${JSON.stringify(report(), null, 2)}\n`);
  function phase(c, backend, mode, directory) {
    const request = { id: c.id, ...c.input, mode, directory };
    const command = backend === "source" ? process.execPath : binary,
      args =
        backend === "source"
          ? [
              "--import",
              tsx,
              path.join(
                root,
                "verification/parity/agent-state-json-reference.mts",
              ),
            ]
          : [];
    const run = spawnSync(command, args, {
      cwd: root,
      input: JSON.stringify(request),
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      timeout: 30000,
    });
    const p = `${out}.${c.id}.${backend}.${mode}`;
    for (const [suffix, body] of [
      ["stdout", run.stdout ?? ""],
      ["stderr", run.stderr ?? ""],
    ])
      fs.writeFileSync(`${p}.${suffix}`, body);
    fs.writeFileSync(
      `${p}.process.json`,
      `${JSON.stringify({ command, args, request, exit: run.status, signal: run.signal, error: run.error ? String(run.error) : null }, null, 2)}\n`,
    );
    assert.ifError(run.error);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.signal, null);
    const raw = JSON.parse(run.stdout);
    assert.equal(raw.id, c.id);
    assert.ok(raw.view && raw.wireText);
    assert.deepEqual(JSON.parse(raw.wireText), raw.view.wire);
    if (backend === "native") {
      assert.ok(Array.isArray(raw.calls));
      for (const name of [
        "demlik_tea::agent::Agent::to_machine",
        "demlik_tea::file_store::file_store",
        "demlik_tea::storage::Store::load",
        "demlik_tea::storage::Store::save",
        "demlik_tea::storage::Store::migrate",
      ])
        assert.ok(raw.calls.includes(name), name);
      if (mode === "reader")
        assert.ok(raw.calls.includes("demlik_tea::agent::agent_boot_msg"));
    }
    assert.equal(
      fs.readFileSync(path.join(directory, "state.json"), "utf8"),
      raw.wireText,
      "printed checkpoint is actual stored bytes",
    );
    return raw;
  }
  try {
    for (const c of selected) {
      const row = { ...c, equal: false };
      rows.push(row);
      let kind = "protocol";
      try {
        const base = path.join(temporary, c.id);
        fs.mkdirSync(base);
        for (const backend of ["source", "native"]) {
          const directory = path.join(base, backend);
          fs.mkdirSync(directory);
          row[backend] = {
            writer: phase(c, backend, "writer", directory),
            reader: phase(c, backend, "reader", directory),
          };
        }
        kind = "semantic";
        assert.deepEqual(row.native.writer.view, row.source.writer.view);
        assert.deepEqual(row.native.reader.view, row.source.reader.view);
        expected(c, row.source, row.native);
        assert.equal(
          row.native.writer.wireText,
          row.source.writer.wireText,
          "exact writer JSON checkpoint bytes",
        );
        assert.equal(
          row.native.reader.wireText,
          row.source.reader.wireText,
          "exact reader JSON checkpoint bytes",
        );
        row.equal = true;
        row.writerWireBytesEqual =
          row.native.writer.wireText === row.source.writer.wireText;
        row.readerWireBytesEqual =
          row.native.reader.wireText === row.source.reader.wireText;
      } catch (e) {
        row.error = String(e);
        failures.push({ id: c.id, kind, error: String(e) });
      }
      save();
    }
    assert.deepEqual(
      sources(),
      before,
      "all source frozen through process comparisons",
    );
    assert.equal(hash(fs.readFileSync(binary)), binaryHash);
    save();
    return report();
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  let binary, output, cases;
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    if (a[i] === "--binary") binary = a[++i];
    else if (a[i] === "--output") output = a[++i];
    else if (a[i] === "--cases") cases = a[++i].split(",");
    else throw new Error(`unknown ${a[i]}`);
  }
  const r = runAgentStateJson({ binary, output, cases });
  console.log(
    JSON.stringify({
      cases: r.cases,
      passed: r.passed,
      failures: r.failures.length,
    }),
  );
  if (r.failures.length) process.exitCode = 1;
}
