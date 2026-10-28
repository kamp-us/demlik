import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertCheckPath } from "./check-worktree.mjs";
import { buildTeaExample } from "./tea-example.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const require = createRequire(import.meta.url);
const node22 = "/Users/cansirin/.volta/tools/image/node/22.21.1/bin/node";
const engine = {
  node: "v22.21.1",
  v8: "12.4.254.21-node.33",
  icu: "77.1",
  locale: "en-US",
};
const qualifiedId = "indices.raw-null";
const globalId = (id) => `render-prompt.${id}`;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fileHash = (file) => hash(fs.readFileSync(file));
const livePins = {
  "packages/tea/src/agent/define-agent.ts":
    "42579cfce4952fb447b69219d8f2918064e2fe1fcd4a9006eebbebda173626a3",
  "packages/tea/src/agent/types.ts":
    "062a8a395670d896d8e1f36087033382051a2e098bfd5d94de90937a6222d540",
  "packages/tea/src/agent/model.ts":
    "c2efb6b532914f8c8b21b238a118c8b09588ac51e6aefafe9fe57a8cab21f90c",
  "packages/tea/src/agent/tool.ts":
    "56f6eea269084931535a9df469f75cc9a7368bbdb2dd4b24137030fd67252175",
  "packages/tea/src/agent/content.ts":
    "e44f3636e5025ef333f86bc6a910a75078d46c1047ba2cb82adf54e13fb5a8c6",
  "packages/tea/src/agent/define-agent.test.ts":
    "0333c718af1e9b6c7b75f2aa39934e0dd7770d439139d5484cecec32ec7ea7a4",
  "packages/tea/src/agent/content.test.ts":
    "42bfe9534482b9e82fa642774c2f4a284e4a341ca89718c3e86927003bb7edee",
  "packages/tea/src/agent/index.ts":
    "28edeb15977cf7008576574ee8589715272784f1feef260f36b70242da922d65",
  "verification/parity/render-prompt-source.mts":
    "5930c5323815186486ddb2aaf6d8244a039c87852a2b1ea49ec79c32b01d6b70",
  "verification/parity/render-prompt-source-cases.json":
    "b977c01fd2f27fa2b0bc3e548014ec4439d18af58a7e8b6513a201b72d0d6ec0",
  "verification/parity/tsconfig.render-prompt-source.json":
    "7c8359d52ec2e2e785aa5073f5c74d50f8aba7eecdae8ca70e761ca7f3f46725",
  "verification/parity/render-prompt-native.py":
    "0513e5ad01c3fa5b0f571db74251e112e85889ed95e68ecf363409af935660d8",
  "crates/tea/examples/render_prompt_driver.rs":
    "aea127c6919c674c30d657525934bfb317d37f8eb5e84035e90e34363e3c203f",
};
const historicalFixturePins = {
  "verification/parity/render-prompt-source.mts":
    "0b511c434e313505ff22a827e63940b296cfd532f302bd68afbfa53c760d4869",
  "verification/parity/render-prompt-source-cases.json":
    "511a37ec9518c03a93fb9c7357576d84559c3b5913e3a0fa6e8d3abdbb3c1013",
  "verification/parity/tsconfig.render-prompt-source.json":
    "0fc5970714184833a3cb9afe9ada37a7d79832075079dabfaac954c3e05034b2",
};
const profiles = {
  "empty.fresh-array": "published typed renderPrompt",
  "head.null-versus-empty": "published typed renderPrompt",
  "head.instructions-only": "published typed renderPrompt",
  "head.input-utf16": "published typed renderPrompt",
  "history.plan-act-order": "published typed renderPrompt",
  "records.duplicates-orphans": "published typed renderPrompt",
  "provider.presence": "published typed renderPrompt",
  "owners.original-handles": "published typed renderPrompt",
  "parts.null-versus-empty": "published typed renderPrompt",
  "parts.media-original": "published typed renderPrompt",
  "parts.error-callback": "published typed renderPrompt",
  "parts.failure-prefix": "published typed renderPrompt",
  "indices.exact-number": "published typed renderPrompt",
  "indices.raw-null":
    "RAW-INPUT/runtime-qualified: null record.turn, no published restore claimed",
  "history.turn-count-ignored": "published typed renderPrompt",
  "render.repeat-no-cache": "published typed renderPrompt",
  "parts.mutate-after-render": "published typed renderPrompt",
  "port.invoice-native-and-raw": "published typed renderPrompt",
};
const callVectors = {
  "empty.fresh-array": [
    "demlik_tea::agent::render_prompt",
    "demlik_tea::agent::render_prompt",
  ],
  "head.null-versus-empty": [
    "demlik_tea::agent::render_prompt",
    "demlik_tea::agent::render_prompt",
  ],
  "head.instructions-only": ["demlik_tea::agent::render_prompt"],
  "head.input-utf16": ["demlik_tea::agent::render_prompt"],
  "history.plan-act-order": ["demlik_tea::agent::render_prompt_with"],
  "records.duplicates-orphans": ["demlik_tea::agent::render_prompt_with"],
  "provider.presence": ["demlik_tea::agent::render_prompt"],
  "owners.original-handles": ["demlik_tea::agent::render_prompt_with"],
  "parts.null-versus-empty": ["demlik_tea::agent::render_prompt_with"],
  "parts.media-original": ["demlik_tea::agent::render_prompt_with"],
  "parts.error-callback": ["demlik_tea::agent::render_prompt_with"],
  "parts.failure-prefix": ["demlik_tea::agent::render_prompt_with"],
  "indices.exact-number": ["demlik_tea::agent::render_prompt_with"],
  "indices.raw-null": ["demlik_tea::agent::render_prompt_with"],
  "history.turn-count-ignored": [
    "demlik_tea::agent::render_prompt",
    "demlik_tea::agent::render_prompt",
  ],
  "render.repeat-no-cache": [
    "demlik_tea::agent::render_prompt_with",
    "demlik_tea::agent::render_prompt_with",
  ],
  "parts.mutate-after-render": ["demlik_tea::agent::render_prompt_with"],
  "port.invoice-native-and-raw": [
    "demlik_tea::agent::render_prompt_with",
    "demlik_tea::agent::render_prompt_with",
  ],
};
const historicalSourceInputFreeze =
  "09ab7c04355bfd512d3e8a863f9374876ece274979884b680cf4bab8a4c1deb1";
