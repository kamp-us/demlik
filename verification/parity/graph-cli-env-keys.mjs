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
import {
  envKeyCases,
  envKeyFixture,
  ownershipLayouts,
} from "./env-keys-cli-cases.mjs";

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
  fs.mkdtempSync(path.join(os.tmpdir(), "demlik-cli-env-keys-")),
);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const cause = z
  .object({
    kind: z.string(),
    rawCode: z.number().nullable(),
    message: z.string().min(1),
  })
  .strict();
const resultSchema = z
  .object({
    exitCode: z.union([z.literal(0), z.literal(1), z.literal(2)]),
    emitted: z.array(z.string()),
    reports: z.array(z.string()),
  })
  .strict();
const envReport = z
  .object({
    declaredUnreferenced: z.array(
      z
        .object({
          key: z.string(),
          service: z.string(),
          configFile: z.string(),
        })
        .strict(),
    ),
    readNotDeclared: z.array(
      z
        .object({
          key: z.string(),
          file: z.string(),
          line: z.number(),
          service: z.string(),
        })
        .strict(),
    ),
    withheld: z.array(
      z
        .object({
          key: z.string(),
          reason: z.enum([
            "occurs-elsewhere-in-source",
            "read-site-owner-unknown",
            "read-site-owner-unparsed",
          ]),
        })
        .strict(),
    ),
    declaredCount: z.number(),
    readCount: z.number(),
    unparsedConfigs: z.array(z.string()),
  })
  .strict();
const traceSchema = z
  .object({
    id: z.string(),
    outcome: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("env-keys"), report: envReport }).strict(),
      ...["boundaries", "layers"].map((kind) =>
        z.object({ kind: z.literal(kind), result: resultSchema }).strict(),
      ),
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
              cause,
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
  "demlik_code_graph::cli::frontdoor::PreparedGatesCli::dispatch_boundaries",
  "demlik_code_graph::cli::frontdoor::PreparedGatesCli::dispatch_env_keys",
];
function transport(value, id) {
  const row = traceSchema.parse(value);
  assert.equal(row.id, id);
  assert.ok(row.observedCalls.length >= 1 && row.observedCalls.length <= 7);
  assert.deepEqual(
    row.observedCalls,
    callList.slice(0, row.observedCalls.length),
  );
  return row;
}
function trusted(value, id, kind) {
  const row = transport(value, id);
  assert.equal(row.outcome.kind, kind);
  const length = {
    stopped: 1,
    api: 2,
    hexagon: 3,
    refused: 4,
    layers: 5,
    boundaries: 6,
    "env-keys": 7,
    continue: 7,
    thrown: 7,
  }[kind];
  assert.deepEqual(row.observedCalls, callList.slice(0, length));
  return row;
}
function snapshot(root) {
  const files = {};
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) {
        const bytes = fs.readFileSync(absolute);
        files[path.relative(root, absolute)] = {
          sha256: hash(bytes),
          base64: bytes.toString("base64"),
          mode: fs.statSync(absolute).mode & 0o777,
        };
      }
    }
  };
  visit(root);
  return Object.fromEntries(
    Object.entries(files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}
function deltas(before, after) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .sort()
    .filter(
      (file) => JSON.stringify(before[file]) !== JSON.stringify(after[file]),
    )
    .map((file) => ({
      file,
      before: before[file] ?? null,
      after: after[file] ?? null,
    }));
}
function run(command, args, cwd, input, options) {
  fs.writeFileSync(path.join(cwd, "readonly.txt"), "");
  const fd = fs.openSync(path.join(cwd, "readonly.txt"), "r");
  try {
    const child = spawnSync(command, args, {
      cwd,
      input,
      encoding: "utf8",
      timeout: 15000,
      maxBuffer: 16 * 1024 * 1024,
      env: {
        ...process.env,
        ...(options.withoutCompiler ? { PATH: "/nonexistent" } : {}),
      },
      stdio: [
        "pipe",
        options.badStdout ? fd : "pipe",
        options.badStderr ? fd : "pipe",
      ],
    });
    assert.ifError(child.error);
    return {
      status: child.status,
      signal: child.signal,
      stdout: child.stdout ?? null,
      stderr: child.stderr ?? null,
    };
  } finally {
    fs.closeSync(fd);
  }
}
const lines = (file) =>
  fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
