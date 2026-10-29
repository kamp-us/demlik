import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  checkedExecFileSync as execFileSync,
  checkedSpawnSync as spawnSync,
} from "./check-worktree.mjs";

import { buildParityBinary } from "./tea-example.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const require = createRequire(import.meta.url);
export async function resilientCallParity(cargo, options = {}) {
  const scope = JSON.parse(
    await readFile(path.join(here, "scope.json"), "utf8"),
  );
  assert.equal(process.version, scope.referenceEngine.node);
  assert.equal(process.versions.v8, scope.referenceEngine.v8);
  const reportFile =
    options.reportFile ?? path.join(root, "target/parity/resilient-call.json");
  const producer = options.binary
    ? null
    : buildParityBinary(cargo, "resilient-call-parity", reportFile);
  const binary = options.binary ?? producer.binary;
  const driverDiagnostics = [];
  const corpus = JSON.parse(
    await readFile(path.join(here, "resilient-call-cases.json"), "utf8"),
  );
  assert.equal(corpus.version, 1);
  const cases = corpus.cases;
  assert.equal(new Set(cases.map((test) => test.id)).size, cases.length);
  const input = `${cases.map((test) => JSON.stringify({ id: test.id, operation: test.operation, input: test.input })).join("\n")}\n`;
  function run(command, args, inputText = input) {
    const result = spawnSync(command, args, {
      cwd: root,
      input: inputText,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, `driver failed: ${result.stderr}`);
    if (result.stderr)
      driverDiagnostics.push({
        language: command === binary ? "Rust" : "TypeScript",
        stderr: result.stderr,
      });
    return result.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  }

  const reference = run(process.execPath, [
    "--import",
    require.resolve("tsx"),
    path.join(here, "resilient-call-reference.mts"),
  ]);
  const native = run(binary, []);
  const refusals = [
    { id: "refuse.input", input: [] },
    { id: "refuse.actions", input: { actions: 4 } },
    { id: "refuse.config", input: { config: [], actions: [] } },
    {
      id: "refuse.retry-curve",
      input: { config: { retry: { maxAttempts: 2 } }, actions: [] },
    },
    {
      id: "refuse.retry-bound",
      input: {
        config: { retry: { baseMs: 1, factor: 2, capMs: 8, jitter: "none" } },
        actions: [],
      },
    },
    { id: "refuse.circuit", input: { config: { circuit: {} }, actions: [] } },
    { id: "refuse.cache", input: { config: { cache: {} }, actions: [] } },
    {
      id: "refuse.rate",
      input: { config: { rateLimit: { capacity: 2 } }, actions: [] },
    },
    { id: "refuse.deadline", input: { config: { deadline: {} }, actions: [] } },
    { id: "refuse.action", input: { actions: [{ op: "unsupported" }] } },
    {
      id: "refuse.clock",
      input: { actions: [{ op: "inspect", at: "tomorrow" }] },
    },
  ];
  const refusalInput = `${refusals.map((value) => JSON.stringify(value)).join("\n")}\n`;
  for (const responses of [
    run(
      process.execPath,
      [
        "--import",
        require.resolve("tsx"),
        path.join(here, "resilient-call-reference.mts"),
      ],
      refusalInput,
    ),
    run(binary, [], refusalInput),
  ]) {
    assert.equal(responses.length, refusals.length);
    responses.forEach((response, index) => {
      assert.equal(response.ok, false, refusals[index].id);
    });
  }
  assert.equal(reference.length, cases.length);
  assert.equal(native.length, cases.length);
  const failures = [];
  for (let index = 0; index < cases.length; index++) {
    const test = cases[index];
    try {
      for (const [language, response] of [
        ["TypeScript", reference[index]],
        ["Rust", native[index]],
      ]) {
        assert.equal(response.id, test.id, `${language} response order`);
        assert.equal(
          response.ok,
          true,
          `${language}: ${JSON.stringify(response.error)}`,
        );
        if (Object.hasOwn(test, "expected"))
          assert.deepEqual(
            response.output,
            test.expected,
            `${language} independent expected result`,
          );
        for (const [key, value] of Object.entries(test.expect ?? {}))
          assert.deepEqual(
            response.output[key],
            value,
            `${language} independent ${key}`,
          );
      }
      assert.deepEqual(
        native[index].output,
        reference[index].output,
        "cross-language resilient-call result",
      );
    } catch (error) {
      failures.push({
        id: test.id,
        operation: test.operation,
        input: test.input,
        message: error.message,
        reference: reference[index],
        native: native[index],
      });
    }
  }
  const report = {
    producer,
    scope: "native composed resilient-call; full port remains incomplete",
    reference: scope.reference,
    referenceChanges: execFileSync(
      "git",
      [
        "diff",
        "--name-only",
        scope.reference,
        "--",
        "packages/tea",
        "packages/code-graph",
      ],
      { cwd: root, encoding: "utf8" },
    )
      .trim()
      .split("\n")
      .filter(Boolean),
    node: process.version,
    v8: process.versions.v8,
    platform: process.platform,
    architecture: process.arch,
    cases: cases.length,
    protocolRefusals: refusals.length,
    passed: cases.length - failures.length,
    failures,
    nativeEvidence: Object.fromEntries(
      cases.map((test, index) => [
        test.id,
        failures.some((failure) => failure.id === test.id)
          ? []
          : (native[index].observedCalls ?? []),
      ]),
    ),
    binarySha256: createHash("sha256")
      .update(await readFile(binary))
      .digest("hex"),
    driverDiagnostics,
    qualifications: [
      "Factory names use the shared UTF-8 tag interface; keys and generic payload data retain UTF-16.",
      "This is pure native composition and a typed engine outcome bridge, with no new async executor or schema runtime.",
      "Record projection codecs are called only for raw/projected values; typed stored cache values need no serde or Clone bound.",
    ],
  };
  await mkdir(path.dirname(reportFile), { recursive: true });
  await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  return { ...report, reportFile };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const args = process.argv.slice(2);
  const option = (name) => {
    const index = args.indexOf(name);
    return index < 0 ? undefined : path.resolve(args[index + 1]);
  };
  const report = await resilientCallParity(process.env.CARGO ?? "cargo", {
    binary: option("--rust-bin"),
    reportFile: option("--report"),
  });
  process.stdout.write(
    `${JSON.stringify({ ...report, nativeEvidence: { cases: Object.keys(report.nativeEvidence).length }, failures: report.failures.map(({ id, message }) => ({ id, message: message.split("\n").slice(0, 4).join("\n") })), failureCount: report.failures.length }, null, 2)}\n`,
  );
  if (report.failures.length) process.exitCode = 1;
}
