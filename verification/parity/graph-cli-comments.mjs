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
import { commentCases, commentFixture } from "./comment-cli-cases.mjs";

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
  fs.mkdtempSync(path.join(os.tmpdir(), "demlik-cli-comments-")),
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
      ...["boundaries", "layers", "comments"].map((kind) =>
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
  "demlik_code_graph::cli::frontdoor::PreparedGatesCli::dispatch_comments",
];
function transport(value, id) {
  const row = traceSchema.parse(value);
  assert.equal(row.id, id);
  assert.ok(row.observedCalls.length >= 1 && row.observedCalls.length <= 8);
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
    comments: 8,
    continue: 8,
    thrown: 8,
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
        TSX_DISABLE_CACHE: "1",
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
const filter = process.env.DEMLIK_COMMENT_CASES?.split(",");
if (filter)
  assert.ok(
    filter.every((id) => commentCases.some(([candidate]) => candidate === id)),
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
    "comments/classify.ts",
    "comments/census.ts",
    "comments/ceilings.ts",
    "comments/gate.ts",
    "comments/ratchet.ts",
    "comments/render.ts",
    "config.ts",
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
      "Comments-only public prepared CLI continuation after env-keys; no standalone argv/bootstrap or later modes, all53CLI known gaps retained",
    passed: passed.length,
    attempted: valid.length,
    unqualifiedPairs: exact.length,
    qualifiedPairs: passed.length - exact.length,
    followupExecutions: passed.reduce(
      (n, row) => n + row.followups.source.length,
      0,
    ),
    pairedExecutions: passed.reduce(
      (n, row) => n + 1 + row.followups.source.length,
      0,
    ),
    rejectedInvalidInputs,
    responseGuards,
    profiles: {
      primaryFullProcess: valid.filter((row) => !row.componentOnly).length,
      fullProcess:
        valid.filter((row) => !row.componentOnly).length +
        valid.reduce((n, row) => n + row.followups.source.length, 0),
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
  for (const [id, options] of commentCases) {
    if (filter && !filter.includes(id)) continue;
    const location = path.join(directory, id);
    let fixture = commentFixture(location, options);
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
    const sourceFollowups = [];
    for (const step of options.followups ?? []) {
      const argv = [fixture.target, "--comments", ...step.flags];
      const trace = path.join(location, `source-${step.id}.jsonl`),
        ioTrace = path.join(location, `source-io-${step.id}.jsonl`);
      fs.writeFileSync(trace, "");
      fs.writeFileSync(ioTrace, "");
      fs.writeFileSync(
        requestFile,
        JSON.stringify({
          trace,
          ioTrace,
          fixture: fixture.root,
          input: { action: "frontdoor", argv },
        }),
      );
      const before = snapshot(fixture.root),
        previous = process.env.DEMLIK_FRONTDOOR_REQUEST;
      process.env.DEMLIK_FRONTDOOR_REQUEST = requestFile;
      let output;
      try {
        output = run(
          process.execPath,
          [
            "--import",
            loader,
            path.join(here, "cli-layer-source.mts"),
            ...argv,
          ],
          fixture.root,
          undefined,
          options,
        );
      } finally {
        if (previous === undefined) delete process.env.DEMLIK_FRONTDOOR_REQUEST;
        else process.env.DEMLIK_FRONTDOOR_REQUEST = previous;
      }
      sourceFollowups.push({
        id: step.id,
        argv,
        output,
        events: lines(trace),
        io: lines(ioTrace),
        before,
        after: snapshot(fixture.root),
      });
    }
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
    fixture = commentFixture(location, options);
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
    const nativeFollowups = [];
    for (const step of options.followups ?? []) {
      const argv = [fixture.target, "--comments", ...step.flags],
        trace = path.join(location, `native-${step.id}.json`);
      const request = { ...input, id: `${id}.${step.id}`, argv, trace },
        before = snapshot(fixture.root);
      const output = run(
        binary,
        [],
        fixture.root,
        JSON.stringify(request),
        options,
      );
      nativeFollowups.push({
        id: step.id,
        argv,
        output,
        before,
        after: snapshot(fixture.root),
        trace: fs.existsSync(trace)
          ? JSON.parse(fs.readFileSync(trace, "utf8"))
          : null,
      });
    }
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
      followups: { source: sourceFollowups, native: nativeFollowups },
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
        options.stage ?? (options.expectedThrow ? "thrown" : "comments");
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
        if (kind === "comments") {
          assert.equal(observed.outcome.result.exitCode, options.code);
          const attempted = source.io.filter(
            (event) => event.op === "stdio-write",
          );
          const payloads =
            options.out === undefined
              ? attempted
                  .filter((event) => event.stream === "stdout")
                  .map((event) => event.payload)
              : sourceFile
                ? [sourceFile.toString("utf8")]
                : [];
          const reports = attempted
            .filter(
              (event) =>
                event.stream === "stderr" &&
                !event.payload.startsWith("code-graph: wrote "),
            )
            .map((event) => {
              assert.ok(
                event.payload.startsWith("code-graph: ") &&
                  event.payload.endsWith("\n"),
              );
              return event.payload.slice(12, -1);
            });
          assert.deepEqual(observed.outcome.result.emitted, payloads);
          assert.deepEqual(observed.outcome.result.reports, reports);
          const expectedStored =
            options.code === 0 ? (options.initial ?? null) : options.code;
          assert.equal(observed.io.stored, expectedStored);
          assert.equal(observed.io.requested, expectedStored);
        }
      }
      if (!options.inactive)
        assert.deepEqual(
          nativeAfter,
          sourceAfter,
          "real file bytes and modes must match after independent runs",
        );
      assert.equal(sourceFollowups.length, nativeFollowups.length);
      for (let i = 0; i < sourceFollowups.length; i++) {
        const sourceStep = sourceFollowups[i],
          nativeStep = nativeFollowups[i];
        const checked = trusted(
          nativeStep.trace,
          `${id}.${sourceStep.id}`,
          "comments",
        );
        assert.equal(sourceStep.output.status, 0);
        assert.equal(nativeStep.output.status, 0);
        assert.equal(sourceStep.output.signal, null);
        assert.equal(nativeStep.output.signal, null);
        assert.equal(nativeStep.output.stdout, sourceStep.output.stdout);
        assert.equal(nativeStep.output.stderr, sourceStep.output.stderr);
        assert.deepEqual(nativeStep.before, sourceStep.before);
        assert.deepEqual(nativeStep.after, sourceStep.after);
        assert.equal(checked.outcome.result.exitCode, 0);
        assert.deepEqual(checked.io.pending, []);
        if (sourceStep.id === "repeat-record") {
          assert.deepEqual(
            sourceStep.before,
            sourceStep.after,
            "repeated recording is byte/mode idempotent",
          );
          assert.ok(
            sourceStep.io.some(
              (event) =>
                event.op === "writeFileSync-return" &&
                event.file.endsWith("/comment-ceilings.json"),
            ),
          );
          assert.equal(sourceStep.output.stdout, source.stdout);
          assert.deepEqual(checked.outcome.result.emitted, [
            sourceStep.output.stdout,
          ]);
        } else {
          const bytes = Buffer.from(
            sourceStep.after["report.json"].base64,
            "base64",
          );
          assert.deepEqual(JSON.parse(bytes.toString("utf8")), {
            defaultCeiling: 40,
            inheritedScopes: 0,
            passed: true,
            scopesChecked: 3,
            slackPoints: 2,
            violations: [],
          });
          assert.deepEqual(checked.outcome.result.emitted, [
            bytes.toString("utf8"),
          ]);
        }
      }
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
      if (id === "census-json") {
        const census = JSON.parse(source.stdout);
        assert.equal(census.totals.files, 4);
        assert.equal(census.totals.loc, 14);
        assert.equal(census.totals.blankLines, 4);
        assert.equal(census.totals.codeLines, 5);
        assert.equal(census.totals.commentLines, 5);
        assert.equal(census.totals.protectedLines, 1);
        assert.equal(
          source.io.filter(
            (event) => event.op === "workspace-marker" && event.exists,
          ).length,
          2,
        );
      }
      const rootPolicy = "comment-ceilings.json",
        policy =
          sourceAfter[rootPolicy] &&
          Buffer.from(sourceAfter[rootPolicy].base64, "base64").toString(
            "utf8",
          );
      if (id === "write-new")
        assert.deepEqual(JSON.parse(policy), {
          default: 40,
          scopes: {
            "packages/api": 50,
            "packages/auth": 0,
            "packages/billing": 100,
          },
          slackPoints: 2,
        });
      if (id === "write-preserves-policy") {
        const value = JSON.parse(policy);
        assert.equal(value.default, 17);
        assert.equal(value.slackPoints, 3);
        assert.ok(!("obsolete" in value.scopes));
      }
      if (id === "ci-pass-json")
        assert.deepEqual(JSON.parse(source.stdout), {
          defaultCeiling: 40,
          inheritedScopes: 0,
          passed: true,
          scopesChecked: 3,
          slackPoints: 2,
          violations: [],
        });
      if (id === "ci-exceeded")
        assert.deepEqual(JSON.parse(source.stdout).violations, [
          {
            ceiling: 49,
            delta: 1,
            direction: "EXCEEDED",
            inherited: false,
            measured: 50,
            scope: "packages/api",
          },
        ]);
      if (id === "second-root-write") {
        assert.ok(
          source.io.some((event) => event.op === "controlled-marker-removal"),
        );
        assert.equal(JSON.parse(policy).default, 17);
        assert.equal(
          JSON.parse(
            Buffer.from(
              sourceAfter["packages/api/comment-ceilings.json"].base64,
              "base64",
            ).toString("utf8"),
          ).default,
          40,
        );
      }
      if (
        [
          "ci-missing",
          "ci-and-write-missing",
          "ci-malformed",
          "ci-type-error",
          "raw-self-ci-missing",
          "raw-self-type-error",
        ].includes(id)
      )
        assert.ok(
          !source.io.some(
            (event) =>
              event.op === "readFileSync" && event.file.endsWith(".ts"),
          ),
          "Source config refusal precedes census",
        );
      if (id === "report-ignores-malformed")
        assert.ok(
          !source.io.some(
            (event) =>
              event.op === "readFileSync" &&
              event.file.endsWith("/comment-ceilings.json"),
          ),
        );
      if (id === "write-out-same")
        assert.ok(policy.startsWith("wrote 3 scope ceiling(s)"));
      if (
        id === "write-out-missing" ||
        id === "write-out-missing-initial" ||
        id === "write-nul-out"
      )
        assert.ok(policy, "ceiling write survives subsequent output refusal");
      if (id === "write-out") {
        const recorded = source.io.findIndex(
          (event) =>
            event.op === "writeFileSync-return" &&
            event.file.endsWith("/comment-ceilings.json"),
        );
        const output = source.io.findIndex(
          (event) =>
            event.op === "writeFileSync-return" && event.file === "result.txt",
        );
        assert.ok(
          recorded >= 0 && output > recorded,
          "policy is written before its view output",
        );
      }
      if (id === "raw-self-write")
        assert.ok(raw.outcome.result.emitted[0].includes("\ud800"));
      if (id === "raw-self-ci-missing")
        assert.ok(raw.outcome.result.reports[0].includes("\ud800"));
      if (id === "raw-self-write-readonly") {
        assert.ok(
          source.events
            .find((event) => event.event === "uncaught")
            .path.includes("�"),
        );
        assert.ok(!raw.outcome.error.details.path.includes("\ud800"));
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
