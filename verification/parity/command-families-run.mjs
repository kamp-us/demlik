import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const require = createRequire(import.meta.url);
const cargo = process.env.CARGO ?? "cargo";
const scope = JSON.parse(await readFile(path.join(here, "scope.json"), "utf8"));
assert.equal(process.version, scope.referenceEngine.node);
assert.equal(process.versions.v8, scope.referenceEngine.v8);
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index < 0 ? fallback : path.resolve(args[index + 1]);
};
const binary = option(
  "--rust-bin",
  path.join(root, "target/debug/command-families-parity"),
);
const reportFile = option(
  "--report",
  path.join(root, "target/parity/command-families.json"),
);
if (!args.includes("--rust-bin"))
  execFileSync(
    cargo,
    [
      "build",
      "--locked",
      "--package",
      "demlik-parity",
      "--bin",
      "command-families-parity",
    ],
    { cwd: root, stdio: "inherit" },
  );
const corpus = JSON.parse(
  await readFile(path.join(here, "command-families-cases.json"), "utf8"),
);
assert.equal(corpus.version, 1);
const cases = corpus.cases;
assert.equal(new Set(cases.map((test) => test.id)).size, cases.length);
const input = `${cases.map((test) => JSON.stringify({ id: test.id, operation: test.operation, input: test.input })).join("\n")}\n`;
function run(command, args) {
  return execFileSync(command, args, {
    cwd: root,
    input,
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
  path.join(here, "command-families-reference.mts"),
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
    }
    assert.deepEqual(
      native[index].output,
      reference[index].output,
      "cross-language named command result",
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
  scope: "native owned command-family names; full port remains incomplete",
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
    "Family names use the existing UTF-8 Tagged interface; lone-surrogate names remain a shared-owner gap.",
    "A typed declaration owns its schema and failure channel. Named definitions do not create a type registry; the existing raw wire contract retains source last-definition precedence.",
    "CommandRecord is an explicit trusted typed-record boundary; wire/hash parsing applies serde bounds separately.",
  ],
};
await mkdir(path.dirname(reportFile), { recursive: true });
await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(
  `${JSON.stringify({ ...report, nativeEvidence: { cases: Object.keys(report.nativeEvidence).length }, failures: failures.slice(0, 5), failureCount: failures.length, reportFile }, null, 2)}\n`,
);
if (failures.length) process.exitCode = 1;
