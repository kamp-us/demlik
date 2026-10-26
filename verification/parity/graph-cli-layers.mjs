import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { defineProgram } from "../../packages/code-graph/src/cli.js";
import { findRepoRoot } from "../../packages/code-graph/src/extract/project.js";
import { runLayerGate } from "../../packages/code-graph/src/layers/gate.js";
import { layerCases, layerFixture } from "./layer-cli-cases.mjs";

const binary = process.argv[2],
  reportFile = process.argv[3];
assert.ok(binary);
assert.ok(process.argv.length <= 4);
assert.equal(process.version, "v22.21.1");
assert.equal(process.versions.v8, "12.4.254.21-node.33");
const root = fileURLToPath(new URL("../..", import.meta.url)),
  here = path.join(root, "verification/parity"),
  loader = createRequire(import.meta.url).resolve("tsx");
const directory = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "demlik-cli-layers-")),
);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const logSchema = z.array(z.record(z.string(), z.unknown()));
const ioCause = z
  .object({
    kind: z.string(),
    rawCode: z.number().nullable(),
    message: z.string().min(1),
  })
  .strict();
const traceSchema = z
  .object({
    id: z.string(),
    outcome: z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("layers"),
          result: z
            .object({
              exitCode: z.union([z.literal(0), z.literal(1), z.literal(2)]),
              emitted: z.array(z.string()),
              reports: z.array(z.string()),
            })
            .strict(),
        })
        .strict(),
      z
        .object({
          kind: z.literal("continue"),
          sameCarrier: z.boolean(),
          samePrepared: z.boolean(),
          root: z.string(),
          repoRoot: z.string(),
          options: z.record(z.string(), z.unknown()),
        })
        .strict(),
      z
        .object({
          kind: z.literal("thrown"),
          error: z
            .object({
              name: z.string(),
              message: z.string().min(1),
              details: z.unknown(),
            })
            .strict(),
        })
        .strict(),
      ...["stopped", "api", "hexagon", "refused"].map((kind) =>
        z.object({ kind: z.literal(kind) }).strict(),
      ),
    ]),
    io: z
      .object({
        stored: z.number().nullable(),
        requested: z.number().nullable(),
        normal: z.number(),
        pending: z.array(
          z
            .object({
              stream: z.enum(["stdout", "stderr"]),
              attemptedBytes: z.number().int().nonnegative(),
              suppressedWrites: z.number().int().nonnegative(),
              cause: ioCause,
            })
            .strict(),
        ),
      })
      .strict(),
    exitCode: z.number().int(),
    observedCalls: z.array(z.string()),
  })
  .strict();
const callList = [
  "demlik_code_graph::cli::frontdoor::prepare_cli",
  "demlik_code_graph::cli::frontdoor::PreparedCli::dispatch_api_blocking",
  "demlik_code_graph::cli::frontdoor::PreparedCli::dispatch_hexagon",
  "demlik_code_graph::cli::frontdoor::PreparedCli::prepare_gates",
  "demlik_code_graph::cli::frontdoor::PreparedGatesCli::dispatch_layers",
];
const jsonLines = (file) =>
  fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
function run(command, args, cwd, input, opts) {
  const fd = fs.openSync(path.join(cwd, "readonly.txt"), "w+");
  fs.closeSync(fd);
  const ro = fs.openSync(path.join(cwd, "readonly.txt"), "r");
  try {
    const result = spawnSync(command, args, {
      cwd,
      encoding: "utf8",
      input,
      maxBuffer: 16 * 1024 * 1024,
      timeout: 15000,
      env: {
        ...process.env,
        ...(opts.withoutCompiler ? { PATH: "/nonexistent" } : {}),
      },
      stdio: [
        "pipe",
        opts.badStdout ? ro : "pipe",
        opts.badStderr ? ro : "pipe",
      ],
    });
    assert.ifError(result.error);
    return {
      status: result.status,
      signal: result.signal,
      stdout: result.stdout ?? null,
      stderr: result.stderr ?? null,
    };
  } finally {
    fs.closeSync(ro);
  }
}
function expectedKind(id, opts) {
  if (opts.inactive) return "continue";
  if (opts.hex) return "hexagon";
  if (id === "api-first") return "api";
  if (opts.badGlobal) return "stopped";
  if (opts.preLayer) return "refused";
  if (opts.expectedThrow) return "thrown";
  return "layers";
}
function transport(value, id) {
  const row = traceSchema.parse(value);
  assert.equal(row.id, id);
  assert.ok(
    row.observedCalls.length >= 1 &&
      row.observedCalls.length <= callList.length,
  );
  assert.deepEqual(
    row.observedCalls,
    callList.slice(0, row.observedCalls.length),
  );
  return row;
}
function trusted(value, id, kind) {
  const row = transport(value, id);
  assert.equal(row.id, id);
  assert.equal(row.outcome.kind, kind);
  const length = {
    stopped: 1,
    api: 2,
    hexagon: 3,
    refused: 4,
    layers: 5,
    continue: 5,
    thrown: 5,
  }[kind];
  assert.deepEqual(row.observedCalls, callList.slice(0, length));
  return row;
}
function sourceGate(fixture, argv) {
  const command = defineProgram().exitOverride();
  command.parse(argv, { from: "user" });
  const opts = command.opts();
  const rootAbsolute = fs.realpathSync(path.resolve(fixture.root, argv[0]));
  const repoRoot = findRepoRoot(rootAbsolute);
  const emitted = [],
    reports = [];
  const previous = process.cwd();
  try {
    process.chdir(fixture.root);
    const exitCode = runLayerGate({
      rootAbsolute,
      repoRoot,
      layerRulesFile: opts.layerRules,
      json: opts.json === true,
      pretty: opts.pretty === true,
      emit: (payload) => emitted.push(payload),
      report: (message) => reports.push(message),
    });
    return { exitCode, emitted, reports };
  } finally {
    process.chdir(previous);
  }
}
function projectionOptions(argv) {
  const command = defineProgram().exitOverride();
  command.parse(argv, { from: "user" });
  return command.opts();
}
const filter = process.env.DEMLIK_LAYER_CASES?.split(",");
if (filter)
  assert.ok(
    filter.every((id) => layerCases.some(([candidate]) => candidate === id)),
  );