const argumentHashes = {
  "empty.fresh-array":
    "86f7ad0588bcb44cb39f25907eccf26dffcd18972243e842b07123799415ac5c",
  "head.null-versus-empty":
    "1561b163b4f703f1fa7a34222170c8dc0dc33c250f8547a45b05debb9bc74d75",
  "head.instructions-only":
    "ccb3c5725ca990aeb25bfb4b37e92900debbb862d3cc1e203daa82845e06d094",
  "head.input-utf16":
    "90d8240d9ab11988109b5f734677228f4466f225b235b39c991666ba3341803c",
  "history.plan-act-order":
    "9ed279b33565819dea41e11ee54b4583694c81eebf3a1f2842b6ed0143b381b4",
  "records.duplicates-orphans":
    "3728ca7889181fa1cd575aed43be2f1b17647700afee01842a00603d6d8847a7",
  "provider.presence":
    "91febd77ad500e766c8b119dddb03d45e9b0696f8c524305db10c667f9417908",
  "owners.original-handles":
    "f01c0d412ed6faf3c3dbe67d12fcfff6194a9020a5582a56c8c5921cc619b330",
  "parts.null-versus-empty":
    "1b342b5e8a21e0c56f8d4b8621b7d8120f2b2d10b25b03c68f2568b80c0aa828",
  "parts.media-original":
    "27fb690e4343f37e0c4f2cc34af03092b7fc17dd08d1a5485ffb22f8cb6ff0be",
  "parts.error-callback":
    "a0d1cf8c41a7c49ed214dddab21cdaa210ad3fc46c57af3a614036bafa12d767",
  "parts.failure-prefix":
    "7fe0dc9b28d20ecec7f29a61b47b642a6a15270a98634640b9733fecfa5f5c05",
  "indices.exact-number":
    "741bde064fbb0dc2f278c7c492a42feef4280febd954c8c58431568679f4735b",
  "indices.raw-null":
    "963eedae77ff39305b3e7ec82b57e55483c17e48510e076a98ec9fc7bfdc00a5",
  "history.turn-count-ignored":
    "8721c50e3fec2746ce3e5eb9cd6fda00f67322004a176506d4f3b53b38c1aad1",
  "render.repeat-no-cache":
    "eb8c53149762d0c07b5ee8ea0c6d44739a17ffdb474076cbebb00efe5bd9da87",
  "parts.mutate-after-render":
    "0dc799889a5504299dd006c5a806356f3e43c6c1efb5c416f255c19cce97b43f",
  "port.invoice-native-and-raw":
    "e06bc9029b54d85f3ecc64ea5223ff7f5ae39e3aad7c331dbdd2fa997c82d485",
};

