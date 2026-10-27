import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  agentErrorCases,
  defaultAgentJsonCases,
} from "./agent-error-cases.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url)),
  require = createRequire(import.meta.url),
  scope = JSON.parse(fs.readFileSync(new URL("scope.json", import.meta.url)));
const literals = JSON.parse(
  fs.readFileSync(new URL("./agent-error-expectations.json", import.meta.url)),
);
const sha = (b) => createHash("sha256").update(b).digest("hex");
function pin(binary, out, label) {
  const hash = sha(fs.readFileSync(binary)),
    copy = `${out}.${label}-${hash}.bin`;
  if (!fs.existsSync(copy)) fs.copyFileSync(binary, copy);
  assert.equal(sha(fs.readFileSync(copy)), hash);
  return { path: copy, sha256: hash };
}
export function agentErrorParity(options = {}) {
  assert.equal(process.version, scope.referenceEngine.node);
  assert.equal(process.versions.v8, scope.referenceEngine.v8);
  assert.ok(
    options.binary && options.coldBinary,
    "explicit actual-Cargo selected drivers required",
  );
  const output = path.resolve(
    options.output ?? path.join(root, "target/parity/agent-error.json"),
  );
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const binary = pin(options.binary, output, "pure"),
    coldBinary = pin(options.coldBinary, output, "cold"),
    rows = [],
    failures = [];
  const sources = [
    "crates/tea/src/agent/schema.rs",
    "crates/tea/src/agent/mod.rs",
    "packages/tea/src/agent/schema.ts",
    "packages/tea/src/describe-error.ts",
    "crates/tea/examples/agent_error_driver.rs",
    "crates/tea/examples/agent_error/default_cold.rs",
    "verification/parity/agent-error-cases.mjs",
    "verification/parity/agent-error-expectations.json",
  ];
  const hashes = () =>
      Object.fromEntries(
        sources.map((p) => [p, sha(fs.readFileSync(path.join(root, p)))]),
      ),
    before = hashes();
  const temporary = fs.mkdtempSync(
    path.join(root, "target/parity/agent-error-"),
  );
  const report = () => ({
    cases: rows.length,
    passed: rows.filter((r) => r.equal).length,
    failures,
    rows,
    unqualifiedPairs: rows.filter((r) => r.equal && !r.qualified).length,
    qualifiedPairs: rows.filter((r) => r.equal && r.qualified).length,
    nativeEvidence: Object.fromEntries(
      rows.filter((r) => r.equal && !r.qualified).map((r) => [r.id, r.calls]),
    ),
    qualifiedNativeEvidence: Object.fromEntries(
      rows.filter((r) => r.equal && r.qualified).map((r) => [r.id, r.calls]),
    ),
    binary,
    coldBinary,
    sourceHashes: before,
    engine: scope.referenceEngine,
    comparisonProfile:
      "Exact owned guard/plain JSON/description or cold state/work/cause view. Native-only rejected-root diagnostics are separately retained. Only four explicitly qualified cold rows exclude raw Error envelope/report labels, after checking delivery/count/phase category; raw objects remain retained; no universal JS reflection/Error identity or arbitrary migration claim.",
    qualifications: [
      "Pristine built-in guard Error only; custom live Error property mutation, prototypes/functions/getters/cycles remain unproved.",
      "Default cold State uses actually serializable fields and the actual GuardedSchema, not an app error union. Opaque model failures still require an explicit application family.",
      "Cold ready is commandless and explicit Boot resumes controlled before-effect checkpoints. No global exactly-once/SIGKILL/fsync or arbitrary scheduling claim.",
      "Original live root/cause identity is distinct from JSON-decoded plain data. No Error revival or cross-JSON alias identity.",
    ],
  });
  const save = () =>
    fs.writeFileSync(output, `${JSON.stringify(report(), null, 2)}\n`);
  function processCall(id, backend, mode, command, args, input) {
    const result = spawnSync(command, args, {
      cwd: root,
      input,
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 32 << 20,
    });
    const prefix = `${output}.${id}.${backend}.${mode}`;
    fs.writeFileSync(`${prefix}.stdout`, result.stdout ?? "");
    fs.writeFileSync(`${prefix}.stderr`, result.stderr ?? "");
    fs.writeFileSync(
      `${prefix}.process.json`,
      `${JSON.stringify({ command: [command, ...args], cwd: root, status: result.status, signal: result.signal, error: result.error ? String(result.error) : null }, null, 2)}\n`,
    );
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  }
  function projected(value, qualified) {
    const v = structuredClone(value.view);
    if (qualified) {
      delete v.reports;
      delete v.dispatchFailure;
    }
    for (const cause of [v.cause, v.ready.cause])
      if (cause) delete cause.nativeRejectedNull;
    return v;
  }
  try {
    for (const c of agentErrorCases.filter(
      (c) => !options.cases || options.cases.includes(`agent-error.${c.id}`),
    )) {
      const id = `agent-error.${c.id}`,
        row = { id, equal: false, kind: "pure" };
      rows.push(row);
      try {
        const input = `{"id":${JSON.stringify(id)},"operation":${JSON.stringify(c.operation)},"summary":${Boolean(c.summary)},"value":${c.json}}\n`;
        row.source = processCall(
          id,
          "source",
          "pure",
          process.execPath,
          [
            "--import",
            require.resolve("tsx"),
            path.join(root, "verification/parity/agent-error-reference.mts"),
          ],
          input,
        );
        row.native = processCall(id, "native", "pure", binary.path, [], input);
        const native = structuredClone(row.native.result);
        if (Object.hasOwn(native, "nativeRejectedSame")) {
          row.nativeRejectedSame = native.nativeRejectedSame;
          assert.equal(
            native.nativeRejectedSame,
            true,
            "native retains the original rejected root",
          );
          delete native.nativeRejectedSame;
        }
        row.calls = row.native.calls;
        assert.ok(row.calls.length);
        assert.equal(row.native.id, id);
        assert.deepEqual(native, row.source.result);
        for (const [field, value] of Object.entries(literals[c.id] ?? {})) {
          assert.deepEqual(
            native[field],
            value,
            `independent literal ${c.id}.${field}`,
          );
          assert.deepEqual(
            row.source.result[field],
            value,
            `Source literal ${c.id}.${field}`,
          );
        }
        if (c.id === "guard-null") {
          assert.deepEqual(native.wire, {});
          assert.equal(native.decodedKind, "plain");
          assert.equal(native.decodedDescription.value, "[object Object]");
        }
        if (c.id === "plain-message-shaped")
          assert.deepEqual(native.description, {
            ok: true,
            value: "[object Object]",
          });
        if (c.id === "plain-coercion-fails")
          assert.deepEqual(native.description, {
            ok: false,
            name: "TypeError",
            message: "Cannot convert object to primitive value",
          });
        row.equal = true;
      } catch (error) {
        row.error = String(error);
        failures.push({ id, error: String(error) });
      }
      save();
    }
    for (const c of defaultAgentJsonCases.filter(
      (c) => !options.cases || options.cases.includes(c.id),
    )) {
      const row = {
        id: c.id,
        equal: false,
        kind: "cold",
        qualified: c.input.checkpoint !== "guard-error",
        qualification:
          c.input.checkpoint !== "guard-error"
            ? "OPEN host diagnostic representation: Source save/follow-up versus native StoreFailed/FollowUp. Original raw labels retained; rejection delivery, report cardinality/phase category, state/work/cause and exact JSON bytes asserted."
            : null,
      };
      rows.push(row);
      const directory = path.join(temporary, c.id);
      fs.mkdirSync(directory);
      try {
        row.source = {};
        row.native = {};
        for (const backend of ["source", "native"]) {
          for (const mode of ["writer", "reader"]) {
            if (mode === "writer") {
              for (const name of fs.readdirSync(directory))
                fs.rmSync(path.join(directory, name), {
                  recursive: true,
                  force: true,
                });
            }
            row[backend][mode] = processCall(
              c.id,
              backend,
              mode,
              backend === "source" ? process.execPath : coldBinary.path,
              backend === "source"
                ? [
                    "--import",
                    require.resolve("tsx"),
                    path.join(
                      root,
                      "verification/parity/agent-error-default-json-reference.mts",
                    ),
                  ]
                : [],
              `${JSON.stringify({ id: c.id, ...c.input, mode, directory })}\n`,
            );
          }
        }
        row.calls = [
          ...new Set([...row.native.writer.calls, ...row.native.reader.calls]),
        ];
        assert.ok(row.calls.length);
        for (const mode of ["writer", "reader"]) {
          const n = row.native[mode].view,
            s = row.source[mode].view;
          assert.equal(
            n.dispatchFailure !== null,
            s.dispatchFailure !== null,
            "same dispatch rejection delivery",
          );
          assert.equal(
            n.reports.length,
            s.reports.length,
            "same error-sink delivery count",
          );
          const nativeCategory = n.reports.map(([name, phase]) => [
            name === "StoreFailed" ? "save" : name,
            phase === "FollowUp" ? "follow-up" : phase,
          ]);
          assert.deepEqual(
            nativeCategory,
            s.reports,
            "same report failure and phase category",
          );
          if (mode === "writer") {
            assert.equal(
              n.dispatchFailure !== null,
              c.input.checkpoint === "brain",
            );
            assert.equal(
              n.reports.length,
              c.input.checkpoint === "tools" ? 1 : 0,
            );
          } else {
            assert.equal(n.dispatchFailure, null);
            assert.deepEqual(n.reports, []);
          }
          assert.deepEqual(
            projected(row.native[mode], row.qualified),
            projected(row.source[mode], row.qualified),
          );
          assert.equal(
            row.native[mode].wireText,
            row.source[mode].wireText,
            "exact default-family JSON bytes",
          );
        }
        const w = row.native.writer.view,
          r = row.native.reader.view;
        assert.equal(r.ready.loadedSame, true);
        assert.equal(r.ready.modelCalls, 0);
        assert.equal(r.ready.toolCalls, 0);
        assert.equal(r.settled, true);
        if (c.input.checkpoint === "guard-error") {
          assert.equal(w.cause.kind, "live");
          assert.equal(w.cause.nativeRejectedNull, true);
          assert.equal(r.ready.cause.kind, "plain");
          assert.equal(r.ready.cause.description, "[object Object]");
          assert.equal(
            r.ready.cause.reason,
            "structured-output parse failed: not an AgentTurn",
          );
          assert.deepEqual(r.wire.failure.error.error, {});
          assert.equal(r.modelCalls, 0);
          assert.equal(r.toolCalls, 0);
        } else {
          assert.equal(w.cut, true);
          assert.equal(r.toolCalls, 1);
          assert.equal(r.wire.output.content, "Invoice total confirmed: 15");
        }
        if (c.input.checkpoint === "tools") {
          assert.equal(r.decodedCommandSame, true);
          assert.equal(r.decodedRecordSame, true);
        }
        row.equal = true;
      } catch (error) {
        row.error = String(error);
        failures.push({ id: c.id, error: String(error) });
      }
      save();
    }
    assert.deepEqual(hashes(), before);
    assert.equal(sha(fs.readFileSync(binary.path)), binary.sha256);
    assert.equal(sha(fs.readFileSync(coldBinary.path)), coldBinary.sha256);
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
  let binary, coldBinary, output, cases;
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--binary") binary = args[++i];
    else if (args[i] === "--cold-binary") coldBinary = args[++i];
    else if (args[i] === "--output") output = args[++i];
    else if (args[i] === "--cases") cases = args[++i].split(",");
    else throw new Error(`unknown ${args[i]}`);
  }
  const report = agentErrorParity({ binary, coldBinary, output, cases });
  console.log(
    JSON.stringify({
      cases: report.cases,
      passed: report.passed,
      failures: report.failures,
    }),
  );
  if (report.failures.length) process.exitCode = 1;
}