const cases = [],
  failures = [],
  nativeEvidence = {},
  qualifiedNativeEvidence = {};
let rejectedInvalidInputs = 0;
let responseGuards = 0;
const sourceHashes = Object.fromEntries(
  [
    "index.ts",
    "cli.ts",
    "extract/project.ts",
    "layers/gate.ts",
    "layers/analyze.ts",
    "layers/resolve-target.ts",
    "layers/render.ts",
  ].map((file) => [
    file,
    hash(fs.readFileSync(path.join(root, "packages/code-graph/src", file))),
  ]),
);
function report() {
  const passed = cases.filter((row) => row.passed && !row.protocol).length;
  const exact = cases.filter(
    (row) => row.passed && !row.protocol && row.qualifications.length === 0,
  ).length;
  return {
    passed,
    attempted: cases.filter((row) => !row.protocol).length,
    unqualifiedPairs: exact,
    qualifiedPairs: passed - exact,
    rejectedInvalidInputs,
    responseGuards,
    scope:
      "Public native preparation/layers driver only; no standalone argv/bootstrap or later-mode execution. All 53 CLI known gaps remain.",
    profiles: {
      fullProcess: cases.filter((row) => !row.protocol && !row.componentOnly)
        .length,
      preparedContinuation: cases.filter((row) => row.componentOnly).length,
    },
    reference: { node: process.version, v8: process.versions.v8, sourceHashes },
    driverSha256: hash(fs.readFileSync(binary)),
    nativeEvidence,
    qualifiedNativeEvidence,
    failures,
    cases,
  };
}
function save() {
  if (reportFile)
    fs.writeFileSync(reportFile, JSON.stringify(report(), null, 2) + "\n");
}
try {
  for (const [id, opts] of layerCases) {
    if (filter && !filter.includes(id)) continue;
    const fixture = layerFixture(path.join(directory, id), opts);
    const sourceTrace = path.join(directory, id + "-source.jsonl"),
      ioTrace = path.join(directory, id + "-source-io.jsonl"),
      requestFile = path.join(directory, id + "-source-request.json"),
      nativeTrace = path.join(directory, id + "-native.json");
    fs.writeFileSync(sourceTrace, "");
    fs.writeFileSync(ioTrace, "");
    const sourceRequest = {
      trace: sourceTrace,
      ioTrace,
      fixture: fixture.root,
      rawArgv: opts.rawArgv,
      input: {
        action: "frontdoor",
        argv: fixture.argv,
        ...(opts.initial === undefined ? {} : { initial: opts.initial }),
      },
      removeMarkerAfterFirstFound: opts.removeMarker,
    };
    fs.writeFileSync(requestFile, JSON.stringify(sourceRequest));
    const previous = process.env.DEMLIK_FRONTDOOR_REQUEST;
    process.env.DEMLIK_FRONTDOOR_REQUEST = requestFile;
    let source;
    try {
      source = run(
        process.execPath,
        [
          "--import",
          loader,
          path.join(here, "cli-layer-source.mts"),
          ...(opts.rawArgv ? [] : fixture.argv),
        ],
        fixture.root,
        undefined,
        opts,
      );
    } finally {
      if (previous === undefined) delete process.env.DEMLIK_FRONTDOOR_REQUEST;
      else process.env.DEMLIK_FRONTDOOR_REQUEST = previous;
    }
    source.events = logSchema.parse(jsonLines(sourceTrace));
    source.io = logSchema.parse(jsonLines(ioTrace));
    const kind = expectedKind(id, opts);
    const gate =
      kind === "layers" || kind === "thrown"
        ? sourceGate(fixture, fixture.argv)
        : null;
    const out =
      opts.out === undefined || opts.out.includes("\0")
        ? null
        : path.resolve(fixture.root, opts.out);
    const sourceFile =
      out && fs.existsSync(out) && fs.statSync(out).isFile()
        ? fs.readFileSync(out)
        : null;
    if (sourceFile) fs.unlinkSync(out);
    if (opts.removeMarker)
      fs.writeFileSync(
        path.join(fixture.root, "pnpm-workspace.yaml"),
        "packages: []\n",
      );
    const input = {
      id,
      trace: nativeTrace,
      argv: fixture.argv,
      compiler: path.join(directory, "not-installed-tsgo"),
      ...(opts.initial === undefined ? {} : { initial: opts.initial }),
      ...(opts.removeMarker
        ? { removeMarker: path.join(fixture.root, "pnpm-workspace.yaml") }
        : {}),
    };
    const native = run(binary, [], fixture.root, JSON.stringify(input), opts);
    const raw = fs.existsSync(nativeTrace)
      ? JSON.parse(fs.readFileSync(nativeTrace, "utf8"))
      : null;
    const row = {
      id,
      input,
      source,
      native,
      gate,
      nativeTrace: raw,
      passed: false,
      qualifications: [],
      componentOnly: opts.inactive === true,
      sourceFile: sourceFile?.toString("utf8") ?? null,
    };
    let failureKind = "infrastructure";
    try {
      transport(raw, id);
      failureKind = "semantic";
      const observed = trusted(raw, id, kind);
      assert.equal(native.signal, null);
      assert.equal(source.signal, null);
      assert.equal(observed.exitCode, native.status);
      assert.ok(
        source.io
          .filter((entry) => entry.op === "process")
          .every((entry) => entry.args[0] === "git"),
        "unexpected compiler/process invocation",
      );
      if (opts.inactive) {
        row.qualifications.push("prepared-continuation");
        assert.equal(observed.outcome.sameCarrier, true);
        assert.equal(observed.outcome.samePrepared, true);
        assert.deepEqual(
          observed.outcome.options,
          projectionOptions(fixture.argv),
        );
        assert.equal(native.stdout, "");
        assert.equal(native.stderr, "");
        assert.equal(native.status, opts.initial ?? 0);
        assert.ok(
          !source.io.some(
            (entry) =>
              entry.op === "readFileSync" && entry.file === "rules.json",
          ),
        );
      } else if (opts.expectedThrow) {
        row.qualifications.push("backend-exception-output");
        const error = source.events.find((event) => event.event === "uncaught");
        assert.ok(error);
        assert.equal(native.status, 1);
        assert.equal(source.status, 1);
        assert.equal(observed.outcome.error.name, error.name);
        assert.equal(native.stdout, source.stdout);
        assert.equal(observed.io.pending.length, 0);
        assert.equal(observed.io.stored, opts.initial ?? null);
        assert.equal(observed.io.requested, opts.initial ?? null);
        const details = observed.outcome.error.details;
        if (error.code === "ERR_INVALID_ARG_VALUE") {
          assert.equal(details.code, error.code);
          assert.equal(details.location, "path");
          assert.equal(details.argument, opts.out);
          assert.ok(details.cause.message.length);
          assert.equal(details.cause.kind, "InvalidInput");
        } else {
          assert.equal(error.code, "EISDIR");
          assert.equal(details.path, opts.out);
          assert.equal(details.cause.kind, "IsADirectory");
          assert.equal(details.cause.rawCode, 21);
        }
        assert.equal(sourceFile, null);
        assert.ok(
          !out || !fs.existsSync(out) || fs.statSync(out).isDirectory(),
        );
        assert.ok(!source.io.some((entry) => entry.op === "stdio-write"));
      } else {
        assert.equal(native.status, source.status);
        if (kind === "layers") assert.deepEqual(observed.outcome.result, gate);
        const error = source.events.find((event) => event.event === "uncaught");
        if (error) {
          row.qualifications.push("stdio-runtime-notification");
          assert.equal(error.code, "EBADF");
          assert.equal(native.status, 1);
          assert.equal(observed.io.pending.length, 1);
          const pending = observed.io.pending[0];
          assert.equal(pending.stream, error.stream);
          assert.equal(pending.cause.rawCode, 9);
          assert.equal(pending.suppressedWrites, 0);
          const write = source.io.find(
            (entry) =>
              entry.op === "stdio-write" && entry.stream === error.stream,
          );
          assert.ok(write);
          assert.equal(
            pending.attemptedBytes,
            Buffer.byteLength(write.payload),
          );
          assert.equal(observed.io.requested, error.exitCode ?? null);
          assert.equal(observed.io.normal, 1);
        } else {
          assert.deepEqual(observed.io.pending, []);
          assert.equal(native.stdout, source.stdout);
          assert.equal(native.stderr, source.stderr);
        }
        if (sourceFile) {
          assert.ok(out && fs.existsSync(out));
          assert.deepEqual(fs.readFileSync(out), sourceFile);
          const write = source.io.findIndex(
            (entry) =>
              entry.op === "writeFileSync-return" && entry.file === opts.out,
          );
          const banner = source.io.findIndex(
            (entry) => entry.op === "stdio-write" && entry.stream === "stderr",
          );
          assert.ok(write >= 0 && banner > write);
        }
        if (id === "text") {
          assert.ok(
            native.stdout.includes(
              "scanned 6 files — 2 down, 2 sideways, 2 UP, 0 unlayered, 1 external, 1 unresolved",
            ),
          );
          assert.equal(
            source.io.filter((entry) => entry.op === "workspace-marker").length,
            6,
          );
        }
        if (id === "second-root-read") {
          assert.equal(gate.exitCode, 0);
          assert.equal(observed.outcome.result.exitCode, 0);
        }
        if (id.startsWith("unreachable-") && !opts.badUnreachable)
          assert.ok(
            !fs.existsSync(path.join(fixture.root, "unreachable-ledger.json")),
          );
        if (opts.preLayer)
          assert.ok(
            !source.io.some(
              (entry) =>
                entry.op === "readFileSync" && entry.file === "rules.json",
            ),
          );
      }
      if (opts.rawArgv) row.qualifications.push("javascript-argv");
      if (opts.removeMarker)
        row.qualifications.push("controlled-filesystem-transition");
      row.passed = true;
      const evidence = { observedCalls: observed.observedCalls };
      (row.qualifications.length ? qualifiedNativeEvidence : nativeEvidence)[
        id
      ] = evidence;
    } catch (error) {
      row.failure = String(error);
      failures.push({ id, kind: failureKind, message: String(error) });
    }
    cases.push(row);
    save();
  }
  const witness = cases.find((row) => row.passed && row.nativeTrace);
  if (witness) {
    for (const change of [
      (row) => {
        row.id = "foreign";
      },
      (row) => {
        row.observedCalls.push("foreign::call");
      },
      (row) => {
        row.observedCalls[0] = callList.at(-1);
      },
    ]) {
      const broken = structuredClone(witness.nativeTrace);
      change(broken);
      assert.throws(() =>
        trusted(broken, witness.id, witness.nativeTrace.outcome.kind),
      );
      responseGuards++;
    }
  }
  const invalid = [
    {},
    { id: "missing", argv: [], compiler: "x" },
    {
      id: "wrong-argv",
      trace: path.join(directory, "invalid1"),
      argv: [2],
      compiler: "x",
    },
    {
      id: "wrong-initial",
      trace: path.join(directory, "invalid2"),
      argv: [],
      compiler: "x",
      initial: "7",
    },
    {
      id: "null-initial",
      trace: path.join(directory, "invalid3"),
      argv: [],
      compiler: "x",
      initial: null,
    },
    {
      id: "unknown",
      trace: path.join(directory, "invalid4"),
      argv: [],
      compiler: "x",
      unknown: true,
    },
    {
      id: "null-marker",
      trace: path.join(directory, "invalid5"),
      argv: [],
      compiler: "x",
      removeMarker: null,
    },
  ];
  for (let index = 0; index < invalid.length; index++) {
    const result = spawnSync(binary, [], {
      encoding: "utf8",
      input: JSON.stringify(invalid[index]),
      timeout: 15000,
    });
    assert.ifError(result.error);
    assert.notEqual(result.status, 0);
    assert.ok(result.stderr.length);
    assert.equal(result.stdout, "");
    rejectedInvalidInputs++;
    cases.push({
      id: `invalid-${index}`,
      protocol: true,
      passed: true,
      qualifications: [],
      native: result,
    });
  }
  save();
  const output = report();
  console.log(
    JSON.stringify({
      passed: output.passed,
      attempted: output.attempted,
      unqualifiedPairs: output.unqualifiedPairs,
      qualifiedPairs: output.qualifiedPairs,
      rejectedInvalidInputs,
      failures: failures.slice(0, 4),
    }),
  );
  assert.equal(failures.length, 0);
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
