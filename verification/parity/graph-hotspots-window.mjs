import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [binary, reportFile] = process.argv.slice(2);
assert.equal(process.argv.length, 4);
assert.equal(process.version, "v22.21.1");
const root = fileURLToPath(new URL("../..", import.meta.url));
const inputs = JSON.parse(
  fs.readFileSync(
    new URL("./hotspots-window-cases.json", import.meta.url),
    "utf8",
  ),
);
const pins = JSON.parse(
  fs.readFileSync(
    new URL("./hotspots-window-admission.json", import.meta.url),
    "utf8",
  ),
).sourcePins;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const hashes = () =>
  Object.fromEntries(
    Object.keys(pins).map((file) => [
      file,
      hash(fs.readFileSync(path.join(root, file))),
    ]),
  );
const before = hashes();
assert.deepEqual(before, pins);
const binaryBefore = hash(fs.readFileSync(binary));
const folder = `${reportFile}.processes`;
fs.mkdirSync(folder, { recursive: true });
function execute(name, command, args, input, env) {
  const result = spawnSync(command, args, {
    cwd: root,
    input,
    env,
    encoding: "utf8",
    timeout: 30000,
    maxBuffer: 8 << 20,
  });
  const prefix = path.join(folder, name);
  const files = {
    input: `${prefix}.input`,
    stdout: `${prefix}.stdout`,
    stderr: `${prefix}.stderr`,
  };
  fs.writeFileSync(files.input, input ?? "");
  fs.writeFileSync(files.stdout, result.stdout ?? "");
  fs.writeFileSync(files.stderr, result.stderr ?? "");
  return {
    command: [command, ...args],
    status: result.status,
    signal: result.signal,
    error: result.error?.message ?? null,
    ...files,
    inputSha256: hash(fs.readFileSync(files.input)),
    stdoutSha256: hash(fs.readFileSync(files.stdout)),
    stderrSha256: hash(fs.readFileSync(files.stderr)),
    ...(command === binary ? { binarySha256: binaryBefore } : {}),
  };
}
const source = [],
  rows = [],
  failures = [];
let failure;
try {
  for (const [profile, zone] of [
    ["window", "UTC"],
    ["window", "America/Los_Angeles"],
    ["parser", "UTC"],
  ]) {
    const process = execute(
      `source-${profile}-${zone.replaceAll("/", "-")}`,
      globalThis.process.execPath,
      [
        "--import",
        createRequire(import.meta.url).resolve("tsx"),
        fileURLToPath(
          new URL("./hotspots-window-reference.mjs", import.meta.url),
        ),
        profile,
        zone,
      ],
      null,
      {
        ...globalThis.process.env,
        TZ: zone,
        TMPDIR: "/private/tmp",
        TSX_DISABLE_CACHE: "1",
      },
    );
    assert.equal(process.status, 0);
    assert.equal(process.signal, null);
    assert.equal(process.error, null);
    assert.equal(fs.readFileSync(process.stderr, "utf8"), "");
    source.push({
      profile,
      zone,
      process,
      report: JSON.parse(fs.readFileSync(process.stdout, "utf8")),
    });
  }
  assert.equal(source.flatMap((r) => r.report.rows).length, 80);
  for (const input of inputs) {
    const original = source
      .flatMap((r) => r.report.rows)
      .find((r) => r.id === input.id);
    assert(original);
    const process = execute(
      input.id,
      binary,
      [],
      `${JSON.stringify(input.input)}\n`,
      {
        ...globalThis.process.env,
        TZ: input.input.zone,
        TMPDIR: "/private/tmp",
      },
    );
    let frame, protocolError;
    try {
      assert.equal(process.status, 0);
      assert.equal(process.signal, null);
      assert.equal(process.error, null);
      assert.equal(fs.readFileSync(process.stderr, "utf8"), "");
      frame = JSON.parse(fs.readFileSync(process.stdout, "utf8"));
      assert.equal(frame.id, input.id);
    } catch (error) {
      protocolError = String(error);
    }
    const expected = Object.fromEntries(
      ["output", "error", "clockReads"]
        .filter((key) => Object.hasOwn(original, key))
        .map((key) => [key, original[key]]),
    );
    const actual =
      frame &&
      Object.fromEntries(Object.keys(expected).map((key) => [key, frame[key]]));
    const equal =
      !protocolError && JSON.stringify(actual) === JSON.stringify(expected);
    const row = {
      id: input.id,
      input: input.input,
      profile: input.profile,
      source: original,
      expected,
      native: frame,
      actualView: actual,
      process,
      protocolError: protocolError ?? null,
      equal,
    };
    rows.push(row);
    if (!equal) failures.push(input.id);
  }
} catch (error) {
  failure = String(error);
  throw error;
} finally {
  const after = hashes(),
    binaryAfter = hash(fs.readFileSync(binary));
  fs.writeFileSync(
    reportFile,
    `${JSON.stringify(
      {
        cases: rows.length,
        passed: rows.filter((r) => r.equal).length,
        rows,
        failures,
        source,
        sourcePinsBefore: before,
        sourcePinsAfter: after,
        sourcePhaseCompletedBeforeNative: source.length === 3,
        binary: { path: binary, before: binaryBefore, after: binaryAfter },
        failure: failure ?? null,
      },
      null,
      2,
    )}\n`,
  );
  assert.deepEqual(after, before);
  assert.equal(binaryAfter, binaryBefore);
}
assert.equal(rows.length, 80);
assert.deepEqual(failures, []);
console.log(JSON.stringify({ cases: 80, passed: 80, nativeFrames: 80 }));
