import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  editPlain,
  plainCases,
  plainFixture,
  plainSteps,
} from "./collapse-plain-cases.mjs";

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
    fs.mkdtempSync(path.join(root, "target/parity/plain-collapse-")),
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
    z
      .object({
        stream: z.enum(["stdout", "stderr"]),
        payload: z.string(),
        fileAtAck: z
          .array(z.number().int().min(0).max(255))
          .nullable()
          .optional(),
      })
      .strict(),
  ),
});
function trusted(raw, id) {
  const row = traceSchema.parse(raw);
  assert.equal(row.id, id);
  assert.ok(row.observedCalls.length > 0 && row.observedCalls.length <= 10);
  assert.deepEqual(row.observedCalls, calls.slice(0, row.observedCalls.length));
  return row;
}
const earlier = {
  "config-refused-before-load": ["stopped", 1],
  "thresholds-before-collapse": ["stopped", 1],
  "api-before-collapse": ["api", 2],
  "layers-before-collapse": ["layers", 5],
  "boundaries-before-collapse": ["boundaries", 6],
  "env-before-collapse": ["env-keys", 7],
  "comments-before-collapse": ["comments", 8],
  "early-collapse-ci": ["collapse", 9],
  "early-collapse-write": ["collapse", 9],
};
const snapshot = (folder) => {
  const out = {};
  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile())
        out[path.relative(folder, absolute)] = {
          base64: fs.readFileSync(absolute).toString("base64"),
          mode: fs.statSync(absolute).mode & 0o777,
        };
    }
  }
  visit(folder);
  return Object.fromEntries(
    Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
};
function run(command, args, cwd, input, o, extraEnv = {}) {
  const fd = fs.openSync(path.join(cwd, "readonly.txt"), "r");
  try {
    const child = spawnSync(command, args, {
      cwd,
      input,
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, TSX_DISABLE_CACHE: "1", ...extraEnv },
      stdio: ["pipe", o.badStdout ? fd : "pipe", o.badStderr ? fd : "pipe"],
    });
    assert.ifError(child.error);
    assert.equal(child.signal, null);
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
  fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(JSON.parse);
function execute(f, o, step, location, id, native) {
  editPlain(f, step);
  const trace = path.join(
      location,
      `${native ? "native" : "source"}-${step.id}.jsonl`,
    ),
    ioTrace = path.join(location, `source-io-${step.id}.jsonl`);
  let output, events, io, observed;
  if (native) {
    output = run(
      binary,
      [],
      f.root,
      JSON.stringify({
        id,
        trace,
        argv: f.argv,
        compiler: o.withoutCompiler
          ? path.join(temporary, "missing-tsgo")
          : o.drift
            ? path.join(location, "drift-tsgo")
            : compiler,
        plain: true,
        ...(o.initial === undefined ? {} : { initial: o.initial }),
        ...(o.freshDataRoot
          ? {
              warningMarker: path.join(
                f.root,
                f.physical,
                "pnpm-workspace.yaml",
              ),
            }
          : {}),
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
        warningMarker: o.freshDataRoot
          ? path.join(f.root, f.physical, "pnpm-workspace.yaml")
          : undefined,
        driftFile: o.drift
          ? path.join(f.root, f.physical, "escaped.ts")
          : undefined,
      }),
    );
    output = run(
      process.execPath,
      [
        "--import",
        loader,
        path.join(here, "cli-plain-collapse-source.mts"),
        ...(o.rawArgv ? [] : f.argv),
      ],
      f.root,
      undefined,
      o,
      { DEMLIK_FRONTDOOR_REQUEST: request },
    );
    events = lines(trace);
    io = lines(ioTrace);
  }
  return {
    step: step.id,
    argv: f.argv,
    output,
    ...(native ? { trace: observed } : { events, io }),
    files: snapshot(f.root),
  };
}
const selected = process.env.DEMLIK_PLAIN_COLLAPSE_CASES?.split(",");
if (selected)
  assert.ok(
    selected.every((id) => plainCases.some(([candidate]) => candidate === id)),
  );
const cases = [],
  protocol = [],
  failures = [],
  nativeEvidence = {},
  qualifiedNativeEvidence = {};
let responseGuards = 0;
const sourceFiles = [
  "index.ts",
  "cli.ts",
  "collapse/render.ts",
  "collapse/settings.ts",
  "collapse/candidates.ts",
  "collapse/partial.ts",
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
      "Eligible plain collapse after actual prepared early returns, graph priority included; HTML/prepared ledger/inactive continuations are native-only, all53CLI gaps remain OPEN",
    reference: {
      node: process.version,
      v8: process.versions.v8,
      sourceHashes,
      compilerSha256: hash(fs.readFileSync(compiler)),
    },
    driverSha256: hash(fs.readFileSync(binary)),
    passed: cases.filter((c) => c.passed).length,
    attempted: cases.length,
    strictPairs: cases.filter(
      (c) => c.passed && !c.qualifications.length && !c.nativeOnly,
    ).length,
    qualifiedPairs: cases.filter(
      (c) => c.passed && c.qualifications.length && !c.nativeOnly,
    ).length,
    nativeOnlyCases: cases.filter((c) => c.passed && c.nativeOnly).length,
    pairedExecutions: cases.reduce((n, c) => n + c.source.length, 0),
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
try {
  for (const [id, o] of plainCases) {
    if (selected && !selected.includes(id)) continue;
    const location = path.join(temporary, id);
    fs.mkdirSync(location);
    let f = plainFixture(location, o);
    const before = snapshot(f.root);
    if (o.drift) {
      const drift = path.join(f.root, f.physical, "escaped.ts");
      fs.writeFileSync(
        path.join(location, "drift-tsgo"),
        `#!/bin/sh\nif [ "$1" = "--api" ]; then\npython3 -c 'import pathlib; p=pathlib.Path(${JSON.stringify(drift)});p.write_text("// edit after syntax load\\n"+p.read_text())'\nfi\nexec '${compiler}' "$@"\n`,
        { mode: 0o700 },
      );
    }
    const steps = o.workflow ? plainSteps : [{ id: "main" }],
      source = o.nativeOnly
        ? []
        : steps.map((step) => execute(f, o, step, location, id, false));
    fs.rmSync(f.root, { recursive: true, force: true });
    f = plainFixture(location, o);
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
          if (o.withoutCompiler) {
            assert.equal(observed.outcome.kind, "thrown");
            assert.equal(observed.outcome.error.name, "Error");
            assert.ok(observed.outcome.error.message.includes("compiler"));
          } else {
            assert.equal(observed.outcome.kind, "continue");
            assert.equal(observed.outcome.sameCarrier, true);
            assert.equal(observed.outcome.samePrepared, true);
          }
          assert.equal(observed.observedCalls.length, 10);
          assert.equal(n.output.stdout, "");
          assert.equal(n.output.stderr, "");
          assert.deepEqual(n.files, before);
          continue;
        }
        const s = source[i],
          error = s.events.find((e) => e.event === "uncaught");
        const [kind, length] = earlier[id] ?? [
          error && error.stream === undefined
            ? "thrown"
            : o.noConfig || id === "deep-missing-root-config"
              ? "plain-load-refused"
              : "plain-collapse",
          10,
        ];
        assert.equal(observed.outcome.kind, kind);
        assert.equal(observed.observedCalls.length, length);
        assert.deepEqual(n.files, s.files, "exact bytes and modes");
        const sourceWrites = s.io
          .filter((e) => e.op === "stdio-write")
          .map(({ stream, payload }) => ({ stream, payload }));
        if (error && error.stream === undefined) {
          row.qualifications.push("backend-exception-text-native-qualified");
          assert.equal(n.output.status, 1);
          assert.equal(observed.outcome.error.name, error.name);
          assert.equal(n.output.stdout, s.output.stdout);
          assert.equal(
            n.output.stderr,
            sourceWrites
              .filter((e) => e.stream === "stderr")
              .map((e) => e.payload)
              .join(""),
          );
          assert.equal(observed.io.stored, o.initial ?? null);
          if (error.code) {
            const details = observed.outcome.error.details;
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
          } else if (!o.withoutCompiler)
            assert.equal(observed.outcome.error.message, error.message);
          else assert.ok(observed.outcome.error.message.length > 0);
        } else if (error) {
          row.qualifications.push("pending-stdio-notification-contract");
          assert.equal(error.code, "EBADF");
          assert.equal(n.output.status, 1);
          assert.equal(observed.io.pending.length, 1);
          const p = observed.io.pending[0],
            writes = sourceWrites.filter((e) => e.stream === error.stream);
          assert.equal(p.stream, error.stream);
          assert.equal(p.cause.rawCode, 9);
          assert.equal(p.attemptedBytes, Buffer.byteLength(writes[0].payload));
          assert.equal(p.suppressedWrites, writes.length - 1);
          if (error.stream !== "stdout")
            assert.equal(n.output.stdout, s.output.stdout);
          if (error.stream !== "stderr")
            assert.equal(
              n.output.stderr,
              sourceWrites
                .filter((e) => e.stream === "stderr")
                .map((e) => e.payload)
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
            sourceWrites.map((event) =>
              o.rawArgv
                ? { ...event, payload: event.payload.toWellFormed() }
                : event,
            ),
            "ordered immediate writes at native UTF8 byte boundary",
          );
        }
        if (o.rawArgv)
          row.qualifications.push(
            "raw-JavaScript-argv-and-stdio-callback-units-qualified; original raw callback and native encoded payload retained",
          );
        if (o.drift) row.qualifications.push("controlled-loaded-source-drift");
        if (kind === "plain-collapse") {
          assert.equal(
            observed.io.stored,
            o.initial ?? null,
            "success preserves stored exit",
          );
          const payload =
            o.out === undefined
              ? n.output.stdout
              : Buffer.from(n.files[o.out].base64, "base64").toString();
          if (payload !== null) {
            assert.ok(payload.endsWith("\n"));
            assert.ok(!payload.endsWith("\n\n"));
          }
          if (
            o.out !== undefined &&
            !observed.io.pending.some((p) => p.stream === "stderr")
          ) {
            const ack = observed.writeObservations.find((e) =>
              e.payload.startsWith("code-graph: wrote "),
            );
            assert.ok(ack);
            assert.deepEqual(
              ack.fileAtAck,
              [...Buffer.from(n.files[o.out].base64, "base64")],
              "file ready before acknowledgement",
            );
            const write = s.io.findIndex(
              (e) =>
                e.op === "writeFileSync-return" &&
                path.resolve(f.root, e.file) === path.resolve(f.root, o.out),
            );
            const acknowledgment = s.io.findIndex(
              (e) =>
                e.op === "stdio-write" &&
                e.payload.startsWith("code-graph: wrote "),
            );
            assert.ok(write >= 0 && write < acknowledgment);
          }
        }
        if (o.workflow) {
          const expected = steps[i];
          if (expected.expectedClusters !== undefined)
            assert.ok(
              n.output.stdout.startsWith(
                `collapse candidates: ${expected.expectedClusters} findings / ${expected.expectedPairs} pairs `,
              ),
            );
          assert.ok(
            n.output.stdout.includes(
              `partial twins: ${expected.expectedPartials} `,
            ),
          );
          if (i === 0) {
            assert.ok(n.output.stdout.includes("rank=0.625  confidence=0.625"));
            assert.ok(n.output.stdout.includes("cost=1  callers=0 packages=1"));
          }
          if (i === 2) {
            assert.ok(n.output.stdout.includes("cluster of 3 (3 pairs)"));
            assert.ok(n.output.stdout.includes("     also: "));
          }
          if (i === 6) assert.equal(n.output.stdout, native[0].output.stdout);
        }
        if (id === "headers-graph-priority") {
          const graph = JSON.parse(n.output.stdout);
          assert.ok(
            graph.functions.some((fn) => typeof fn.header?.text === "string"),
          );
          assert.equal(graph.provenance.pass, "edges");
        }
        if (id === "data-in-graph") {
          const graph = JSON.parse(n.output.stdout);
          assert.ok(graph.data.edges.length > 0);
        }
        if (id === "fresh-data-root-after-warning") {
          const graph = JSON.parse(n.output.stdout);
          assert.deepEqual(graph.data.configFiles, ["wrangler.json"]);
          const markers = s.io.filter((e) => e.op === "workspace-marker");
          assert.ok(markers.length > 1);
          assert.ok(
            s.io.findIndex((e) => e.op === "stdio-write") <
              s.io.findLastIndex((e) => e.op === "workspace-marker"),
          );
        }
        if (kind === "plain-load-refused") {
          assert.ok(
            !s.io.some(
              (e) => e.op === "process" && String(e.args[0]).endsWith("/tsgo"),
            ),
          );
          assert.ok(observed.outcome.cause.length > 0);
          assert.equal(observed.io.stored, 2);
        }
        if (o.drift) {
          assert.ok(
            s.io.some((e) => e.op === "controlled-loaded-source-drift"),
          );
          assert.ok(
            n.output.stderr.includes("function(s) have no node in tsgo's tree"),
          );
        }
      }
      row.qualifications = [...new Set(row.qualifications)];
      row.passed = true;
      if (!row.nativeOnly) {
        const evidence = {
          observedCalls: [
            ...new Set(native.flatMap((n) => n.trace.observedCalls)),
          ],
        };
        (row.qualifications.length ? qualifiedNativeEvidence : nativeEvidence)[
          id
        ] = evidence;
        row.nativeTrace = evidence;
      }
    } catch (error) {
      row.failure = String(error);
      failures.push({ id, kind: failureKind, message: String(error) });
    }
    cases.push(row);
    save();
  }
  const witness = cases.find((c) => c.passed && !c.nativeOnly)?.native[0];
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
  for (const [i, value] of [
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
      input: JSON.stringify(value),
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
      strictPairs: report().strictPairs,
      qualifiedPairs: report().qualifiedPairs,
      nativeOnly: report().nativeOnlyCases,
      pairedExecutions: report().pairedExecutions,
      failures,
    }),
  );
  assert.equal(failures.length, 0);
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
