import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const require = createRequire(import.meta.url);
export async function reconcilerParity(
  cargo = process.env.CARGO ?? "cargo",
  options = {},
) {
  const scope = JSON.parse(
    await readFile(path.join(here, "scope.json"), "utf8"),
  );
  assert.equal(process.version, scope.referenceEngine.node);
  assert.equal(process.versions.v8, scope.referenceEngine.v8);
  const args = options.args ?? [];
  const option = (name, fallback) => {
    const index = args.indexOf(name);
    return index < 0 ? fallback : path.resolve(args[index + 1]);
  };
  const binary =
    options.binary ??
    option("--rust-bin", path.join(root, "target/debug/reconciler-parity"));
  const reportFile =
    options.reportFile ??
    option("--report", path.join(root, "target/parity/reconciler.json"));
  if (!options.binary && !args.includes("--rust-bin"))
    execFileSync(
      cargo,
      [
        "build",
        "--locked",
        "--package",
        "demlik-parity",
        "--bin",
        "reconciler-parity",
      ],
      {
        cwd: root,
        stdio: "inherit",
        env: {
          ...process.env,
          CARGO_PROFILE_DEV_DEBUG: "0",
          CARGO_PROFILE_TEST_DEBUG: "0",
          CARGO_INCREMENTAL: "0",
          CARGO_BUILD_JOBS: "1",
        },
      },
    );
  const corpus = JSON.parse(
    await readFile(path.join(here, "reconciler-cases.json"), "utf8"),
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
    path.join(here, "reconciler-reference.mts"),
  ]);
  const native = run(binary, []);
  const [sourceWitness] = run(
    process.execPath,
    [
      "--import",
      require.resolve("tsx"),
      path.join(here, "reconciler-types.mts"),
    ],
    "",
  );
  assert.deepEqual(sourceWitness, {
    reentrantCalls: 2,
    complete: false,
    originalApplying: true,
    storedUndefinedAppliesNext: true,
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
    {
      id: "refuse.identity",
      input: { callbacks: { identity: "guess" }, actions: [] },
    },
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
        path.join(here, "reconciler-reference.mts"),
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
        "cross-language reconciler result",
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
    scope: "native Reconciler composition; full port remains incomplete",
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
      "Native callbacks return Result and preserve typed cause data. Default JSON identity requires Serialize only on Change; explicit idOf and typed stored ledger values need neither Clone nor serde.",
      "Pure observations preserve undefined, nonfinite and UTF-16 data before explicit JSON reloads. The existing cache owner coerces optional JSON keys and owns TTL/projection behavior.",
      "Opaque projected ledger values use an explicit native projection port at the existing cache boundary; this data adapter supplies the canonical serializer, with no JavaScript reflection runtime.",
      "The existing Runtime UTF-8 tag and native executor qualifications remain; no parser, schema, scheduler or Promise runtime was added.",
    ],
  };
  await mkdir(path.dirname(reportFile), { recursive: true });
  await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  if (!options.quiet)
    process.stdout.write(
      `${JSON.stringify({ ...report, nativeEvidence: { cases: Object.keys(report.nativeEvidence).length }, failures: failures.map(({ id, message }) => ({ id, message: message.split("\n").slice(0, 4).join("\n") })), failureCount: failures.length, reportFile }, null, 2)}\n`,
    );
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
  const report = await reconcilerParity(process.env.CARGO ?? "cargo", {
    args: process.argv.slice(2),
  });
  if (report.failures.length) process.exitCode = 1;
}
