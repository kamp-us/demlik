import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { toolParsedInputCases as cases } from "./tool-parsed-input-cases.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const require = createRequire(import.meta.url);
const sha = (file) =>
  createHash("sha256").update(fs.readFileSync(file)).digest("hex");
export function toolParsedInputParity({ binary, output }) {
  assert.equal(process.version, "v22.21.1");
  assert.equal(process.versions.v8, "12.4.254.21-node.33");
  assert.equal(cases.length, 6);
  assert.equal(new Set(cases.map((c) => c.id)).size, 6);
  const sourceFiles = [
    "packages/tea/src/agent/tool.ts",
    "packages/tea/src/agent/tool-cell.ts",
    "packages/tea/src/pure/core.ts",
  ];
  const sourceHashes = Object.fromEntries(
    sourceFiles.map((f) => [f, sha(path.join(root, f))]),
  );
  const binaryHash = binary ? sha(binary) : null;
  const processRecords = [];
  const run = (label, command, args) => {
    const r = spawnSync(command, args, {
      cwd: root,
      input: `${cases.map((c) => JSON.stringify(c)).join("\n")}\n`,
      encoding: "utf8",
      timeout: 45000,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, TMPDIR: "/private/tmp" },
    });
    const stdout = `${output}.${label}.stdout`,
      stderr = `${output}.${label}.stderr`;
    fs.writeFileSync(stdout, r.stdout ?? "");
    fs.writeFileSync(stderr, r.stderr ?? "");
    processRecords.push({
      label,
      command: [command, ...args],
      status: r.status,
      signal: r.signal,
      error: r.error ? String(r.error) : null,
      stdout,
      stderr,
    });
    assert.equal(r.status, 0, `${label}: ${r.stderr}`);
    assert.equal(r.stderr, "");
    const rows = r.stdout.trim().split("\n").filter(Boolean).map(JSON.parse);
    assert.deepEqual(
      rows.map((r) => r.id),
      cases.map((c) => c.id),
    );
    return rows;
  };
  fs.mkdirSync(path.dirname(output), { recursive: true });
  try {
    const source = run("source6", process.execPath, [
      "--import",
      require.resolve("tsx"),
      path.join(root, "verification/parity/tool-parsed-input-reference.mts"),
    ]);
    for (const row of source) {
      assert.equal(row.view.inputCalls, 0);
      assert.equal(row.view.command.callId, "direct-17");
      assert.equal(row.view.command.args.invoice, "already-parsed");
      assert.equal(row.view.messages.length, 1);
      assert.equal(row.view.messages[0].own.argsSame, true);
      assert.equal(row.view.schemasSame, true);
      assert.equal(row.sourceOnly.commandObjectSame, true);
      assert.ok(row.view.trace.every((value) => !value.startsWith("input:")));
    }
    const byId = (suffix) => source.find((r) => r.id.endsWith(suffix)).view;
    assert.equal(byId("edge.identity").messages[0].own.resultSame, true);
    assert.equal(byId("edge.error").messages[0].own.errorSame, true);
    assert.deepEqual(byId("edge.selected-ok").messages[0].message.value, {
      total: 120,
      parser: "B",
    });
    assert.equal(
      byId("edge.selected-error").messages[0].message.error._tag,
      "b_only",
    );
    assert.deepEqual(byId("runtime.promise").trace, [
      "handler:B:already-parsed:host",
      "output:B",
    ]);
    assert.deepEqual(byId("runtime.effect").trace, [
      "handler:B:already-parsed:host",
    ]);
    const native = binary ? run("native6", path.resolve(binary), []) : null;
    const failures = [],
      nativeEvidence = {};
    if (native)
      for (let i = 0; i < cases.length; i++) {
        try {
          assert.deepEqual(
            native[i].view,
            source[i].view,
            "whole direct tool construction view",
          );
          assert.ok(
            Array.isArray(native[i].nativeTrace) &&
              native[i].nativeTrace.length > 0,
          );
          nativeEvidence[cases[i].id] = native[i].nativeTrace;
        } catch (error) {
          failures.push({
            id: cases[i].id,
            message: error.message,
            reference: source[i],
            native: native[i],
          });
        }
      }
    assert.deepEqual(
      Object.fromEntries(sourceFiles.map((f) => [f, sha(path.join(root, f))])),
      sourceHashes,
    );
    if (binary) assert.equal(sha(binary), binaryHash);
    const report = {
      sourceOnly: !binary,
      sourceObservations: 6,
      engine: { node: process.version, v8: process.versions.v8 },
      sourceHashes,
      binary: binary ? path.resolve(binary) : null,
      binaryHash,
      cases: binary ? 6 : 0,
      strictCases: binary ? 6 : 0,
      failures,
      qualifiedCases: [],
      nativeEvidence,
      qualifiedNativeEvidence: {},
      sourceOnlyCommandIdentityNativeCredit: 0,
      processRecords,
      rows: cases.map((test, i) => ({
        ...test,
        reference: source[i],
        native: native?.[i] ?? null,
      })),
    };
    fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
    return report;
  } catch (error) {
    fs.writeFileSync(
      output,
      `${JSON.stringify(
        {
          sourceOnly: !binary,
          failure: error.message,
          processRecords,
          sourceHashes,
          binaryHash,
        },
        null,
        2,
      )}\n`,
    );
    throw error;
  }
}
