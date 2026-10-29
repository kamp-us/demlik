import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkedExecFileSync as execFileSync } from "./check-worktree.mjs";

import { buildParityBinary } from "./tea-example.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const require = createRequire(import.meta.url);
export async function paginatedWalkParity(cargo, options = {}) {
  const scope = JSON.parse(
    await readFile(path.join(here, "scope.json"), "utf8"),
  );
  assert.equal(process.version, scope.referenceEngine.node);
  assert.equal(process.versions.v8, scope.referenceEngine.v8);
  const reportFile = options.reportFile
    ? path.resolve(options.reportFile)
    : path.join(root, "target/parity/paginated-walk.json");
  const producer = options.binary
    ? null
    : buildParityBinary(cargo, "paginated-walk-parity", reportFile);
  const binary = options.binary
    ? path.resolve(options.binary)
    : producer.binary;
  const corpus = JSON.parse(
    await readFile(path.join(here, "paginated-walk-cases.json"), "utf8"),
  );
  assert.equal(corpus.version, 1);
  const cases = corpus.cases;
  assert.equal(new Set(cases.map((test) => test.id)).size, cases.length);
  const input = `${cases.map((test) => JSON.stringify({ id: test.id, operation: test.operation, input: test.input })).join("\n")}\n`;
  function run(command, args, inputText = input) {
    return execFileSync(command, args, {
      cwd: root,
      input: inputText,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    })
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  }
  const reference = run(process.execPath, [
    "--import",
    require.resolve("tsx"),
    path.join(here, "paginated-walk-reference.mts"),
  ]);
  const native = run(binary, []);
  const [sourceWitness] = run(
    process.execPath,
    [
      "--import",
      require.resolve("tsx"),
      path.join(here, "paginated-walk-types.mts"),
    ],
    "",
  );
  assert.deepEqual(sourceWitness, {
    reentrantCalls: 2,
    complete: true,
    originalFetching: true,
  });
  const refusals = [
    { id: "refuse.input", input: [] },
    { id: "refuse.actions", input: { actions: 4 } },
    { id: "refuse.config", input: { config: [], actions: [] } },
    {
      id: "refuse.retry",
      input: { config: { retry: { maxAttempts: 2 } }, actions: [] },
    },
    { id: "refuse.circuit", input: { config: { circuit: {} }, actions: [] } },
    {
      id: "refuse.rate",
      input: { config: { rateLimit: { capacity: 2 } }, actions: [] },
    },
    { id: "refuse.deadline", input: { config: { deadline: {} }, actions: [] } },
    {
      id: "refuse.callback",
      input: { callbacks: { next: "guess" }, actions: [] },
    },
    { id: "refuse.emits", input: { callbacks: { emits: -1 }, actions: [] } },
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
        path.join(here, "paginated-walk-reference.mts"),
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
      for (const [key, expected] of Object.entries(test.expectPaths ?? {})) {
        for (const response of [reference[index], native[index]]) {
          const actual = key
            .split(".")
            .reduce((value, part) => value[part], response.output);
          assert.deepEqual(actual, expected, `independent path ${key}`);
        }
      }
      assert.deepEqual(
        native[index].output,
        reference[index].output,
        "cross-language paginated-walk result",
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
    scope: "native composed paginated-walk; full port remains incomplete",
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
    sourceWitness,
    architecture: process.arch,
    cases: cases.length,
    actions: cases.reduce(
      (count, test) => count + test.input.actions.length,
      0,
    ),
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
    qualifications: [
      "Native pure callbacks return Result and retain caller Rc identity; callback and runtime consumers prove reentry and opaque non-serde values.",
      "Pure-state observations preserve undefined, nonfinite numbers and UTF-16 data; only explicit JSON reloads apply JSON transformations.",
      "The inherited fetch family uses the existing UTF-8 command tag owner. Generic cursor/page/failure data retains UTF-16.",
      "No new scheduler, parser or schema runtime; all fetch admission, cursor advancement, settlement and runtime timers use existing owners.",
    ],
  };
  await mkdir(path.dirname(reportFile), { recursive: true });
  await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  assert.deepEqual(
    report.referenceChanges,
    [],
    "the reference source must stay frozen",
  );
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
  const report = await paginatedWalkParity(process.env.CARGO ?? "cargo", {
    binary: option("--rust-bin"),
    reportFile: option("--report"),
  });
  process.stdout.write(
    `${JSON.stringify({ ...report, nativeEvidence: { cases: Object.keys(report.nativeEvidence).length }, failures: report.failures.map(({ id, message }) => ({ id, message: message.split("\n").slice(0, 4).join("\n") })), failureCount: report.failures.length }, null, 2)}\n`,
  );
  if (report.failures.length) process.exitCode = 1;
}
