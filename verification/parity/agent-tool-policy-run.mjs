import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  toolPolicyCases,
  toolPolicyColdCases,
  toolPolicyRuntimeCases,
} from "./agent-tool-policy-cases.mjs";

const root = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../..",
  ),
  require = createRequire(import.meta.url),
  sha = (p) => createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const sourceFiles = [
  "packages/tea/src/agent/index.ts",
  "packages/tea/src/agent/types.ts",
  "packages/tea/src/agent/tool-resilience.ts",
  "packages/tea/src/internal/resilience/resilient-call/index.ts",
  "packages/tea/src/retry-backoff/index.ts",
];
export function agentToolPolicyParity(options = {}) {
  assert.equal(process.version, "v22.21.1");
  assert.equal(process.versions.v8, "12.4.254.21-node.33");
  const binary = path.resolve(options.binary),
    runtimeBinary = path.resolve(
      options.runtimeBinary ??
        path.join(path.dirname(binary), "agent_tool_policy_runtime_driver"),
    );
  const output = path.resolve(
    options.output ?? path.join(root, "target/parity/agent-tool-policy.json"),
  );
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const hashes = () =>
      Object.fromEntries(sourceFiles.map((f) => [f, sha(path.join(root, f))])),
    before = hashes();
  const binaryHashes = {
    [binary]: sha(binary),
    ...(!options.pureOnly ? { [runtimeBinary]: sha(runtimeBinary) } : {}),
  };
  const rows = [],
    processes = [],
    nativeEvidence = {},
    qualifiedNativeEvidence = {};
  const pure = toolPolicyCases.filter(
      (c) => !options.onlyId || c.id === options.onlyId,
    ),
    runtime = options.pureOnly
      ? []
      : toolPolicyRuntimeCases.filter(
          (c) => !options.onlyId || c.id === options.onlyId,
        ),
    cold = options.pureOnly
      ? []
      : toolPolicyColdCases.filter(
          (c) => !options.onlyId || c.id === options.onlyId,
        );
  function invoke(kind, c, phase, input, rt) {
    const id = phase ? `${c.id}.${phase}` : c.id;
    const prefix = `${output}.${id}.${kind}`;
    const command = kind === "source" ? "pnpm" : rt ? runtimeBinary : binary;
    const args =
      kind === "source"
        ? [
            "exec",
            "node",
            "--import",
            require.resolve("tsx"),
            path.join(
              root,
              `verification/parity/agent-tool-policy-${rt ? "runtime-reference.mts" : "reference.mts"}`,
            ),
          ]
        : [];
    const r = spawnSync(command, args, {
      cwd: root,
      input: JSON.stringify({ id, input }) + "\n",
      encoding: "utf8",
      timeout: 15000,
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, TMPDIR: "/private/tmp" },
    });
    fs.writeFileSync(prefix + ".stdout", r.stdout ?? "");
    fs.writeFileSync(prefix + ".stderr", r.stderr ?? "");
    const record = {
      id,
      caseId: c.id,
      phase,
      kind,
      command,
      args,
      input,
      status: r.status,
      signal: r.signal,
      error: r.error ? { message: r.error.message, code: r.error.code } : null,
      stdout: prefix + ".stdout",
      stderr: prefix + ".stderr",
      binarySha256: kind === "native" ? binaryHashes[command] : null,
    };
    processes.push(record);
    assert.equal(r.status, 0, `${id} ${kind} process failure: ${r.stderr}`);
    const responses = (r.stdout ?? "")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    assert.equal(responses.length, 1, `${id} ${kind} response count`);
    assert.equal(responses[0].id, id, `${id} ${kind} response identity`);
    assert.ok(responses[0].view, `${id} ${kind} missing view`);
    return responses[0];
  }
  function compare(c, source, native) {
    const qualifications = c.qualifications ?? [];
    let same = true,
      diff;
    try {
      assert.deepStrictEqual(native.view, source.view);
    } catch (e) {
      same = false;
      diff = e.message;
    }
    rows.push({ id: c.id, same, qualifications, source, native, diff });
    if (same) {
      assert.ok(Array.isArray(native.nativeTrace));
      const target = qualifications.length
        ? qualifiedNativeEvidence
        : nativeEvidence;
      target[c.id] = native.nativeTrace;
    }
  }
  try {
    for (const c of pure)
      compare(
        c,
        invoke("source", c, null, c.input, false),
        invoke("native", c, null, c.input, false),
      );
    for (const c of runtime) {
      const folders = ["source", "native"].map((kind) =>
        fs.mkdtempSync(path.join("/private/tmp", `demlik-policy-${kind}-`)),
      );
      try {
        compare(
          c,
          invoke("source", c, null, { ...c.input, path: folders[0] }, true),
          invoke("native", c, null, { ...c.input, path: folders[1] }, true),
        );
      } finally {
        for (const f of folders) fs.rmSync(f, { recursive: true, force: true });
      }
    }
    for (const c of cold) {
      const folders = ["source", "native"].map((kind) =>
        fs.mkdtempSync(
          path.join("/private/tmp", `demlik-policy-cold-${kind}-`),
        ),
      );
      try {
        const values = ["source", "native"].map((kind, i) => {
          const writer = invoke(
              kind,
              c,
              "writer",
              { ...c.input, mode: "writer", path: folders[i] },
              true,
            ),
            reader = invoke(
              kind,
              c,
              "reader",
              { ...c.input, mode: "reader", path: folders[i] },
              true,
            );
          return {
            view: { writer: writer.view, reader: reader.view },
            nativeTrace:
              kind === "native"
                ? [...writer.nativeTrace, ...reader.nativeTrace]
                : undefined,
          };
        });
        compare(c, values[0], values[1]);
      } finally {
        for (const f of folders) fs.rmSync(f, { recursive: true, force: true });
      }
    }
  } catch (error) {
    rows.push({
      id: null,
      same: false,
      protocolOrProcessFailure: true,
      error: error.message,
    });
  }
  assert.deepStrictEqual(hashes(), before, "frozen Source changed");
  const report = {
    engine: { node: process.version, v8: process.versions.v8 },
    sourceHashes: before,
    binaryHashes,
    cases: rows.filter((r) => r.id !== null).length,
    passed: rows.filter((r) => r.same).length,
    failed: rows.filter((r) => !r.same).length,
    strictPassed: rows.filter((r) => r.same && r.qualifications.length === 0)
      .length,
    qualifiedPassed: rows.filter((r) => r.same && r.qualifications.length > 0)
      .length,
    knownOpen: [
      "8 pre-existing uncoordinated runtime scheduling observations",
      "manual missing/null message stamps",
      "raw prototype/getter/mutable function profiles",
      "opaque TE enabled policies remain outside the initial PlainData profile",
      "public agentEvents projector remains outside this checkpoint",
    ],
    observations: rows,
    processes,
    nativeEvidence,
    qualifiedNativeEvidence,
  };
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
  return report;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const get = (k) => {
    const at = process.argv.indexOf(k);
    return at < 0 ? undefined : process.argv[at + 1];
  };
  const r = agentToolPolicyParity({
    binary: get("--binary"),
    runtimeBinary: get("--runtime-binary"),
    output: get("--output"),
    onlyId: get("--only-id"),
    pureOnly: process.argv.includes("--pure-only"),
  });
  console.log(
    JSON.stringify({
      cases: r.cases,
      passed: r.passed,
      failed: r.failed,
      strict: r.strictPassed,
      qualified: r.qualifiedPassed,
    }),
  );
  if (r.failed) process.exitCode = 1;
}
