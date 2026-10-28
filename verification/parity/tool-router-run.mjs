import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { toolRouterCases } from "./tool-router-cases.mjs";
import { toolRouterEmptyCases } from "./tool-router-empty-cases.mjs";
import { toolRouterSameNameCases } from "./tool-router-same-name-cases.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url)),
  require = createRequire(import.meta.url),
  sha = (file) =>
    createHash("sha256").update(fs.readFileSync(file)).digest("hex");
export function toolRouterParity(options) {
  assert.equal(process.version, "v22.21.1");
  assert.equal(process.versions.v8, "12.4.254.21-node.33");
  const binary = path.resolve(options.binary),
    output = path.resolve(options.output),
    cases = [
      ...toolRouterCases,
      ...toolRouterEmptyCases,
      ...toolRouterSameNameCases,
    ];
  assert.equal(new Set(cases.map((c) => c.id)).size, 39);
  const binaryHash = sha(binary);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const processRecords = [];
  const sourceFiles = [
    "packages/tea/src/agent/tool.ts",
    "packages/tea/src/agent/tool-cell.ts",
    "packages/tea/src/pure/core.ts",
    "packages/tea/src/describe-error.ts",
    "packages/tea/src/agent/content.ts",
  ];
  const sourceHashes = Object.fromEntries(
    sourceFiles.map((f) => [f, sha(path.join(root, f))]),
  );
  const packageChanges = execFileSync(
    "git",
    [
      "diff",
      "--name-only",
      "75de37ea01a81cd7949e6275b7ee9cfdeb4e312d",
      "--",
      "packages/tea",
      "packages/code-graph",
    ],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(packageChanges, "");
  const run = (label, command, args, tests) => {
    const input = `${tests.map((c) => JSON.stringify(c)).join("\n")}\n`;
    const result = spawnSync(command, args, {
      cwd: root,
      input,
      encoding: "utf8",
      timeout: 45000,
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, TMPDIR: "/private/tmp" },
    });
    const stdout = `${output}.${label}.stdout`,
      stderr = `${output}.${label}.stderr`;
    fs.writeFileSync(stdout, result.stdout ?? "");
    fs.writeFileSync(stderr, result.stderr ?? "");
    processRecords.push({
      label,
      command: [command, ...args],
      status: result.status,
      signal: result.signal,
      error: result.error ? String(result.error) : null,
      stdout,
      stderr,
    });
    assert.equal(result.status, 0, `${label}: ${result.stderr}`);
    assert.equal(result.stderr, "");
    const rows = result.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(JSON.parse);
    assert.deepEqual(
      rows.map((r) => r.id),
      tests.map((c) => c.id),
    );
    return rows;
  };
  const source = [
    ...run(
      "source34",
      process.execPath,
      [
        "--import",
        require.resolve("tsx"),
        path.join(root, "verification/parity/tool-router-reference.mts"),
      ],
      toolRouterCases,
    ),
    ...run(
      "source-empty3",
      process.execPath,
      [
        "--import",
        require.resolve("tsx"),
        path.join(root, "verification/parity/tool-router-empty-reference.mts"),
      ],
      toolRouterEmptyCases,
    ),
    ...run(
      "source-same-name2",
      process.execPath,
      [
        "--import",
        require.resolve("tsx"),
        path.join(
          root,
          "verification/parity/tool-router-same-name-reference.mts",
        ),
      ],
      toolRouterSameNameCases,
    ),
  ];
  const native = run("native39", binary, [], cases),
    failures = [],
    nativeEvidence = {};
  for (let i = 0; i < cases.length; i++) {
    try {
      assert.deepEqual(
        native[i].view,
        source[i].view,
        "whole tool/router view",
      );
      assert.ok(
        Array.isArray(native[i].nativeTrace) &&
          native[i].nativeTrace.length > 0,
        "no actual public native calls",
      );
      nativeEvidence[cases[i].id] = native[i].nativeTrace;
    } catch (error) {
      failures.push({
        id: cases[i].id,
        input: cases[i].input,
        message: error.message,
        source: source[i],
        native: native[i],
      });
    }
  }
  assert.equal(
    sha(binary),
    binaryHash,
    "native executable changed during comparison",
  );
  const byId = (id) => source.find((r) => r.id === id).view;
  assert.equal(
    byId("tool-router.edge.read-transform").command.args.invoice,
    "INV-17",
  );
  assert.equal(
    byId("tool-router.edge.read-transform").returned.value.extra,
    "stripped",
  );
  assert.deepEqual(byId("tool-router.edge.read-transform").settled.value, {
    total: 15,
    currency: "USD",
  });
  assert.equal(byId("tool-router.edge.identity").own.returnedSame, true);
  assert.equal(byId("tool-router.edge.identity").own.argsSame, true);
  assert.equal(
    byId("tool-router.edge.declared-return").outcome.outcome.kind,
    "error",
  );
  assert.equal(
    byId("tool-router.edge.forged-pure-name").forged.outcome.result.total,
    99,
  );
  assert.deepEqual(byId("tool-router.empty.edge").defs, ["tool_rejected"]);
  assert.deepEqual(
    Object.fromEntries(sourceFiles.map((f) => [f, sha(path.join(root, f))])),
    sourceHashes,
  );
  const report = {
    scope:
      "tool declarations and finite heterogeneous router; Agent bridge and fan-out are outside this checkpoint",
    engine: { node: process.version, v8: process.versions.v8 },
    sourceHashes,
    binary,
    binaryHash,
    cases: 39,
    strictCases: 39,
    qualifiedCases: [],
    qualifiedNativeEvidence: {},
    failures,
    nativeEvidence,
    processRecords,
    rows: cases.map((test, i) => ({
      id: test.id,
      input: test.input,
      reference: source[i],
      native: native[i],
    })),
    sourceOnlyObservations: {
      ids: toolRouterSameNameCases.map((test) => test.id),
      profile:
        "Top-level JS command object identity is retained in raw Source frames; native ownership checks original args/error handles.",
      nativeCredit: 0,
    },
    newNativeOnlyCredit: 0,
  };
  fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  assert.equal(failures.length, 0, `${failures.length} tool/router failures`);
  return report;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const binary = process.argv[2],
    output = process.argv[3];
  assert.ok(
    binary && output,
    "tool-router-run requires actual binary and report path",
  );
  const report = toolRouterParity({ binary, output });
  console.log(
    JSON.stringify({
      cases: report.cases,
      failures: report.failures.length,
      binaryHash: report.binaryHash,
    }),
  );
}