function fixtures() {
  const file = path.join(
    root,
    "verification/parity/render-prompt-source-cases.json",
  );
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(data.cases.length, 18);
  assert.deepEqual(
    data.cases.map((row) => row.id),
    Object.keys(callVectors),
  );
  return data.cases;
}
function pins() {
  return Object.fromEntries(
    Object.entries(livePins).map(([file, expected]) => {
      const actual = fileHash(path.join(root, file));
      assert.equal(actual, expected, `current source pin ${file}`);
      return [file, actual];
    }),
  );
}
function record(file) {
  return {
    path: path.resolve(file),
    sha256: fileHash(file),
    bytes: fs.statSync(file).size,
  };
}
function bytes(value) {
  assert.ok(value && path.isAbsolute(value.path));
  const result = fs.readFileSync(value.path);
  assert.equal(hash(result), value.sha256, `captured bytes ${value.path}`);
  if (value.bytes !== undefined) assert.equal(result.length, value.bytes);
  return result;
}
function jsonRecord(value) {
  return JSON.parse(bytes(value));
}
function jsonFrame(value) {
  const text = bytes(value).toString("utf8");
  const lines = text.trim().split("\n");
  assert.equal(lines.length, 1, "exactly one actual response frame");
  return JSON.parse(lines[0]);
}
function nativeCapture(process, name) {
  return { path: process[name], sha256: process[`${name}Sha256`] };
}
function noTargetOverrides() {
  for (const key of [
    "CARGO_TARGET_DIR",
    "DEMLIK_MUTATION_TARGET_DIR",
    "CARGO_BUILD_TARGET_DIR",
    "CARGO_BUILD_BUILD_DIR",
  ])
    assert.equal(process.env[key], undefined, `${key} must be unset`);
}

