import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { checkedSpawnSync as spawnSync } from "./check-worktree.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const require = createRequire(import.meta.url);
const { referenceEngine } = JSON.parse(
  readFileSync(new URL("./scope.json", import.meta.url), "utf8"),
);
export const pbtPropertyDescriptor = {
  name: "pbt-property",
  example: "pbt_property_driver",
  requiredFeature: "demlik-tea/pbt",
  cases: 53,
  runtime: {
    node: referenceEngine.node,
    v8: referenceEngine.v8,
    fastCheck: "3.23.2",
  },
  bindings: [
    {
      id: "@demlik/tea:./pbt#arbMsgSequence",
      native: "pbt::msg_sequence",
      qualified: true,
      scope:
        "Exact inclusive tail/fixed-prefix laws; backend distribution, seeds and shrinking remain qualified.",
    },
    {
      id: "@demlik/tea:./pbt#propertyInvariant",
      native: "pbt::property_invariant",
      qualified: true,
      scope:
        "Full fold before ordered predicates, default200 and no regression files; native configuration, errors and shrinking remain qualified.",
    },
  ],
};
export function assertPbtRuntime() {
  assert.equal(process.version, pbtPropertyDescriptor.runtime.node);
  assert.equal(process.versions.v8, pbtPropertyDescriptor.runtime.v8);
}
const hash = (file) =>
  createHash("sha256").update(readFileSync(file)).digest("hex");
