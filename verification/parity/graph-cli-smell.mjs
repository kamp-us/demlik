import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  editSmell,
  smellCases,
  smellFixture,
  smellSteps,
} from "./cli-smell-cases.mjs";

const [binaryArg, reportArg] = process.argv.slice(2);
assert.ok(binaryArg && reportArg);
const binary = path.resolve(binaryArg),
  reportFile = path.resolve(reportArg);
assert.equal(process.version, "v22.21.1");
assert.equal(process.versions.v8, "12.4.254.21-node.33");
const root = fileURLToPath(new URL("../..", import.meta.url));
const require = createRequire(import.meta.url),
  loader = require.resolve("tsx");
const nativeRequire = createRequire(
  createRequire(path.join(root, "packages/code-graph/package.json")).resolve(
    "@typescript/native-preview/package.json",
  ),
);
const compiler = fs.realpathSync(
  path.join(
    path.dirname(
      nativeRequire.resolve(
        "@typescript/native-preview-darwin-arm64/package.json",
      ),
    ),
    "lib/tsgo",
  ),
);
fs.mkdirSync(path.join(root, "target/parity"), { recursive: true });
const temporary = fs.realpathSync(
  fs.mkdtempSync(path.join(root, "target/parity/cli-smell-")),
);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const calls = [
  "prepare_cli",
  "PreparedCli::dispatch_api_blocking",
  "PreparedCli::dispatch_hexagon",
  "PreparedCli::prepare_gates",
  "PreparedGatesCli::dispatch_layers",
  "PreparedGatesCli::dispatch_boundaries",
  "PreparedGatesCli::dispatch_env_keys",
  "PreparedGatesCli::dispatch_comments",
  "PreparedGatesCli::dispatch_collapse_gate",
  "PreparedGatesCli::dispatch_unreachable_blocking",
  "PreparedGatesCli::dispatch_smell_ledger_blocking",
  "PreparedGatesCli::dispatch_plain_collapse_blocking",
].map((s) => `demlik_code_graph::cli::frontdoor::${s}`);
const ioError = z.strictObject({
  kind: z.string(),
  rawCode: z.number().nullable(),
  message: z.string().min(1),
});
const traceSchema = z.strictObject({
  id: z.string(),
  outcome: z
    .object({
      kind: z.enum([
        "stopped",
        "api",
        "hexagon",
        "refused",
        "layers",
        "boundaries",
        "env-keys",
        "comments",
        "collapse",
        "continue",
        "plain-collapse",
        "plain-load-refused",
        "unreachable",
        "unreachable-load-refused",
        "smell-ledger",
        "smell-load-refused",
        "thrown",
      ]),
    })
    .passthrough(),
  io: z.strictObject({
    stored: z.number().nullable(),
    requested: z.number().nullable(),
    normal: z.number(),
    pending: z.array(
      z.strictObject({
        stream: z.enum(["stdout", "stderr"]),
        attemptedBytes: z.number().int().nonnegative(),
        suppressedWrites: z.number().int().nonnegative(),
        cause: ioError,
      }),
    ),
  }),
  exitCode: z.number(),
  observedCalls: z.array(z.string()),
  writeObservations: z.array(
    z.strictObject({
      stream: z.enum(["stdout", "stderr"]),
      payload: z.string(),
      fileAtAck: z
        .array(z.number().int().min(0).max(255))
        .nullable()
        .optional(),
    }),
  ),
});
function trusted(raw, id) {
  const value = traceSchema.parse(raw);
  assert.equal(value.id, id);
  assert.ok(
    value.observedCalls.length > 0 &&
      value.observedCalls.length <= calls.length,
  );
  assert.deepEqual(
    value.observedCalls,
    calls.slice(0, value.observedCalls.length),
  );
  return value;
}
function snapshot(folder) {
  const files = {};
  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const name = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(name);
      else if (entry.isFile())
        files[path.relative(folder, name)] = {
          base64: fs.readFileSync(name).toString("base64"),
          mode: fs.statSync(name).mode & 0o777,
        };
    }
  }
  visit(folder);
  return Object.fromEntries(
    Object.entries(files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}
function processRun(command, args, cwd, input, o, extra = {}) {
  const fd = fs.openSync(path.join(cwd, "readonly.txt"), "r");
  try {
    const result = spawnSync(command, args, {
      cwd,
      input,
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 32 << 20,
      env: { ...process.env, TSX_DISABLE_CACHE: "1", ...extra },
      stdio: ["pipe", o.badStdout ? fd : "pipe", o.badStderr ? fd : "pipe"],
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    return {
      status: result.status,
      signal: result.signal,
      stdout: result.stdout ?? null,
      stderr: result.stderr ?? null,
    };
  } finally {
    fs.closeSync(fd);
  }
}
function jsonLines(file) {
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map(JSON.parse);
}
function execute(f, o, step, location, id, native) {
  const fixtureBeforeEdit = snapshot(f.root);
  editSmell(f, step);
  const before = snapshot(f.root),
    ledger = path.join(f.root, "smell-ledger.json");
  const stamp = () => {
    const s = fs.statSync(ledger, { bigint: true });
    return `${s.ino}/${s.mtimeNs}/${s.size}`;
  };
  const ledgerBefore = stamp(),
    trace = path.join(
      location,
      `${native ? "native" : "source"}-${step.id}.jsonl`,
    ),
    ioTrace = path.join(location, `source-io-${step.id}.jsonl`);
  let output, events, io, observed;
  const warningMarker = o.freshDataRoot
    ? path.join(f.root, f.physical, "pnpm-workspace.yaml")
    : undefined;
  if (native) {
    output = processRun(
      binary,
      [],
      f.root,
      JSON.stringify({
        id,
        trace,
        argv: f.argv,
        compiler: o.withoutCompiler
          ? path.join(location, "compiler-does-not-exist")
          : compiler,
        plain: true,
        lateSmell: true,
        ...(o.initial === undefined ? {} : { initial: o.initial }),
        ...(warningMarker ? { warningMarker } : {}),
      }),
      o,
    );
    observed = JSON.parse(fs.readFileSync(trace, "utf8"));
  } else {
    fs.writeFileSync(trace, "");
    fs.writeFileSync(ioTrace, "");
    const request = path.join(location, "request.json");
    fs.writeFileSync(
      request,
      JSON.stringify({
        trace,
        ioTrace,
        fixture: f.root,
        rawArgv: o.rawArgv,
        input: {
          action: "frontdoor",
          argv: f.argv,
          ...(o.initial === undefined ? {} : { initial: o.initial }),
        },
        warningMarker,
      }),
    );
    output = processRun(
      process.execPath,
      [
        "--import",
        loader,
        path.join(root, "verification/parity/cli-plain-collapse-source.mts"),
        ...(o.rawArgv ? [] : f.argv),
      ],
      f.root,
      undefined,
      o,
      { DEMLIK_FRONTDOOR_REQUEST: request },
    );
    events = jsonLines(trace);
    io = jsonLines(ioTrace);
  }
  return {
    step: step.id,
    argv: [...f.argv],
    fixtureBeforeEdit,
    before,
    files: snapshot(f.root),
    ledgerUnchanged: ledgerBefore === stamp(),
    output,
    ...(native ? { trace: observed } : { events, io }),
  };
}
const sourceFiles = [
  "index.ts",
  "cli.ts",
  "smells/gate.ts",
  "smells/ledger.ts",
  "smells/ledger-render.ts",
  "smells/rules.ts",
  "extract/assemble.ts",
  "extract/project.ts",
];
const sourceHashes = Object.fromEntries(
  sourceFiles.map((file) => [
    file,
    hash(fs.readFileSync(path.join(root, "packages/code-graph/src", file))),
  ]),
);
const cases = [],
  protocol = [],
  failures = [],
  nativeEvidence = {},
  qualifiedNativeEvidence = {};
let responseGuards = 0;
function report() {
  return {
    scope:
      "Prepared smell-ledger CI/accept only; ordinary smells/generic CI and all53 CLI gaps remain OPEN",
    reference: {
      node: process.version,
      v8: process.versions.v8,
      sourceHashes,
      compilerSha256: hash(fs.readFileSync(compiler)),
    },
    driverSha256: hash(fs.readFileSync(binary)),
    passed: cases.filter((r) => r.passed).length,
    attempted: cases.length,
    strictPairs: cases.filter(
      (r) => r.passed && !r.nativeOnly && !r.qualifications.length,
    ).length,
    qualifiedPairs: cases.filter(
      (r) => r.passed && !r.nativeOnly && r.qualifications.length,
    ).length,
    nativeOnlyCases: cases.filter((r) => r.passed && r.nativeOnly).length,
    pairedExecutions: cases.reduce((n, r) => n + r.source.length, 0),
    responseGuards,
    rejectedInvalidInputs: protocol.length,
    nativeEvidence,
    qualifiedNativeEvidence,
    failures,
    cases: [...cases, ...protocol],
  };
}
const save = () =>
  fs.writeFileSync(reportFile, `${JSON.stringify(report(), null, 2)}\n`);
const selected = process.env.DEMLIK_SMELL_CLI_CASES?.split(",");
if (selected)
  assert.ok(
    selected.every((id) => smellCases.some(([candidate]) => candidate === id)),
  );
try {
  for (const [id, o] of smellCases) {
    if (selected && !selected.includes(id)) continue;
    const location = path.join(temporary, id);
    fs.mkdirSync(location);
    let f = smellFixture(location, o);
    const before = snapshot(f.root),
      steps = o.workflow ? smellSteps : [{ id: "main" }];
    const source = o.nativeOnly
      ? []
      : steps.map((step) => execute(f, o, step, location, id, false));
    fs.rmSync(f.root, { recursive: true, force: true });
    f = smellFixture(location, o);
    assert.deepEqual(snapshot(f.root), before);
    const native = steps.map((step) => execute(f, o, step, location, id, true));
    const row = {
      id,
      passed: false,
      nativeOnly: o.nativeOnly === true,
      qualifications: [],
      before,
      source,
      native,
    };
    let failureKind = "protocol";
    try {
      for (let i = 0; i < native.length; i++) {
        const n = native[i],
          observed = trusted(n.trace, id);
        failureKind = "semantic";
        if (o.nativeOnly) {
          assert.equal(
            observed.outcome.kind,
            o.missingCompiler ? "thrown" : "continue",
          );
          if (o.missingCompiler) {
            assert.equal(observed.outcome.error.name, "Error");
            assert.ok(observed.outcome.error.message.length > 0);
          } else {
            assert.equal(observed.outcome.sameCarrier, true);
            assert.equal(observed.outcome.samePrepared, true);
          }
          assert.equal(n.output.stdout, "");
          assert.equal(n.output.stderr, "");
          assert.deepEqual(n.files, before);
          continue;
        }
        const s = source[i];
        failureKind = "protocol";
        assert.ok(
          s.io.some((event) => event.op === "exit"),
          "actual Source CLI reached exit observer",
        );
        failureKind = "semantic";
        assert.deepEqual(n.fixtureBeforeEdit, s.fixtureBeforeEdit);
        assert.deepEqual(n.before, s.before);
        assert.deepEqual(
          n.files,
          s.files,
          "actual bytes/modes after execution",
        );
        const error = s.events.find((event) => event.event === "uncaught");
        const writes = s.io
          .filter((event) => event.op === "stdio-write")
          .map(({ stream, payload }) => ({ stream, payload }));
        const expectedKind =
          error && error.stream === undefined
            ? "thrown"
            : id.endsWith("refused") || id === "schema-refusal-before-load"
              ? "refused"
              : id === "node-rule-refusal-before-smell"
                ? "stopped"
                : id === "env-priority"
                  ? "env-keys"
                  : id === "comments-priority"
                    ? "comments"
                    : id === "edge-no-config" ||
                        id === "warning-before-edge-refusal" ||
                        o.expectLoadRefused
                      ? "smell-load-refused"
                      : "smell-ledger";
        assert.equal(observed.outcome.kind, expectedKind);
        if (error && error.stream === undefined) {
          row.qualifications.push("backend-exception-diagnostic-qualified");
          assert.equal(n.output.status, 1);
          assert.equal(observed.outcome.error.name, error.name);
          assert.equal(n.output.stdout, s.output.stdout);
          assert.equal(
            n.output.stderr,
            writes
              .filter((event) => event.stream === "stderr")
              .map((event) => event.payload)
              .join(""),
          );
          if (error.code) {
            const detail = observed.outcome.error.details;
            assert.equal(detail.path, error.path);
            assert.equal(
              detail.cause.rawCode,
              { EISDIR: 21, EACCES: 13, ENOENT: 2 }[error.code],
            );
          } else if (id !== "kinds-catalog-failure")
            assert.equal(observed.outcome.error.message, error.message);
        } else if (error) {
          row.qualifications.push("pending-stdio-notification-contract");
          assert.equal(error.code, "EBADF");
          assert.equal(n.output.status, 1);
          assert.equal(observed.io.pending.length, 1);
          const pending = observed.io.pending[0],
            attempted = writes.filter((w) => w.stream === error.stream);
          assert.equal(pending.stream, error.stream);
          assert.equal(pending.cause.rawCode, 9);
          assert.equal(
            pending.attemptedBytes,
            Buffer.byteLength(attempted[0].payload),
          );
          assert.equal(pending.suppressedWrites, attempted.length - 1);
          if (error.stream !== "stdout")
            assert.equal(n.output.stdout, s.output.stdout);
          if (error.stream !== "stderr")
            assert.equal(
              n.output.stderr,
              writes
                .filter((w) => w.stream === "stderr")
                .map((w) => w.payload)
                .join(""),
            );
        } else {
          assert.equal(n.output.status, s.output.status);
          assert.equal(n.output.stdout, s.output.stdout);
          assert.equal(n.output.stderr, s.output.stderr);
          assert.deepEqual(observed.io.pending, []);
          assert.deepEqual(
            observed.writeObservations.map(({ stream, payload }) => ({
              stream,
              payload,
            })),
            writes.map((event) =>
              o.rawArgv
                ? { ...event, payload: event.payload.toWellFormed() }
                : event,
            ),
          );
        }
        if (o.controlled)
          row.qualifications.push("controlled-warning-filesystem-transition");
        if (o.rawArgv)
          row.qualifications.push(
            "raw-JavaScript-argv-callback-units-qualified",
          );
        if (o.withoutCompiler)
          assert.ok(
            !s.io.some(
              (event) =>
                event.op === "process" &&
                String(event.args[0]).endsWith("/tsgo"),
            ),
            "cheap path never starts compiler",
          );
        if (o.workflow) {
          const step = steps[i],
            ledger = JSON.parse(
              Buffer.from(n.files["smell-ledger.json"].base64, "base64"),
            );
          assert.equal(n.output.status, step.exit ?? 0);
          assert.equal(ledger.entries.length, step.entries);
          assert.equal(n.ledgerUnchanged, s.ledgerUnchanged);
          if (step.unchanged) assert.equal(n.ledgerUnchanged, true);
          if (i <= 3)
            assert.equal(
              ledger.entries.find((entry) =>
                entry.target.startsWith(`${f.target}/`),
              ).reason,
              "A first",
            );
          if (i === 4 || i === 5)
            assert.equal(
              ledger.entries.find((entry) =>
                entry.target.startsWith(`${f.target}/`),
              ).reason,
              "worse accepted",
            );
          if (i >= 6)
            assert.ok(
              ledger.entries.every((entry) =>
                entry.target.startsWith("packages/second/"),
              ),
            );
        }
        if (id === "cheap-ci-text" || id === "edge-fanin-ci")
          assert.equal(n.output.status, 1);
        if (id === "edge-only-does-not-read-catalog")
          assert.equal(n.output.status, 1);
        if (id === "accept-out-mode") {
          assert.equal(n.files[o.out].mode, 0o640);
          assert.equal(n.files["smell-ledger.json"].mode, 0o640);
        }
        if (
          id === "ledger-write-before-out-failure" ||
          id === "bad-stdout-after-ledger-write"
        )
          assert.notEqual(
            n.files["smell-ledger.json"].base64,
            before["smell-ledger.json"].base64,
          );
        if (id === "ledger-write-refusal")
          assert.deepEqual(
            n.files["smell-ledger.json"],
            before["smell-ledger.json"],
          );
        if (
          id === "accept-success-preserves-initial" ||
          id === "zero-ci-preserves-initial"
        )
          assert.equal(observed.io.stored, 7);
        if (id === "fresh-data-stored-ledger-root") {
          assert.ok(n.files[`${f.physical}/pnpm-workspace.yaml`]);
          assert.ok(!n.files[`${f.physical}/smell-ledger.json`]);
          assert.notEqual(
            n.files["smell-ledger.json"].base64,
            before["smell-ledger.json"].base64,
          );
        }
        if (o.out !== undefined && !error) {
          const ack = observed.writeObservations.find((event) =>
            event.payload.startsWith("code-graph: wrote "),
          );
          assert.ok(ack);
          assert.deepEqual(ack.fileAtAck, [
            ...Buffer.from(n.files[o.out].base64, "base64"),
          ]);
          const write = s.io.findIndex(
            (event) =>
              event.op === "writeFileSync-return" &&
              path.resolve(f.root, event.file) === path.resolve(f.root, o.out),
          );
          assert.ok(
            write >= 0 &&
              write <
                s.io.findIndex(
                  (event) =>
                    event.op === "stdio-write" &&
                    event.payload.startsWith("code-graph: wrote "),
                ),
          );
        }
      }
      row.qualifications = [...new Set(row.qualifications)];
      row.passed = true;
      if (!row.nativeOnly) {
        row.nativeTrace = {
          observedCalls: [
            ...new Set(native.flatMap((n) => n.trace.observedCalls)),
          ],
        };
        (row.qualifications.length ? qualifiedNativeEvidence : nativeEvidence)[
          id
        ] = row.nativeTrace;
      }
    } catch (error) {
      row.failure = String(error);
      failures.push({ id, kind: failureKind, message: String(error) });
    }
    cases.push(row);
    save();
  }
  const witness = cases.find((row) => row.passed && !row.nativeOnly)?.native[0];
  if (witness)
    for (const mutate of [
      (r) => {
        r.id = "foreign";
      },
      (r) => r.observedCalls.push("foreign::call"),
      (r) => {
        r.observedCalls[0] = calls.at(-1);
      },
    ]) {
      const broken = structuredClone(witness.trace);
      mutate(broken);
      assert.throws(() => trusted(broken, witness.trace.id));
      responseGuards++;
    }
  for (const [i, input] of [
    {},
    { id: "missing", argv: [], compiler: "x" },
    {
      id: "wrong",
      trace: path.join(temporary, "invalid"),
      argv: [1],
      compiler: "x",
    },
    {
      id: "unknown",
      trace: path.join(temporary, "invalid"),
      argv: [],
      compiler: "x",
      unknown: true,
    },
    {
      id: "null",
      trace: path.join(temporary, "invalid"),
      argv: [],
      compiler: "x",
      warningMarker: null,
    },
  ].entries()) {
    const child = spawnSync(binary, [], {
      input: JSON.stringify(input),
      encoding: "utf8",
    });
    assert.ifError(child.error);
    assert.notEqual(child.status, 0);
    assert.equal(child.stdout, "");
    protocol.push({
      id: `invalid-${i}`,
      protocol: true,
      passed: true,
      native: {
        status: child.status,
        stdout: child.stdout,
        stderr: child.stderr,
      },
    });
  }
  assert.deepEqual(
    Object.fromEntries(
      sourceFiles.map((file) => [
        file,
        hash(fs.readFileSync(path.join(root, "packages/code-graph/src", file))),
      ]),
    ),
    sourceHashes,
  );
  save();
  console.log(
    JSON.stringify({
      passed: report().passed,
      attempted: cases.length,
      strict: report().strictPairs,
      qualified: report().qualifiedPairs,
      nativeOnly: report().nativeOnlyCases,
      pairedExecutions: report().pairedExecutions,
      failures,
    }),
  );
  assert.equal(failures.length, 0);
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