export function normalizeRenderPromptReport(raw, producer = null) {
  assert.equal(raw.version, 1);
  assert.ok(
    ["fresh-source-first", "sealed-source-first"].includes(raw.lineage),
  );
  assert.deepEqual(raw.phases, ["source18", "native18"]);
  assert.deepEqual(raw.sourceHashesBefore, livePins, "Source before pins");
  assert.deepEqual(raw.sourceHashesAfter, livePins);
  assert.deepEqual(pins(), livePins);
  const source = jsonRecord(raw.source),
    native = jsonRecord(raw.native);
  assert.equal(source.attempted, 18);
  assert.equal(source.passed, 18);
  assert.deepEqual(source.failures, []);
  assert.equal(source.NativeProjectionStarted, false);
  assert.equal(source.RustCargoIcuExecutions, 0);
  assert.equal(source.typedProfiles, 17);
  assert.equal(source.rawInputRuntimeQualifiedProfiles, 1);
  const inputFreeze = jsonRecord(raw.sourceInputFreeze);
  assert.equal(source.sourceInputFreezeSha256, raw.sourceInputFreeze.sha256);
  if (raw.lineage === "sealed-source-first") {
    assert.equal(raw.metadataAssembly, true);
    assert.equal(source.sourceInputFreezeSha256, historicalSourceInputFreeze);
    for (const [file, digest] of Object.entries(historicalFixturePins))
      assert.equal(inputFreeze.files[file].sha256, digest);
  } else {
    assert.equal(raw.metadataAssembly, false);
    assert.deepEqual(inputFreeze.files, livePins);
    assert.deepEqual(inputFreeze.engine, engine);
    assert.equal(inputFreeze.SourceBeforeRustConstruction, false);
  }
  if (raw.lineage === "fresh-source-first") {
    assert.deepEqual(
      raw.executionSteps,
      source.rows.map((row) => row.process),
    );
    assert.equal(raw.executionSteps.length, 18);
  }
  assert.equal(native.attempted, 18);
  assert.equal(native.passed, 18);
  assert.equal(native.typedStrict, 17, "raw-null partition");
  assert.equal(native.runtimeQualified, 1, "raw-null partition");
  assert.deepEqual(native.failures, []);
  assert.equal(native.binaryUnchanged, true);
  assert.equal(native.source, raw.source.path);
  assert.equal(native.sourceSha256, raw.source.sha256);
  assert.ok(path.isAbsolute(native.binary));
  assert.match(native.binarySha256, /^[a-f0-9]{64}$/);
  if (fs.existsSync(native.binary))
    assert.equal(fileHash(native.binary), native.binarySha256);
  const cases = fixtures();
  assert.deepEqual(
    source.rows.map((row) => row.id),
    cases.map((row) => row.id),
  );
  assert.deepEqual(
    native.rows.map((row) => row.id),
    cases.map((row) => row.id),
  );
  const nativeEvidence = {},
    qualifiedNativeEvidence = {},
    rows = [];
  for (let i = 0; i < cases.length; i++) {
    const fixture = cases[i],
      left = source.rows[i],
      right = native.rows[i];
    const expected = left.observation,
      actual = right.native;
    assert.equal(left.passed, true);
    assert.equal(right.passed, true);
    assert.equal(expected.id, fixture.id);
    assert.deepEqual(expected.engine, engine);
    assert.equal(expected.profile, profiles[fixture.id]);
    assert.equal(right.profile, profiles[fixture.id]);
    assert.equal(
      hash(JSON.stringify(expected.argumentsBefore)),
      argumentHashes[fixture.id],
    );
    assert.deepEqual(
      expected.view,
      fixture.expected,
      `${fixture.id}: literal Source view`,
    );
    assert.equal(actual.id, fixture.id);
    assert.equal(actual.ok, true);
    assert.deepEqual(actual.view, expected.view, `${fixture.id}: whole view`);
    assert.deepEqual(right.expected, expected.view);
    assert.equal(left.process.exit, 0);
    if (raw.lineage === "fresh-source-first") {
      assert.equal(left.process.signal, null);
      assert.equal(left.process.error, null);
    }
    assert.deepEqual(jsonRecord(left.response), expected);
    assert.deepEqual(jsonFrame(left.process.stdout), expected);
    assert.equal(bytes(left.process.stderr).length, 0);
    const sourceRequest = jsonRecord(left.request);
    assert.deepEqual(sourceRequest, {
      id: fixture.id,
      expected: fixture.expected,
      response: left.response.path,
    });
    assert.equal(left.process.command[0], node22);
    assert.equal(left.process.command[1], "--import");
    assert.equal(
      path.basename(left.process.command[3]),
      "render-prompt-source.mts",
    );
    assert.equal(left.process.command[4], left.request.path);
    const proc = right.process;
    assert.equal(proc.status, 0);
    assert.equal(proc.signal, null);
    assert.equal(proc.timedOut, false);
    assert.deepEqual(proc.command, [native.binary, proc.request]);
    assert.equal(
      proc.binarySha256,
      native.binarySha256,
      `${fixture.id}: actual native binary`,
    );
    assert.deepEqual(jsonFrame(nativeCapture(proc, "stdout")), actual);
    assert.equal(bytes(nativeCapture(proc, "stderr")).length, 0);
    assert.deepEqual(
      jsonRecord(nativeCapture(proc, "request")),
      { id: fixture.id, arguments: expected.argumentsBefore },
      `${fixture.id}: native request`,
    );
    assert.deepEqual(
      actual.observedCalls,
      callVectors[fixture.id],
      `${fixture.id}: full observedCalls`,
    );
    assert.ok(
      actual.observedCalls.length &&
        actual.observedCalls.every((call) => typeof call === "string"),
    );
    const qualified = fixture.id === qualifiedId,
      id = globalId(fixture.id);
    (qualified ? qualifiedNativeEvidence : nativeEvidence)[id] =
      actual.observedCalls;
    rows.push({
      id,
      input: expected.argumentsBefore,
      passed: true,
      qualifications: qualified
        ? ["raw-record-turn-null-outside-published-type"]
        : [],
      source: expected,
      native: actual,
      nativeTrace: { observedCalls: actual.observedCalls },
      sourceProcess: left.process,
      nativeProcess: proc,
    });
  }
  assert.equal(Object.keys(nativeEvidence).length, 17);
  assert.deepEqual(Object.keys(qualifiedNativeEvidence), [
    globalId(qualifiedId),
  ]);
  if (raw.nativeLauncher) {
    assert.equal(raw.nativeLauncher.exit, 0);
    assert.equal(bytes(raw.nativeLauncher.stderr).length, 0);
    assert.deepEqual(jsonFrame(raw.nativeLauncher.stdout), {
      attempted: 18,
      passed: 18,
      typedStrict: 17,
      runtimeQualified: 1,
      failures: [],
    });
    assert.ok(raw.nativeLauncher.command.includes(raw.source.path));
    assert.ok(raw.nativeLauncher.command.includes(raw.native.path));
  } else
    assert.equal(
      raw.metadataAssembly,
      true,
      "live native launcher is required",
    );
  if (producer) {
    assert.equal(producer.binary, native.binary);
    assert.equal(producer.binarySha256, native.binarySha256);
    assert.equal(fileHash(producer.binary), native.binarySha256);
    assert.equal(fileHash(producer.actualArtifact), native.binarySha256);
    assertCheckPath(producer.actualArtifact, path.join(root, "target"));
    assert.equal(fileHash(producer.cargoJson), producer.cargoJsonSha256);
    assert.equal(
      producer.source.path,
      path.join(root, "crates/tea/examples/render_prompt_driver.rs"),
    );
    assert.equal(
      producer.source.sha256,
      livePins["crates/tea/examples/render_prompt_driver.rs"],
    );
    const library = producer.libraries.demlik_tea;
    assertCheckPath(library.path, path.join(root, "target"));
    assert.equal(fileHash(library.path), library.sha256);
  }
  return {
    reference: "75de37ea01a81cd7949e6275b7ee9cfdeb4e312d",
    engine: { ...engine },
    observations: 18,
    cases: 18,
    passed: 17,
    qualifiedPassed: 1,
    qualifiedEvidenceCases: 1,
    failures: [],
    nativeEvidence,
    qualifiedNativeEvidence,
    rows,
    rustBinarySha256: native.binarySha256,
    producer,
    binarySource: producer
      ? "actual Cargo-selected normal Tea example"
      : "no producer asserted (saved or caller override)",
    sourceHashesBefore: raw.sourceHashesBefore,
    sourceHashesAfter: raw.sourceHashesAfter,
    sourceExecutions: 18,
    nativeExecutions: 18,
    protocolRefusals: 0,
    responseGuards: 0,
    sourceFirst: {
      phases: raw.phases,
      lineage: raw.lineage,
      SourceBeforeRustConstruction: false,
    },
    fixtureHistory: {
      historicalFixturePins: { ...historicalFixturePins },
      historicalSourceInputFreeze,
      currentFixturePins: { ...livePins },
      originalSource18BeforeRustIsSeparateProof: true,
    },
    rawRecords: {
      source: raw.source,
      native: raw.native,
      sourceInputFreeze: raw.sourceInputFreeze,
    },
    qualification:
      "Only indices.raw-null is RAW/runtime-qualified: published number rejects null; no typed restored-null acceptance. Current formatted fixture differs from original executed bytes only by the separately retained formatting/AST history.",
  };
}

