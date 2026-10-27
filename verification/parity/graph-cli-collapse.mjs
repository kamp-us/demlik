import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  collapseCases,
  collapseFixture,
  third,
} from "./collapse-gate-cases.mjs";

const [binary, reportFile] = process.argv.slice(2);
assert.ok(binary && reportFile);
assert.equal(process.version, "v22.21.1");
assert.equal(process.versions.v8, "12.4.254.21-node.33");
const root = fileURLToPath(new URL("../..", import.meta.url)),
  here = path.join(root, "verification/parity"),
  require = createRequire(import.meta.url),
  loader = require.resolve("tsx");
const compiler = fs.realpathSync(
  path.join(
    path.dirname(
      createRequire(
        createRequire(
          path.join(root, "packages/code-graph/package.json"),
        ).resolve("@typescript/native-preview/package.json"),
      ).resolve("@typescript/native-preview-darwin-arm64/package.json"),
    ),
    "lib/tsgo",
  ),
);
const temporary = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "demlik-cli-collapse-")),
  ),
  hash = (b) => createHash("sha256").update(b).digest("hex");
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
].map((s) => `demlik_code_graph::cli::frontdoor::${s}`);
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
        cause: z.strictObject({
          kind: z.string(),
          rawCode: z.number().nullable(),
          message: z.string().min(1),
        }),
      }),
    ),
  }),
  exitCode: z.number(),
  observedCalls: z.array(z.string()),
});
function trusted(raw, id) {
  const row = traceSchema.parse(raw);
  assert.equal(row.id, id);
  assert.ok(row.observedCalls.length >= 1 && row.observedCalls.length <= 9);
  assert.deepEqual(row.observedCalls, calls.slice(0, row.observedCalls.length));
  return row;
}
function requireOutcome(row, kind) {
  assert.equal(row.outcome.kind, kind, "Source early-return mode");
  const length = {
    stopped: 1,
    api: 2,
    hexagon: 3,
    refused: 4,
    layers: 5,
    boundaries: 6,
    "env-keys": 7,
    comments: 8,
    collapse: 9,
    continue: 9,
    thrown: 9,
  }[kind];
  assert.deepEqual(row.observedCalls, calls.slice(0, length));
}
const earlierModes = {
  "config-refused-before-policy": "stopped",
  "thresholds-first": "stopped",
  "unreachable-before-collapse": "refused",
  "smell-accept-refusal-before-collapse": "refused",
  "api-priority": "api",
  "layers-priority": "layers",
  "boundaries-priority": "boundaries",
  "env-keys-priority": "env-keys",
  "comments-priority": "comments",
};
function snapshot(root) {
  const out = {};
  function visit(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) visit(p);
      else if (e.isFile()) {
        const b = fs.readFileSync(p);
        out[path.relative(root, p)] = {
          base64: b.toString("base64"),
          mode: fs.statSync(p).mode & 0o777,
        };
      }
    }
  }
  visit(root);
  return Object.fromEntries(
    Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}
