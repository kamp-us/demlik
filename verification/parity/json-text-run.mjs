import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkedExecFileSync as execFileSync } from "./check-worktree.mjs";
import { buildExample } from "./tea-example.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
export async function jsonTextParity(options = {}) {
  const scope = JSON.parse(
    await readFile(path.join(here, "scope.json"), "utf8"),
  );
  assert.equal(process.version, scope.referenceEngine.node);
  assert.equal(process.versions.v8, scope.referenceEngine.v8);
  const probeFile = path.join(here, "json-text-source-probe.json.fixture"),
    probeBytes = await readFile(probeFile);
  assert.equal(
    hash(probeBytes),
    "4383a83fdbd6c2ee26a9bd1909e0722898024a26a1cb9be0a8b7868953b34697",
  );
  const probe = JSON.parse(probeBytes);
  const reportFile =
    options.reportFile ?? path.join(root, "target/parity/json-text.json");
  const producer = options.binary
    ? null
    : buildExample(
        process.env.CARGO ?? "cargo",
        "demlik-tea",
        "json_text_driver",
        reportFile,
        [],
        {
          CARGO_PROFILE_DEV_DEBUG: "0",
          CARGO_PROFILE_TEST_DEBUG: "0",
          CARGO_INCREMENTAL: "0",
          CARGO_BUILD_JOBS: "1",
        },
      );
  const binary = options.binary ?? producer.binary;
  const cases = probe.cases.map(({ id, units, ok, value }) => ({
    id,
    units,
    expected: { ok, ...(ok ? { value } : {}) },
  }));
  const add = (id, units) => cases.push({ id, units });
  const units = (text) =>
    Array.from({ length: text.length }, (_, i) => text.charCodeAt(i));
  for (const surrogate of [0xd800, 0xdbff, 0xdc00, 0xdfff]) {
    for (let slash = 0; slash <= 7; slash++)
      for (const context of [
        "value",
        "key",
        "array",
        "nested",
        "outside",
        "escaped-quote",
      ]) {
        const body = [34, ...Array(slash).fill(92), surrogate, 34];
        const value =
          context === "key"
            ? [123, ...body, 58, 49, 125]
            : context === "array"
              ? [91, ...body, 93]
              : context === "nested"
                ? [123, ...units('"a":['), ...body, 93, 125]
                : context === "outside"
                  ? [123, 34, 97, 34, 58, surrogate, 125]
                  : context === "escaped-quote"
                    ? [34, 92, 34, ...Array(slash).fill(92), surrogate, 34]
                    : body;
        add(`surrogate-${surrogate}-${slash}-${context}`, value);
      }
  }
  for (const source of [
    "null",
    "true",
    "1e400",
    "-0",
    '"value"',
    '{"10":1,"2":2,"a":"x"}',
    String.raw`{"\ud800":"\udc00"}`,
    "[1,2,3]",
    "{bad}",
    String.raw`"\q"`,
    "\ufeff{}",
    "[1,]",
    "{}x",
    '"unterminated',
  ])
    add(`utf8-${cases.length}`, units(source));
  for (const suffix of [[], [92], [117, 48, 48], [0], [34, 120], [125]])
    add(`tail-${cases.length}`, [34, 0xd800, ...suffix]);
  const input = `${cases.map(({ id, units }) => JSON.stringify({ id, units })).join("\n")}\n`;
  const run = (command, args) =>
    execFileSync(command, args, {
      cwd: root,
      input,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    })
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  const reference = run(process.execPath, [
    "--import",
    require.resolve("tsx"),
    path.join(here, "json-text-reference.mts"),
  ]);
  const native = run(binary, []);
  assert.equal(native.length, cases.length);
  assert.equal(reference.length, cases.length);
  const failures = [];
  for (let i = 0; i < cases.length; i++) {
    try {
      assert.equal(native[i].id, cases[i].id);
      assert.equal(reference[i].id, cases[i].id);
      assert.ok(
        native[i].observedCalls.includes("demlik_tea::data::decode_json_text"),
      );
      assert.equal(native[i].ok, reference[i].ok);
      if (reference[i].ok)
        assert.deepEqual(native[i].value, reference[i].value);
      if (cases[i].expected) {
        for (const result of [native[i], reference[i]]) {
          assert.equal(result.ok, cases[i].expected.ok);
          if (result.ok)
            assert.deepEqual(result.value, cases[i].expected.value);
        }
      }
    } catch (error) {
      failures.push({
        id: cases[i].id,
        units: cases[i].units,
        message: error.message,
        reference: reference[i],
        native: native[i],
      });
    }
  }
  const report = {
    producer,
    binarySource: options.binary
      ? "external override; local Cargo producer unproved"
      : "actual Cargo JSON selection",
    scope:
      "Canonical JsText JSON decoder; exact accept/reject and decoded value parity",
    node: process.version,
    v8: process.versions.v8,
    probeSha256: hash(probeBytes),
    cases: cases.length,
    passed: cases.length - failures.length,
    failures,
    nativeEvidence: Object.fromEntries(
      cases.map((test, i) => [
        test.id,
        failures.some((f) => f.id === test.id) ? [] : native[i].observedCalls,
      ]),
    ),
    backendRefusals: cases
      .filter((_, i) => !reference[i].ok)
      .map((test) => {
        const i = cases.indexOf(test);
        return {
          id: test.id,
          reference: reference[i].error,
          native: native[i].error,
        };
      }),
    binarySha256: hash(await readFile(binary)),
    qualifications: [
      "JSON parsing stays delegated to the existing serde RawValue validation and lossless extractor. UTF8 input uses the original decoder unchanged.",
      "Native syntax diagnostics, including explicit invalid-UTF16-placement errors, retain their actual backend wording/category. They are qualified separately; accepted values and refusal decisions have no tolerance.",
    ],
  };
  await mkdir(path.dirname(reportFile), { recursive: true });
  await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  if (!options.quiet)
    console.log(
      JSON.stringify(
        {
          ...report,
          nativeEvidence: { cases: Object.keys(report.nativeEvidence).length },
          backendRefusals: { cases: report.backendRefusals.length },
          failures: failures.map(({ id, message }) => ({ id, message })),
          reportFile,
        },
        null,
        2,
      ),
    );
  return { ...report, reportFile };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const report = await jsonTextParity();
  if (report.failures.length) process.exitCode = 1;
}