export function renderPromptCheckpointParity(cargo, options = {}) {
  noTargetOverrides();
  assert.equal(fs.realpathSync(process.execPath), fs.realpathSync(node22));
  assert.deepEqual(
    {
      node: process.version,
      v8: process.versions.v8,
      icu: process.versions.icu,
      locale: Intl.Collator().resolvedOptions().locale,
    },
    engine,
  );
  const reportFile = path.resolve(
    options.reportFile ?? path.join(root, "target/parity/render-prompt.json"),
  );
  assertCheckPath(reportFile, path.join(root, "target"));
  const folder = `${reportFile}.captures`;
  assert.ok(!fs.existsSync(folder));
  fs.mkdirSync(folder, { recursive: true });
  const executionSteps = [];
  const before = pins(),
    freezeFile = path.join(folder, "source-input-freeze.json");
  fs.writeFileSync(
    freezeFile,
    `${JSON.stringify({ files: before, engine, SourceBeforeRustConstruction: false }, null, 2)}\n`,
  );
  const sourceFile = path.join(folder, "source18.json");
  const source = {
    attempted: 0,
    passed: 0,
    failures: [],
    typedProfiles: 17,
    rawInputRuntimeQualifiedProfiles: 1,
    rows: [],
    sourceInputFreezeSha256: fileHash(freezeFile),
    NativeProjectionStarted: false,
    RustCargoIcuExecutions: 0,
    newSharedCredit: 0,
  };
  for (const fixture of fixtures()) {
    const response = path.join(folder, `${fixture.id}.source.response.json`);
    const request = path.join(folder, `${fixture.id}.source.request.json`);
    fs.writeFileSync(
      request,
      `${JSON.stringify({ id: fixture.id, response, expected: fixture.expected }, null, 2)}\n`,
    );
    const command = [
      node22,
      "--import",
      require.resolve("tsx"),
      path.join(root, "verification/parity/render-prompt-source.mts"),
      request,
    ];
    const requestBefore = record(request);
    const process = capture(folder, `${fixture.id}.source`, command);
    executionSteps.push(process);
    assert.equal(fileHash(request), requestBefore.sha256);
    const row = {
      id: fixture.id,
      request: requestBefore,
      process,
      passed: process.exit === 0,
      response: fs.existsSync(response) ? record(response) : null,
      observation: fs.existsSync(response)
        ? JSON.parse(fs.readFileSync(response, "utf8"))
        : null,
    };
    source.rows.push(row);
    source.attempted++;
    source.passed += Number(row.passed);
    if (!row.passed) source.failures.push(fixture.id);
    fs.writeFileSync(sourceFile, `${JSON.stringify(source, null, 2)}\n`);
    assert.equal(
      process.exit,
      0,
      `${fixture.id}: actual Source guard/process failure`,
    );
  }
  let producer = null,
    binary;
  if (options.binary) binary = path.resolve(options.binary);
  else {
    producer = buildTeaExample(
      cargo,
      "render_prompt_driver",
      `${reportFile}.producer`,
    );
    binary = producer.binary;
  }
  const binaryBefore = fileHash(binary),
    nativeFile = path.join(folder, "native18.json");
  const command = [
    process.env.DEMLIK_ICU77_PYTHON ?? "python3",
    path.join(root, "verification/parity/render-prompt-native.py"),
    "--source",
    sourceFile,
    "--binary",
    binary,
    "--output",
    nativeFile,
  ];
  const nativeLauncher = capture(folder, "native-launcher", command);
  assert.equal(fileHash(binary), binaryBefore);
  const raw = {
    version: 1,
    lineage: "fresh-source-first",
    metadataAssembly: false,
    phases: ["source18", "native18"],
    source: record(sourceFile),
    native: record(nativeFile),
    sourceInputFreeze: record(freezeFile),
    sourceHashesBefore: before,
    sourceHashesAfter: pins(),
    nativeLauncher,
    executionSteps,
  };
  fs.writeFileSync(
    `${reportFile}.raw.json`,
    `${JSON.stringify(raw, null, 2)}\n`,
  );
  const result = normalizeRenderPromptReport(raw, producer);
  fs.writeFileSync(reportFile, `${JSON.stringify(result, null, 2)}\n`);
  return result;
}
function capture(folder, name, command) {
  const startedAt = new Date().toISOString();
  const result = spawnSync(command[0], command.slice(1), {
    cwd: root,
    env: {
      ...process.env,
      PATH: `${path.dirname(node22)}${path.delimiter}${process.env.PATH}`,
      TMPDIR: "/private/tmp",
    },
    encoding: "utf8",
    timeout: 300000,
    maxBuffer: 16 * 1024 * 1024,
  });
  const stdout = path.join(folder, `${name}.stdout`),
    stderr = path.join(folder, `${name}.stderr`);
  fs.writeFileSync(stdout, result.stdout ?? "");
  fs.writeFileSync(stderr, result.stderr ?? "");
  const value = {
    name,
    command,
    cwd: root,
    exit: result.status,
    signal: result.signal,
    error: result.error?.message ?? null,
    startedAt,
    stdout: record(stdout),
    stderr: record(stderr),
  };
  fs.writeFileSync(
    path.join(folder, `${name}.process.json`),
    `${JSON.stringify(value, null, 2)}\n`,
  );
  if (result.error) throw result.error;
  assert.equal(result.signal, null);
  return value;
}