const filter = process.env.DEMLIK_ENV_KEY_CASES?.split(",");
if (filter)
  assert.ok(
    filter.every((id) => envKeyCases.some(([candidate]) => candidate === id)),
  );
const cases = [],
  failures = [],
  nativeEvidence = {},
  qualifiedNativeEvidence = {};
let rejectedInvalidInputs = 0,
  responseGuards = 0;
const sourceHashes = Object.fromEntries(
  [
    "index.ts",
    "cli.ts",
    "extract/project.ts",
    "syntax/file.ts",
    "env-keys/extract.ts",
    "env-keys/query.ts",
    "env-keys/read-site-owner.ts",
    "extract/wrangler-config.ts",
    "render/analysis.ts",
  ].map((file) => [
    file,
    hash(fs.readFileSync(path.join(root, "packages/code-graph/src", file))),
  ]),
);
function report() {
  const valid = cases.filter((row) => !row.protocol),
    passed = valid.filter((row) => row.passed),
    exact = passed.filter((row) => row.qualifications.length === 0);
  return {
    scope:
      "Env-keys-only public prepared CLI continuation after boundaries; no standalone argv/bootstrap or later modes, all53CLI known gaps retained",
    passed: passed.length,
    attempted: valid.length,
    unqualifiedPairs: exact.length,
    qualifiedPairs: passed.length - exact.length,
    rejectedInvalidInputs,
    responseGuards,
    profiles: {
      fullProcess: valid.filter((row) => !row.componentOnly).length,
      preparedContinuation: valid.filter((row) => row.componentOnly).length,
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
    fs.writeFileSync(reportFile, `${JSON.stringify(report(), null, 2)}\n`);
}
try {
  for (const [id, options] of envKeyCases) {
    if (filter && !filter.includes(id)) continue;
    const location = path.join(directory, id);
    let fixture = envKeyFixture(location, options);
    const sourceTrace = path.join(location, "source.jsonl"),
      ioTrace = path.join(location, "source-io.jsonl"),
      requestFile = path.join(location, "source-request.json"),
      nativeTrace = path.join(location, "native.json");
    fs.writeFileSync(sourceTrace, "");
    fs.writeFileSync(ioTrace, "");
    fs.writeFileSync(
      requestFile,
      JSON.stringify({
        trace: sourceTrace,
        ioTrace,
        fixture: fixture.root,
        rawArgv: options.rawArgv,
        input: {
          action: "frontdoor",
          argv: fixture.argv,
          ...(options.initial === undefined
            ? {}
            : { initial: options.initial }),
        },
        removeMarkerAfterFirstFound: options.removeMarker,
      }),
    );
    const sourceBefore = snapshot(fixture.root);
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
          ...(options.rawArgv ? [] : fixture.argv),
        ],
        fixture.root,
        undefined,
        options,
      );
    } finally {
      if (previous === undefined) delete process.env.DEMLIK_FRONTDOOR_REQUEST;
      else process.env.DEMLIK_FRONTDOOR_REQUEST = previous;
    }
    source.events = lines(sourceTrace);
    source.io = lines(ioTrace);
    const sourceAfter = snapshot(fixture.root);
    const out =
      options.out === undefined || options.out.includes("\0")
        ? null
        : path.resolve(fixture.root, options.out);
    const sourceFile =
      out && fs.existsSync(out) && fs.statSync(out).isFile()
        ? fs.readFileSync(out)
        : null;
    fs.rmSync(fixture.root, { recursive: true, force: true });
    fixture = envKeyFixture(location, options);
    const nativeBefore = snapshot(fixture.root);
    assert.deepEqual(
      nativeBefore,
      sourceBefore,
      "native inputs must not inherit Source outputs",
    );
    const input = {
      id,
      trace: nativeTrace,
      argv: fixture.argv,
      compiler: path.join(directory, "not-installed-tsgo"),
      ...(options.initial === undefined ? {} : { initial: options.initial }),
      ...(options.removeMarker
        ? { removeMarker: path.join(fixture.root, "pnpm-workspace.yaml") }
        : {}),
    };
    const native = run(
      binary,
      [],
      fixture.root,
      JSON.stringify(input),
      options,
    );
    const nativeAfter = snapshot(fixture.root);
    const raw = fs.existsSync(nativeTrace)
      ? JSON.parse(fs.readFileSync(nativeTrace, "utf8"))
      : null;
    const row = {
      id,
      input,
      source,
      native,
      nativeTrace: raw,
      passed: false,
      componentOnly: options.inactive === true,
      qualifications: [],
      files: {
        sourceBefore,
        sourceAfter,
        nativeBefore,
        nativeAfter,
        sourceDelta: deltas(sourceBefore, sourceAfter),
        nativeDelta: deltas(nativeBefore, nativeAfter),
      },
      sourceFile: sourceFile?.toString("utf8") ?? null,
    };
    let failureKind = "infrastructure";
    try {
      transport(raw, id);
      failureKind = "reference-expectation";
      if (options.expectedThrow) {
        assert.equal(source.status, 1);
        assert.ok(source.events.some((event) => event.event === "uncaught"));
      } else if (options.code !== undefined) {
        const expectedStatus =
          (options.badStdout && options.out === undefined) ||
          (options.badStderr &&
            (options.out !== undefined || options.code === 2))
            ? 1
            : options.code === 0
              ? (options.initial ?? 0)
              : options.code;
        assert.equal(
          source.status,
          expectedStatus,
          "Source must satisfy the independent case expectation",
        );
      }
      failureKind = "semantic";
      const kind =
        options.stage ?? (options.expectedThrow ? "thrown" : "env-keys");
      const observed = trusted(raw, id, kind);
      assert.equal(native.signal, null);
      assert.equal(source.signal, null);
      assert.equal(observed.exitCode, native.status);
      assert.ok(
        source.io
          .filter((event) => event.op === "process")
          .every((event) => event.args[0] === "git"),
        "unexpected compiler invocation",
      );
      if (options.inactive) {
        row.qualifications.push("prepared-continuation");
        assert.equal(observed.outcome.sameCarrier, true);
        assert.equal(observed.outcome.samePrepared, true);
        const command = defineProgram().exitOverride();
        command.parse(fixture.argv, { from: "user" });
        assert.deepEqual(observed.outcome.options, command.opts());
        assert.equal(native.stdout, "");
        assert.equal(native.stderr, "");
        assert.equal(native.status, options.initial ?? 0);
      } else if (options.expectedThrow) {
        row.qualifications.push("backend-exception-output");
        const error = source.events.find((event) => event.event === "uncaught");
        assert.ok(error);
        assert.equal(source.status, 1);
        assert.equal(native.status, 1);
        assert.equal(observed.outcome.error.name, error.name);
        assert.equal(native.stdout, source.stdout);
        assert.equal(native.stderr, "");
        assert.deepEqual(observed.io.pending, []);
        assert.equal(observed.io.stored, options.initial ?? null);
        assert.equal(observed.io.requested, options.initial ?? null);
        const details = observed.outcome.error.details;
        if (error.code === "ERR_INVALID_ARG_VALUE") {
          assert.equal(details.code, error.code);
          assert.equal(details.location, "path");
          assert.equal(details.argument, options.out);
          assert.equal(details.cause.kind, "InvalidInput");
        } else if (error.code) {
          assert.equal(details.path, error.path);
          assert.equal(
            details.cause.rawCode,
            { ENOENT: 2, EISDIR: 21, EACCES: 13 }[error.code],
          );
          assert.ok(details.cause.message.length);
        } else assert.equal(observed.outcome.error.message, error.message);
      } else {
        assert.equal(native.status, source.status);
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
            (event) =>
              event.op === "stdio-write" && event.stream === error.stream,
          );
          assert.ok(write);
          assert.equal(
            pending.attemptedBytes,
            Buffer.byteLength(write.payload),
          );
          assert.equal(observed.io.requested, error.exitCode ?? null);
          assert.equal(observed.io.normal, 1);
          if (error.stream !== "stdout")
            assert.equal(native.stdout, source.stdout);
        } else {
          assert.deepEqual(observed.io.pending, []);
          assert.equal(native.stdout, source.stdout);
          assert.equal(native.stderr, source.stderr);
        }
        if (kind === "env-keys") {
          const attempted = source.io.filter(
            (event) => event.op === "stdio-write" && event.stream === "stdout",
          );
          const payload =
            options.out === undefined
              ? attempted[0]?.payload
              : sourceFile?.toString("utf8");
          if (options.flags?.includes("--json"))
            assert.deepEqual(observed.outcome.report, JSON.parse(payload));
          assert.equal(observed.io.stored, options.initial ?? null);
          assert.equal(observed.io.requested, options.initial ?? null);
        }
      }
      if (!options.inactive)
        assert.deepEqual(
          nativeAfter,
          sourceAfter,
          "real file bytes and modes must match after independent runs",
        );
      if (options.out !== undefined && sourceFile) {
        assert.ok(out);
        assert.deepEqual(fs.readFileSync(out), sourceFile);
        const write = source.io.findIndex(
          (event) =>
            event.op === "writeFileSync-return" && event.file === options.out,
        );
        const banner = source.io.findIndex(
          (event) => event.op === "stdio-write" && event.stream === "stderr",
        );
        assert.ok(write >= 0 && banner > write);
      }
      if (kind === "env-keys") {
        const report = observed.outcome.report;
        if (
          id.startsWith("workers-") ||
          id.startsWith("out-") ||
          [
            "no-compiler",
            "later-flags",
            "zero-preserves-initial",
            "ci-prepared-unused",
            "accept-smells-unused",
          ].includes(id)
        ) {
          assert.equal(report.declaredCount, 3);
          assert.equal(report.readCount, 5);
          assert.deepEqual(
            report.declaredUnreferenced.map((row) => row.key),
            ["LEGACY_FLAG"],
          );
          assert.equal(report.withheld.length, 3);
          assert.equal(report.readNotDeclared.length, 0);
        }
        if (options.layout !== undefined) {
          const layout = ownershipLayouts[options.layout];
          assert.deepEqual(
            report.readNotDeclared.map((row) => [row.key, row.service]),
            layout.findings,
          );
          assert.deepEqual(
            report.withheld.map((row) => [row.key, row.reason]),
            layout.withheld,
          );
        }
        if (id === "scan-destructure") {
          assert.equal(report.declaredCount, 6);
          assert.equal(report.readCount, 10);
          assert.deepEqual(
            report.readNotDeclared.map((row) => row.key),
            ["BAG", "ODD", "OPTIONAL", "rest"],
          );
          assert.deepEqual(
            report.withheld.map((row) => row.key),
            ["DYNAMIC", "ONLY_TEXT"],
          );
        }
        if (id === "tab-read-collision") assert.equal(report.readCount, 1);
        if (id === "scan-duplicate-lines") assert.equal(report.readCount, 4);
        if (id === "scan-env-type-boundary") assert.equal(report.readCount, 4);
        if (id === "tab-declaration-collision")
          assert.equal(report.declaredCount, 1);
        if (id === "second-root-read") {
          assert.equal(report.declaredCount, 1);
          assert.equal(report.readCount, 2);
          assert.ok(
            source.io.some((event) => event.op === "controlled-marker-removal"),
          );
        }
        if (id === "raw-root")
          assert.equal(
            report.withheld.at(-1).reason,
            "read-site-owner-unknown",
          );
        if (id === "raw-ancestor")
          assert.equal(
            report.readNotDeclared[0].file,
            "workers/api/nested\ud800/src/index.ts",
          );
        if (id === "workers-json") {
          assert.equal(
            source.io.filter(
              (event) => event.op === "workspace-marker" && event.exists,
            ).length,
            2,
          );
          const reads = source.io.filter(
            (event) => event.op === "readFileSync",
          );
          const sourceIndex = reads.findIndex((event) =>
            event.file.endsWith("/src/index.ts"),
          );
          const catalogIndex = reads.findIndex((event) =>
            event.file.endsWith("/wrangler.jsonc"),
          );
          assert.ok(
            sourceIndex >= 0 && catalogIndex >= 0,
            "both source and catalog reads must actually be observed",
          );
          assert.ok(
            sourceIndex < catalogIndex,
            "source is read before the catalog",
          );
        }
      }
      if (options.rawArgv) row.qualifications.push("javascript-argv");
      if (options.removeMarker)
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
  if (witness)
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
    const child = spawnSync(binary, [], {
      encoding: "utf8",
      input: JSON.stringify(invalid[index]),
      timeout: 15000,
    });
    assert.ifError(child.error);
    assert.notEqual(child.status, 0);
    assert.ok(child.stderr.length);
    assert.equal(child.stdout, "");
    rejectedInvalidInputs++;
    cases.push({
      id: `invalid-${index}`,
      protocol: true,
      passed: true,
      qualifications: [],
      native: {
        status: child.status,
        stdout: child.stdout,
        stderr: child.stderr,
      },
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
      responseGuards,
      failures: failures.slice(0, 5),
    }),
  );
  assert.equal(failures.length, 0);
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
