import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildParityBinary } from "./tea-example.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const require = createRequire(import.meta.url);
export async function paginateQueueParity(cargo, options = {}) {
  const scope = JSON.parse(
    await readFile(path.join(here, "scope.json"), "utf8"),
  );
  assert.equal(process.version, scope.referenceEngine.node);
  assert.equal(process.versions.v8, scope.referenceEngine.v8);
  const reportFile =
    options.reportFile ?? path.join(root, "target/parity/paginate-queue.json");
  const producer = options.binary
    ? null
    : buildParityBinary(cargo, "paginate-queue-parity", reportFile);
  const binary = options.binary ?? producer.binary;
  const corpus = JSON.parse(
    await readFile(path.join(here, "paginate-queue-cases.json"), "utf8"),
  );
  assert.equal(corpus.version, 1);
  const cases = corpus.cases;
  assert.equal(new Set(cases.map((test) => test.id)).size, cases.length);
  const input = `${cases.map((test) => JSON.stringify({ id: test.id, operation: test.operation, input: test.input })).join("\n")}\n`;
  const driverDiagnostics = [];
  function run(command, args) {
    const result = spawnSync(command, args, {
      cwd: root,
      input,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      timeout: 30_000,
    });
    if (result.error) throw result.error;
    assert.equal(
      result.status,
      0,
      `paginate/queue driver failed: ${result.stderr}`,
    );
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
    path.join(here, "paginate-queue-reference.mts"),
  ]);
  const native = run(binary, []);
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
        for (const check of test.checks ?? []) {
          let value = response.output;
          for (const key of check.path) value = value[key];
          assert.deepEqual(
            value,
            check.expected,
            `${language} independent ${check.path.join(".")}`,
          );
        }
      }
      assert.deepEqual(
        native[index].output,
        reference[index].output,
        "cross-language paginator/queue result",
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
    scope:
      "native paginator/work-queue slice; composed paginated-walk remains open",
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
    driverDiagnostics,
    cases: cases.length,
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
    qualifications: [
      "Cursor/payload serialization is an explicit boundary; pure operations impose no model serde or Clone bound.",
      "QueueStore failure/refusal and pure alias traces are tested on the reported native platform; broad host targets are separate scopes.",
      "Concurrent ready futures and JavaScript Promise awaits schedule differently: the checkpoint document records this measured adapter qualification.",
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
  const report = await paginateQueueParity(process.env.CARGO ?? "cargo", {
    binary: option("--rust-bin"),
    reportFile: option("--report"),
  });
  process.stdout.write(
    `${JSON.stringify({ ...report, driverDiagnostics: { streams: report.driverDiagnostics.length }, nativeEvidence: { cases: Object.keys(report.nativeEvidence).length }, failures: report.failures.slice(0, 5), failureCount: report.failures.length }, null, 2)}\n`,
  );
  if (report.failures.length) process.exitCode = 1;
}