function run(command, args, cwd, input, o) {
  const fd = fs.openSync(path.join(cwd, "readonly.txt"), "r");
  try {
    const child = spawnSync(command, args, {
      cwd,
      input,
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, TSX_DISABLE_CACHE: "1" },
      stdio: ["pipe", o.badStdout ? fd : "pipe", o.badStderr ? fd : "pipe"],
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
const lines = (p) =>
  fs.readFileSync(p, "utf8").split("\n").filter(Boolean).map(JSON.parse);
function steps(_fixture, o) {
  return o.workflow
    ? [
        { id: "record-one", flags: ["--write-ceilings"], count: 1 },
        { id: "repeat-one", flags: ["--write-ceilings"], count: 1 },
        { id: "ci-one", flags: ["--ci", "--json"], count: 1 },
        { id: "add-third", flags: ["--ci", "--json"], edit: "third", count: 3 },
        {
          id: "drop-constant",
          flags: ["--ci", "--json"],
          edit: "drop",
          count: 0,
        },
        {
          id: "record-second",
          target: "packages/second",
          flags: ["--write-ceilings"],
          count: 1,
        },
        { id: "check-both", target: ".", flags: ["--ci", "--json"], count: 0 },
      ]
    : [{ id: "main", flags: null }];
}
function edit(f, step) {
  if (step.edit === "third")
    fs.appendFileSync(path.join(f.root, f.physical, "retry.ts"), third);
  if (step.edit === "drop") {
    const p = path.join(f.root, f.physical, "retry.ts");
    fs.writeFileSync(
      p,
      fs
        .readFileSync(p, "utf8")
        .replaceAll("decide(count,MAX_ATTEMPTS)", "decide(count,3)"),
    );
  }
}
function executeSource(f, o, step, location) {
  edit(f, step);
  const argv = step.flags
    ? [step.target ?? f.target, "--collapse", ...step.flags]
    : f.argv;
  const trace = path.join(location, `source-${step.id}.jsonl`),
    ioTrace = path.join(location, `source-io-${step.id}.jsonl`),
    request = path.join(location, "request.json");
  fs.writeFileSync(trace, "");
  fs.writeFileSync(ioTrace, "");
  fs.writeFileSync(
    request,
    JSON.stringify({
      trace,
      ioTrace,
      fixture: f.root,
      rawArgv: o.rawArgv,
      input: {
        action: "frontdoor",
        argv,
        ...(o.initial === undefined ? {} : { initial: o.initial }),
      },
      removeMarkerAfterFirstFound: o.secondMarker,
      driftFile: o.drift
        ? path.join(f.root, f.physical, "escaped.ts")
        : undefined,
    }),
  );
  const prev = process.env.DEMLIK_FRONTDOOR_REQUEST;
  process.env.DEMLIK_FRONTDOOR_REQUEST = request;
  let output;
  try {
    output = run(
      process.execPath,
      [
        "--import",
        loader,
        path.join(here, "cli-collapse-source.mts"),
        ...(o.rawArgv ? [] : argv),
      ],
      f.root,
      undefined,
      o,
    );
  } finally {
    if (prev === undefined) delete process.env.DEMLIK_FRONTDOOR_REQUEST;
    else process.env.DEMLIK_FRONTDOOR_REQUEST = prev;
  }
  return {
    argv,
    output,
    events: lines(trace),
    io: lines(ioTrace),
    files: snapshot(f.root),
  };
}
function executeNative(f, o, step, location, id) {
  edit(f, step);
  const argv = step.flags
      ? [step.target ?? f.target, "--collapse", ...step.flags]
      : f.argv,
    trace = path.join(location, `native-${step.id}.json`);
  const output = run(
    binary,
    [],
    f.root,
    JSON.stringify({
      id,
      trace,
      argv,
      compiler: o.withoutCompiler
        ? path.join(temporary, "not-installed-tsgo")
        : o.drift
          ? path.join(location, "drift-tsgo")
          : compiler,
      ...(o.initial === undefined ? {} : { initial: o.initial }),
      ...(o.secondMarker
        ? { removeMarker: path.join(f.root, f.physical, "pnpm-workspace.yaml") }
        : {}),
    }),
    o,
  );
  return {
    argv,
    output,
    trace: fs.existsSync(trace)
      ? JSON.parse(fs.readFileSync(trace, "utf8"))
      : null,
    files: snapshot(f.root),
  };
}
const selected = process.env.DEMLIK_COLLAPSE_CASES?.split(",");
if (selected)
  assert.ok(
    selected.every((id) =>
      collapseCases.some(([candidate]) => candidate === id),
    ),
  );
const protocolRows = [];
const cases = [],
  failures = [],
  nativeEvidence = {},
  qualifiedNativeEvidence = {};
let rejectedInvalidInputs = 0,
  responseGuards = 0;
const sourceFiles = [
  "index.ts",
  "cli.ts",
  "config.ts",
  "collapse/gate.ts",
  "collapse/ceilings.ts",
  "collapse/candidates.ts",
  "collapse/partial.ts",
  "collapse/settings.ts",
  "ratchet/scope-count.ts",
  "extract/assemble.ts",
  "extract/project.ts",
];
const sourceHashes = Object.fromEntries(
  sourceFiles.map((p) => [
    p,
    hash(fs.readFileSync(path.join(root, "packages/code-graph/src", p))),
  ]),
);
function report() {
  return {
    scope:
      "Only early collapse&&(ci||writeCeilings) through actual public prepared continuation; all53CLI gaps remain OPEN; no plain collapse/cost/rank/similarity/bootstrap",
    reference: {
      node: process.version,
      v8: process.versions.v8,
      sourceHashes,
      compilerSha256: hash(fs.readFileSync(compiler)),
    },
    driverSha256: hash(fs.readFileSync(binary)),
    passed: cases.filter((c) => c.passed).length,
    attempted: cases.length,
    unqualifiedPairs: cases.filter((c) => c.passed && !c.qualifications.length)
      .length,
    qualifiedPairs: cases.filter((c) => c.passed && c.qualifications.length)
      .length,
    pairedExecutions: cases.reduce((n, c) => n + c.source.length, 0),
    rejectedInvalidInputs,
    responseGuards,
    nativeEvidence,
    qualifiedNativeEvidence,
    failures,
    cases: [...cases, ...protocolRows],
  };
}
function save() {
  fs.writeFileSync(reportFile, `${JSON.stringify(report(), null, 2)}\n`);
}
try {
  for (const [id, o] of collapseCases) {
    if (selected && !selected.includes(id)) continue;
    const location = path.join(temporary, id);
    fs.mkdirSync(location);
    let f = collapseFixture(location, o);
    const before = snapshot(f.root);
    if (o.drift) {
      const drift = path.join(f.root, f.physical, "escaped.ts");
      fs.writeFileSync(
        path.join(location, "drift-tsgo"),
        `#!/bin/sh\nif [ "$1" = "--api" ]; then\npython3 -c 'import pathlib; p=pathlib.Path(${JSON.stringify(drift)});p.write_text("// edit after syntax load\\n"+p.read_text())'\nfi\nexec '${compiler}' "$@"\n`,
        { mode: 0o700 },
      );
    }
    const source = steps(f, o).map((step) =>
      executeSource(f, o, step, location),
    );
    fs.rmSync(f.root, { recursive: true, force: true });
    f = collapseFixture(location, o);
    assert.deepEqual(snapshot(f.root), before, "fresh native inputs");
    const native = steps(f, o).map((step) =>
      executeNative(f, o, step, location, id),
    );
    const row = {
      id,
      passed: false,
      qualifications: [],
      before,
      source,
      native,
    };
    let failureKind = "protocol";
    try {
      for (let i = 0; i < source.length; i++) {
        const s = source[i],
          n = native[i],
          observed = trusted(n.trace, id),
          error = s.events.find((e) => e.event === "uncaught");
        failureKind = "semantic";
        const expectedKind =
          o.inactive || o.flags?.length === 0
            ? "continue"
            : error && error.stream === undefined
              ? "thrown"
              : (earlierModes[id] ?? "collapse");
        requireOutcome(observed, expectedKind);
        assert.deepEqual(n.files, s.files, "exact bytes and modes");
        if (o.inactive || o.flags?.length === 0) {
          row.qualifications.push(
            "prepared-continuation-before-unported-later-mode",
          );
          assert.equal(observed.outcome.kind, "continue");
          assert.equal(observed.outcome.sameCarrier, true);
          assert.equal(observed.outcome.samePrepared, true);
          continue;
        }
        if (error && error.stream === undefined) {
          row.qualifications.push("native-backend-exception-output");
          assert.equal(n.output.status, 1);
          assert.equal(observed.outcome.kind, "thrown");
          assert.equal(observed.outcome.error.name, error.name);
          assert.equal(n.output.stdout, s.output.stdout);
          assert.equal(
            n.output.stderr,
            s.io
              .filter((e) => e.op === "stdio-write" && e.stream === "stderr")
              .map((e) => e.payload)
              .join(""),
          );
          assert.equal(observed.io.stored, o.initial ?? null);
          if (error.code) {
            const details = observed.outcome.error.details;
            assert.ok(details);
            if (error.code === "ERR_INVALID_ARG_VALUE") {
              assert.equal(details.code, error.code);
              assert.equal(details.argument, o.out);
            } else {
              assert.equal(details.path, error.path);
              assert.equal(
                details.cause.rawCode,
                { ENOENT: 2, EACCES: 13, EISDIR: 21 }[error.code],
              );
            }
          } else assert.equal(observed.outcome.error.message, error.message);
        } else if (error) {
          row.qualifications.push("pending-stdio-runtime-notification");
          assert.equal(n.output.status, 1);
          assert.equal(error.code, "EBADF");
          assert.equal(observed.io.pending.length, 1);
          const p = observed.io.pending[0];
          assert.equal(p.stream, error.stream);
          assert.equal(p.cause.rawCode, 9);
          const writes = s.io.filter(
            (e) => e.op === "stdio-write" && e.stream === error.stream,
          );
          assert.ok(writes.length);
          assert.equal(p.attemptedBytes, Buffer.byteLength(writes[0].payload));
          assert.equal(p.suppressedWrites, writes.length - 1);
          if (error.stream !== "stdout")
            assert.equal(n.output.stdout, s.output.stdout);
          if (error.stream !== "stderr")
            assert.equal(
              n.output.stderr,
              s.io
                .filter((e) => e.op === "stdio-write" && e.stream === "stderr")
                .map((e) => e.payload)
                .join(""),
            );
        } else {
          assert.equal(n.output.status, s.output.status);
          assert.equal(n.output.stdout, s.output.stdout);
          assert.equal(n.output.stderr, s.output.stderr);
          assert.deepEqual(observed.io.pending, []);
        }
        if (observed.outcome.kind === "collapse") {
          const result = z
            .strictObject({
              exitCode: z.union([z.literal(0), z.literal(1), z.literal(2)]),
              emitted: z.array(z.string()),
              reports: z.array(z.string()),
            })
            .parse(observed.outcome.result);
          const writes = s.io.filter((e) => e.op === "stdio-write");
          const reportLines = writes
            .filter(
              (e) =>
                e.stream === "stderr" &&
                e.payload.startsWith("code-graph: ") &&
                !e.payload.startsWith("code-graph: warning:") &&
                !e.payload.startsWith("code-graph: wrote "),
            )
            .map((e) => e.payload.slice(12, -1));
          assert.deepEqual(result.reports, reportLines);
          const payloads =
            o.out === undefined
              ? writes
                  .filter((e) => e.stream === "stdout")
                  .map((e) => e.payload)
              : [
                  Buffer.from(
                    s.files[o.out]?.base64 ?? "",
                    "base64",
                  ).toString(),
                ];
          if (result.emitted.length) assert.deepEqual(result.emitted, payloads);
          if (result.reports.length) assert.equal(result.exitCode, 2);
        }
        if (o.withoutCompiler)
          assert.ok(
            !s.io.some((e) => e.op === "process" && e.args[0] !== "git"),
            "policy refusal before Go",
          );
        if (o.drift) {
          row.qualifications.push("controlled-loaded-source-drift");
          assert.ok(
            s.io.some((e) => e.op === "controlled-loaded-source-drift"),
          );
          assert.ok(
            s.output.stderr.includes("code-graph: warning: 1 function(s)"),
          );
          assert.ok(
            n.output.stderr.includes("code-graph: warning: 1 function(s)"),
          );
        }
        if (o.secondMarker)
          row.qualifications.push("controlled-second-root-lookup");
        if (o.rawArgv) row.qualifications.push("javascript-argv-UTF16");
        if (
          [
            "write-new",
            "write-repeat-existing",
            "write-preserves-mode",
            "write-wins-ci-existing",
            "write-wins-ci-missing",
            "write-preserves-initial",
          ].includes(id)
        ) {
          const policy = JSON.parse(
            Buffer.from(
              n.files["collapse-ceilings.json"].base64,
              "base64",
            ).toString(),
          );
          assert.equal(policy.scopes[f.target], 1);
        }
        if (id === "config-changes-count")
          assert.equal(
            JSON.parse(
              Buffer.from(
                n.files["collapse-ceilings.json"].base64,
                "base64",
              ).toString(),
            ).scopes[f.target],
            0,
          );
        if (id === "historical-proto-record") {
          const policy = JSON.parse(
            Buffer.from(
              n.files["collapse-ceilings.json"].base64,
              "base64",
            ).toString(),
          );
          assert.ok(!Object.hasOwn(policy.scopes, "__proto__"));
          assert.ok(
            n.output.stdout.includes(" at [object Object] partial twin(s)"),
          );
        }
        if (id === "ci-two-scopes")
          assert.ok(n.output.stdout.includes("PASS — 2 scope(s)"));
        if (id === "ci-mixed-advice") {
          assert.ok(
            n.output.stdout.indexOf("  EXCEEDED:") <
              n.output.stdout.indexOf("  SLACK:"),
          );
        }
        if (id === "write-out") {
          const writes = s.io.filter((e) => e.op === "writeFileSync-return");
          assert.ok(
            writes.findIndex((e) =>
              e.file.endsWith("/collapse-ceilings.json"),
            ) < writes.findIndex((e) => e.file === "result.txt"),
          );
          assert.ok(
            s.io.findIndex(
              (e) => e.op === "writeFileSync-return" && e.file === "result.txt",
            ) <
              s.io.findIndex(
                (e) => e.op === "stdio-write" && e.stream === "stderr",
              ),
          );
        }
        if (o.workflow) {
          const step = steps(f, o)[i],
            policy = JSON.parse(
              Buffer.from(
                n.files["collapse-ceilings.json"].base64,
                "base64",
              ).toString(),
            );
          if (i <= 2) assert.equal(policy.scopes["packages/retry"], 1);
          if (i === 1)
            assert.deepEqual(
              n.files["collapse-ceilings.json"],
              native[0].files["collapse-ceilings.json"],
            );
          if (step.id === "add-third" || step.id === "drop-constant") {
            const v = JSON.parse(n.output.stdout);
            assert.equal(v.violations[0].measured, step.count);
            assert.equal(
              v.violations[0].direction,
              step.count === 3 ? "EXCEEDED" : "SLACK",
            );
          }
          if (step.id === "record-second")
            assert.equal(policy.scopes["packages/second"], 1);
          if (step.id === "check-both")
            assert.equal(JSON.parse(n.output.stdout).scopesChecked, 2);
        }
      }
      row.qualifications = [...new Set(row.qualifications)];
      row.passed = true;
      const evidence = {
        observedCalls: [
          ...new Set(native.flatMap((n) => n.trace.observedCalls)),
        ],
      };
      row.nativeTrace = evidence;
      (row.qualifications.length ? qualifiedNativeEvidence : nativeEvidence)[
        id
      ] = evidence;
    } catch (e) {
      row.failure = String(e);
      failures.push({ id, kind: failureKind, message: String(e) });
    }
    cases.push(row);
    save();
  }
  const witness = cases.find((c) => c.passed)?.native[0];
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
  if (witness) {
    const broken = structuredClone(witness.trace);
    broken.outcome.kind =
      broken.outcome.kind === "collapse" ? "continue" : "collapse";
    assert.throws(() =>
      requireOutcome(
        trusted(broken, witness.trace.id),
        witness.trace.outcome.kind,
      ),
    );
    responseGuards++;
  }
  for (const [_i, value] of [
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
      initial: null,
    },
  ].entries()) {
    const child = spawnSync(binary, [], {
      input: JSON.stringify(value),
      encoding: "utf8",
    });
    assert.ifError(child.error);
    assert.notEqual(child.status, 0);
    assert.equal(child.stdout, "");
    assert.ok(child.stderr.length);
    protocolRows.push({
      id: `invalid-${_i}`,
      protocol: true,
      passed: true,
      native: {
        status: child.status,
        stdout: child.stdout,
        stderr: child.stderr,
      },
    });
    rejectedInvalidInputs++;
  }
  assert.deepEqual(
    Object.fromEntries(
      sourceFiles.map((p) => [
        p,
        hash(fs.readFileSync(path.join(root, "packages/code-graph/src", p))),
      ]),
    ),
    sourceHashes,
  );
  save();
  console.log(
    JSON.stringify({
      passed: report().passed,
      attempted: cases.length,
      unqualifiedPairs: report().unqualifiedPairs,
      qualifiedPairs: report().qualifiedPairs,
      pairedExecutions: report().pairedExecutions,
      failures,
    }),
  );
  assert.equal(failures.length, 0);
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
