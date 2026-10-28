import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { changesetTextCases } from "./api-base-cases.mjs";
import { buildExample } from "./tea-example.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url)),
  here = path.dirname(fileURLToPath(import.meta.url)),
  require = createRequire(import.meta.url);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
export async function apiBaseParserParity(options = {}) {
  assert.equal(process.version, "v22.21.1");
  assert.equal(process.versions.v8, "12.4.254.21-node.33");
  const cases = changesetTextCases();
  assert.equal(new Set(cases.map((row) => row.id)).size, cases.length);
  const input = cases.map((row) => JSON.stringify(row)).join("\n") + "\n";
  const reportFile =
    options.reportFile ?? path.join(root, "target/parity/api-base-parser.json");
  const producer = options.binary
    ? null
    : buildExample(
        process.env.CARGO ?? "cargo",
        "demlik-code-graph",
        "api_base_driver",
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
  const run = (program, args) =>
    execFileSync(program, args, {
      cwd: root,
      input,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    })
      .trim()
      .split("\n")
      .map((row) => JSON.parse(row));
  const source = run(process.execPath, [
      "--import",
      require.resolve("tsx"),
      path.join(here, "api-base-reference.mts"),
    ]),
    native = run(binary, []),
    failures = [],
    nativeEvidence = {};
  assert.equal(source.length, cases.length);
  assert.equal(native.length, cases.length);
  for (let i = 0; i < cases.length; i++) {
    try {
      assert.equal(source[i].id, cases[i].id);
      assert.equal(native[i].id, cases[i].id);
      assert.equal(native[i].ok, true);
      assert.deepEqual(native[i].output, source[i].output);
      assert.ok(
        native[i].observedCalls.includes(
          "demlik_code_graph::api::ratchet::changesets::parse_changeset",
        ),
      );
      nativeEvidence[cases[i].id] = native[i].observedCalls;
    } catch (error) {
      failures.push({
        id: cases[i].id,
        source: source[i],
        native: native[i],
        message: error.message,
      });
    }
  }
  if (!failures.length) {
    const output = (id) =>
      native.find((row) => row.id === `api-base.parse.${id}`).output;
    assert.deepEqual(output("ordered"), {
      bumps: [
        ["@demo/pkg", "major"],
        ["__proto__", "patch"],
      ],
      body: "\nBody\n---\nmore\n",
    });
    assert.equal(output("body-cr").body, "last\r");
    assert.equal(output("two-boms"), null);
  }
  const report = {
    producer,
    binarySource: options.binary
      ? "external override; local Cargo producer unproved"
      : "actual Cargo JSON selection",
    reference: "75de37ea01a81cd7949e6275b7ee9cfdeb4e312d",
    scope: "Native changeset text parser only; Git IO layer remains separate",
    node: process.version,
    v8: process.versions.v8,
    cases: cases.length,
    passed: cases.length - failures.length,
    failures,
    nativeEvidence,
    corpusSha256: hash(input),
    rustBinarySha256: hash(await readFile(binary)),
  };
  await mkdir(path.dirname(reportFile), { recursive: true });
  await writeFile(reportFile, JSON.stringify(report, null, 2) + "\n");
  if (!options.quiet)
    console.log(
      JSON.stringify(
        {
          ...report,
          nativeEvidence: { cases: Object.keys(nativeEvidence).length },
          failures: failures.slice(0, 8),
          reportFile,
        },
        null,
        2,
      ),
    );
  if (!options.allowFailures)
    assert.equal(failures.length, 0, `Parser failures: ${reportFile}`);
  return { ...report, reportFile };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  await apiBaseParserParity();