function command(program, args, options = {}) {
  const p = spawnSync(program, args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
  if (p.error) throw p.error;
  return {
    command: [program, ...args],
    cwd: options.cwd ?? root,
    exit: p.status,
    stdout: p.stdout,
    stderr: p.stderr,
  };
}
export function readPbtCargoArtifacts(file) {
  const events = readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const libraries = {};
  for (const name of ["demlik_tea", "proptest"]) {
    const rows = events.filter(
      (e) =>
        e.reason === "compiler-artifact" &&
        e.target.name === name &&
        e.target.kind.includes("lib") &&
        e.filenames.some((f) => f.endsWith(".rlib")),
    );
    assert.equal(
      rows.length,
      1,
      `Cargo JSON must identify exactly one ${name} feature library`,
    );
    const e = rows[0];
    if (name === "demlik_tea")
      assert(e.features.includes("pbt"), "Tea artifact must enable pbt");
    else {
      assert(e.package_id.endsWith("#proptest@1.11.0"));
      assert(e.features.includes("std"));
      assert(!e.features.includes("fork") && !e.features.includes("timeout"));
    }
    const filename = e.filenames.find((f) => f.endsWith(".rlib"));
    libraries[name] = {
      path: filename,
      sha256: hash(filename),
      packageId: e.package_id,
      features: e.features,
    };
  }
  const examples = events.filter(
    (e) =>
      e.reason === "compiler-artifact" &&
      e.target.name === pbtPropertyDescriptor.example &&
      e.executable,
  );
  assert.equal(
    examples.length,
    1,
    "Cargo JSON must identify actual feature-enabled example",
  );
  assert(examples[0].features.includes("pbt"));
  return {
    file: path.resolve(file),
    sha256: hash(file),
    libraries,
    executable: examples[0].executable,
  };
}
export function buildPbtExample(cargo, reportPrefix) {
  const args = [
    "build",
    "--locked",
    "--offline",
    "-p",
    "demlik-tea",
    "--features",
    "pbt",
    "--example",
    pbtPropertyDescriptor.example,
    "--message-format=json",
  ];
  const built = command(cargo, args, {
    env: {
      ...process.env,
      CARGO: cargo,
      CARGO_NET_OFFLINE: "true",
      CARGO_BUILD_JOBS: "1",
      CARGO_PROFILE_DEV_DEBUG: "0",
      CARGO_PROFILE_TEST_DEBUG: "0",
      CARGO_INCREMENTAL: "0",
    },
  });
  const file = `${reportPrefix}.cargo.jsonl`;
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, built.stdout);
  writeFileSync(`${reportPrefix}.cargo.stderr`, built.stderr);
  assert.equal(built.exit, 0, `Feature example build failed:\n${built.stderr}`);
  const artifacts = readPbtCargoArtifacts(file),
    sha256 = hash(artifacts.executable),
    binary = `${reportPrefix}.binary-${sha256}`;
  if (!existsSync(binary)) copyFileSync(artifacts.executable, binary);
  assert.equal(hash(binary), sha256);
  return { binary, sha256, artifacts, build: built };
}
export async function pbtPropertyParity(
  cargo = process.env.CARGO ?? "cargo",
  options = {},
) {
  assertPbtRuntime();
  if (options.binary !== undefined)
    assert(options.binary.length > 0, "Explicit binary path must not be empty");
  const reportFile = path.resolve(
    options.reportFile ??
      path.join(root, "target/parity/pbt-property-parent.json"),
  );
  mkdirSync(path.dirname(reportFile), { recursive: true });
  const built = options.binary ? undefined : buildPbtExample(cargo, reportFile);
  const binary = path.resolve(options.binary ?? built.binary),
    sha256 = hash(binary),
    fixedFile = `${reportFile}.fixed.json`,
    filesFile = `${reportFile}.files.json`;
  const program = `const {pbtPropertyParity,pbtPropertyCases}=await import(${JSON.stringify(pathToFileURL(path.join(root, "verification/parity/pbt-property.mts")).href)});const opts=JSON.parse(process.argv[1]);const report=pbtPropertyParity(opts);console.log(JSON.stringify({ids:pbtPropertyCases().map(c=>c.id),compared:report.compared,passed:report.passed}));if(report.failures.length)process.exitCode=1;`;
  const fixedCommand = command(process.execPath, [
    "--import",
    require.resolve("tsx"),
    "--input-type=module",
    "-e",
    program,
    JSON.stringify({ binary, reportFile: fixedFile }),
  ]);
  assert([0, 1].includes(fixedCommand.exit), fixedCommand.stderr);
  const expected = JSON.parse(fixedCommand.stdout),
    fixed = JSON.parse(readFileSync(fixedFile, "utf8"));
  assert.equal(expected.ids.length, 52);
  assert.deepEqual(
    fixed.cases.map((c) => c.id),
    expected.ids,
  );
  assert.equal(new Set(expected.ids).size, 52);
  assert.equal(fixed.compared, 52);
  assert.equal(fixed.passed, fixed.cases.filter((c) => c.equal).length);
  assert.deepEqual(
    fixed.failures.map((c) => c.id).sort(),
    fixed.cases
      .filter((c) => !c.equal)
      .map((c) => c.id)
      .sort(),
    "Failure IDs must match the actual failed rows",
  );
  assert.equal(fixedCommand.exit, fixed.failures.length ? 1 : 0);
  assert.deepEqual(fixed.runtime, pbtPropertyDescriptor.runtime);
  const filesCommand = command(process.execPath, [
    "--import",
    require.resolve("tsx"),
    path.join(root, "verification/parity/pbt-property-files.mts"),
    "--native-bin",
    binary,
    "--report",
    filesFile,
  ]);
  assert([0, 1].includes(filesCommand.exit), filesCommand.stderr);
  const files = JSON.parse(readFileSync(filesFile, "utf8"));
  assert.equal(files.id, "pbt-property.no-regression-files");
  assert.equal(filesCommand.exit, files.equal ? 0 : 1);
  for (const report of [fixed, files]) {
    assert.equal(path.resolve(report.binary.path), binary);
    assert.equal(report.binary.sha256, sha256);
  }
  assert.equal(hash(binary), sha256, "Binary changed during verification");
  for (const row of fixed.cases) {
    assert(
      row.observedRustCalls.includes("pbt::property_invariant"),
      `${row.id}: missing actual property call`,
    );
    if (row.input.kind === "sequence")
      assert(
        row.observedRustCalls.includes("pbt::msg_sequence"),
        `${row.id}: missing actual generator call`,
      );
    for (const call of row.observedRustCalls)
      assert(
        pbtPropertyDescriptor.bindings.some((b) => b.native === call),
        `${row.id}: unexpected native symbol ${call}`,
      );
  }
  assert(files.observedRustCalls.includes("pbt::property_invariant"));
  const rows = [...fixed.cases, files];
  assert.equal(rows.length, pbtPropertyDescriptor.cases);
  assert.equal(new Set(rows.map((c) => c.id)).size, 53);
  const failures = [
      ...fixed.failures,
      ...(files.equal
        ? []
        : [{ id: files.id, reference: files.reference, native: files.native }]),
    ],
    passed = rows.filter((c) => c.equal).length;
  assert.equal(passed + failures.length, 53);
  const qualifications = fixed.qualifications,
    nativeEvidence = Object.fromEntries(
      rows.filter((c) => c.equal).map((c) => [c.id, c.observedRustCalls]),
    );
  const report = {
    descriptor: pbtPropertyDescriptor,
    runtime: fixed.runtime,
    binary: { path: binary, sha256 },
    compared: 53,
    passed,
    failures,
    cases: rows,
    qualifications,
    scope: fixed.scope,
    commands: [...(built ? [built.build] : []), fixedCommand, filesCommand],
    originalReports: { fixed, files },
    cargoArtifacts: built?.artifacts,
  };
  writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  return {
    cases: 53,
    passed,
    failures,
    nativeEvidence,
    binarySha256: sha256,
    controls: [],
    scope: report.scope,
    qualifications,
    reportFile,
    descriptor: pbtPropertyDescriptor,
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const { values } = parseArgs({
    options: { binary: { type: "string" }, report: { type: "string" } },
    strict: true,
  });
  const result = await pbtPropertyParity(process.env.CARGO ?? "cargo", {
    binary: values.binary,
    reportFile: values.report,
  });
  console.log(
    JSON.stringify({
      ...result,
      nativeEvidence: { cases: Object.keys(result.nativeEvidence).length },
    }),
  );
  if (result.failures.length) process.exitCode = 1;
}
