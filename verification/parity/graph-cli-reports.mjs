import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  htmlCliCases,
  htmlFixture,
  htmlLiteral,
  htmlSteps,
} from "./cli-html-cases.mjs";
import {
  reportCases as consoleCases,
  reportsFixture as consoleFixture,
  reportSteps as consoleSteps,
} from "./cli-reports-cases.mjs";
import {
  tailCases,
  tailFixture,
  tailLiteral,
  tailSteps,
} from "./cli-tree-blast-find-cases.mjs";

const [binaryArg, reportArg] = process.argv.slice(2);
assert.ok(binaryArg && reportArg);
const tail = process.argv[4] === "tree-blast-find";
const html = process.argv[4] === "html";
assert.ok(
  process.argv.length === 4 || ((tail || html) && process.argv.length === 5),
);
const reportCases = html ? htmlCliCases : tail ? tailCases : consoleCases;
const reportSteps = html ? htmlSteps : tail ? tailSteps : consoleSteps;
const reportsFixture = html ? htmlFixture : tail ? tailFixture : consoleFixture;
assert.equal(process.version, "v22.21.1");
assert.equal(process.versions.v8, "12.4.254.21-node.33");
const root = fileURLToPath(new URL("../..", import.meta.url));
const binary = path.resolve(binaryArg),
  reportFile = path.resolve(reportArg),
  require = createRequire(import.meta.url),
  loader = require.resolve("tsx");
const owner = createRequire(
  path.join(root, "packages/code-graph/package.json"),
);
const nativeRequire = createRequire(
  owner.resolve("@typescript/native-preview/package.json"),
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
const hash = (b) => createHash("sha256").update(b).digest("hex");
const sourceOnly = process.env.DEMLIK_REPORT_CLI_SOURCE_ONLY === "1";
const selected = process.env.DEMLIK_REPORT_CLI_CASES?.split(",");
if (selected)
  assert.ok(
    selected.every((id) => reportCases.some(([candidate]) => candidate === id)),
  );
fs.mkdirSync(path.join(root, "target/parity"), { recursive: true });
const temporary = fs.realpathSync(
  fs.mkdtempSync(path.join(root, "target/parity/cli-reports-")),
);
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
  "PreparedGatesCli::dispatch_reports_blocking",
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
        "unreachable",
        "unreachable-load-refused",
        "smell-ledger",
        "smell-load-refused",
        "reports",
        "reports-load-refused",
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
  const row = traceSchema.parse(raw);
  assert.equal(row.id, id);
  assert.ok(
    row.observedCalls.length > 0 && row.observedCalls.length <= calls.length,
  );
  const expected = calls.slice(0, row.observedCalls.length);
  if (
    tail &&
    row.observedCalls.at(-1) ===
      "demlik_code_graph::cli::frontdoor::PreparedGatesCli::dispatch_reports_with_style_blocking"
  )
    expected[expected.length - 1] = row.observedCalls.at(-1);
  assert.deepEqual(row.observedCalls, expected);
  return row;
}
function snapshot(folder) {
  const files = {};
  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile())
        files[path.relative(folder, file)] = {
          base64: fs.readFileSync(file).toString("base64"),
          mode: fs.statSync(file).mode & 0o777,
        };
    }
  }
  visit(folder);
  return Object.fromEntries(
    Object.entries(files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}
const jsonLines = (file) =>
  fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(JSON.parse);
function processRun(command, args, cwd, input, o, env = {}) {
  const fd = fs.openSync(path.join(cwd, "readonly.txt"), "r");
  try {
    const environment = { ...process.env, TSX_DISABLE_CACHE: "1", ...env };
    if (tail) {
      delete environment.NO_COLOR;
      environment.FORCE_COLOR = o.ansi ? "1" : "0";
    }
    const result = spawnSync(command, args, {
      cwd,
      input,
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 32 << 20,
      env: environment,
      stdio: ["pipe", o.badStdout ? fd : "pipe", o.badStderr ? fd : "pipe"],
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    return {
      status: result.status,
      signal: result.signal,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  } finally {
    fs.closeSync(fd);
  }
}
function execute(f, o, step, location, id, native) {
  const before = snapshot(f.root),
    out = step.out ?? o.out;
  const argv = [
    step.target ?? f.target,
    ...(step.flags ?? o.flags ?? []),
    ...(o.edgeFlag ? ["--edges"] : []),
    ...f.base,
    ...(out === undefined ? [] : ["--out", out]),
  ];
  const trace = path.join(
      location,
      `${native ? "native" : "source"}-${step.id}.jsonl`,
    ),
    ioTrace = path.join(location, `source-io-${step.id}.jsonl`);
  let output, observed, events, io;
  if (native) {
    output = processRun(
      binary,
      [],
      f.root,
      JSON.stringify({
        id,
        trace,
        argv,
        compiler: o.withoutCompiler
          ? path.join(location, "compiler-does-not-exist")
          : compiler,
        plain: true,
        lateReports: true,
        ...(tail ? { ansi: o.ansi === true } : {}),
        ...(o.initial === undefined ? {} : { initial: o.initial }),
      }),
      o,
    );
    observed = JSON.parse(fs.readFileSync(trace, "utf8"));
  } else {
    fs.writeFileSync(trace, "");
    fs.writeFileSync(ioTrace, "");
    const request = path.join(location, `request-${step.id}.json`);
    fs.writeFileSync(
      request,
      JSON.stringify({
        trace,
        ioTrace,
        ...(tail && o.rawArgv ? { rawArgv: true } : {}),
        fixture: f.root,
        input: {
          action: "frontdoor",
          argv,
          ...(o.initial === undefined ? {} : { initial: o.initial }),
        },
      }),
    );
    output = processRun(
      process.execPath,
      [
        "--import",
        loader,
        path.join(root, "verification/parity/cli-plain-collapse-source.mts"),
        ...argv,
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
    argv,
    before,
    files: snapshot(f.root),
    output,
    ...(native ? { trace: observed } : { events, io }),
  };
}
function payload(run, o, step) {
  const out = step.out ?? o.out;
  return out !== undefined &&
    o.mode !== "ci" &&
    step.mode !== "ci" &&
    run.files[out]
    ? Buffer.from(run.files[out].base64, "base64").toString("utf8")
    : run.output.stdout;
}
function literal(run, o, step) {
  const mode = step.mode ?? o.mode,
    expected = { ...o, ...step };
  if (expected.exit !== undefined)
    assert.equal(run.output.status, expected.exit, "independent exit decision");
  const text = payload(run, o, step);
  if (expected.warning)
    assert.ok(
      run.output.stderr.includes(expected.warning),
      "independent warning anchor",
    );
  if (expected.refusal) {
    assert.equal(run.output.stdout, "");
    assert.ok(run.output.stderr.includes(expected.refusal));
    return;
  }
  if (expected.loadRefused) {
    assert.equal(run.output.stdout, "");
    assert.ok(run.output.stderr.includes("no tsconfig found for edge pass"));
    assert.ok(
      !run.output.stderr.includes("--max expects"),
      "load refusal wins before late CI validation",
    );
    return;
  }
  if (expected.exception || expected.pending || expected.early) return;
  if (html && mode === "html") {
    htmlLiteral(text, o, step, run);
    return;
  }
  if (mode === "summary") {
    const v = JSON.parse(text);
    assert.equal(v.fileCount, expected.files);
    assert.equal(v.functionCount, expected.functions);
    assert.ok(!("modules" in v), "default payload is summary, not Graph");
  }
  if (mode === "graph") {
    const v = JSON.parse(text);
    assert.equal(v.modules.length, expected.files);
    assert.equal(v.functions.length, expected.functions);
    if (expected.reach)
      assert.ok(
        v.reachability !== null,
        "losing reach flag still requests analysis",
      );
    if (!o.cheap) assert.equal(v.provenance.pass, "edges");
  }
  if (mode === "plan") {
    if (expected.flags?.includes("--json"))
      assert.equal(JSON.parse(text).length, expected.functions);
    else {
      assert.ok(text.startsWith("Refactor plan — ranked by "));
      assert.ok(text.includes("top 6 of 6"));
    }
  }
  if (mode === "ci") {
    assert.ok(
      text.startsWith(
        `code-graph CI: ${expected.passed === true || expected.exit === 0 ? "PASS" : "FAIL"}`,
      ),
    );
    if (expected.out !== undefined)
      assert.deepEqual(
        run.files[expected.out],
        run.before[expected.out],
        "ordinary CI ignores OutputTo",
      );
  }
  if (mode === "ci-invalid") {
    assert.equal(run.output.stdout, "");
    assert.ok(
      run.output.stderr.includes("--max expects a non-negative integer"),
    );
    if (expected.flags.includes("--fail-on"))
      assert.ok(
        run.output.stderr.indexOf("unknown --fail-on") <
          run.output.stderr.indexOf("--max expects"),
      );
  }
  if (mode === "smells") {
    if (expected.flags?.includes("--json")) {
      assert.equal(JSON.parse(text).length > 0, expected.smells);
    } else if (expected.coupling) assert.ok(text.includes("Coupling\n"));
    else
      assert.ok(
        expected.smells
          ? text.includes("high-complexity")
          : text === "No smells found.\n",
      );
  }
  if (mode === "unguarded") {
    if (expected.flags?.includes("--json"))
      assert.equal(
        JSON.parse(text).length,
        1,
        "one real effect path from serve through round",
      );
    else assert.ok(text.startsWith("unguarded: 1 effect nodes"));
  }
  if (mode === "kinds" && expected.flags?.includes("--json")) {
    const v = JSON.parse(text);
    assert.equal(v.entry, 1);
    assert.equal(v.effect, 1);
    assert.equal(v.plain, 4);
  }
  if (mode === "clusters" && expected.flags?.includes("--json")) {
    const v = JSON.parse(text);
    assert.equal(v.clusteredFileCount, 4);
    assert.ok(v.clusterCount > 0);
  }
  if (mode === "interface-width" && expected.flags?.includes("--json")) {
    const v = JSON.parse(text);
    assert.equal(v.totalExports, 6);
  }
  if (expected.head) assert.ok(text.startsWith(expected.head));
  if (mode === "cycles" && expected.cycles !== undefined)
    assert.equal(JSON.parse(text).length, expected.cycles);
  if (mode === "data" && expected.flags?.includes("--json")) {
    const v = JSON.parse(text);
    assert.equal(v.edges.length, 2, "one named read and one named write");
    assert.equal(v.unattributed.length, 1, "one real top-level read");
  }
  if (mode === "file") {
    const v = JSON.parse(text);
    assert.ok(v.module.file.endsWith("api.ts"));
    assert.equal(v.functions.length, 2);
  }
  if (mode === "file-warning") assert.equal(run.output.stdout, "");
  if (expected.contains) assert.ok(text.includes(expected.contains));
  if (expected.outMode)
    assert.equal(run.files[expected.out].mode, expected.outMode);
  if (tail) tailLiteral(run, o, step, text);
}
const sourceFiles = [
  "index.ts",
  "cli.ts",
  "render/ci.ts",
  "render/analysis.ts",
  "render/smells.ts",
  "render/plan.ts",
  "render/file.ts",
  "render/graph.ts",
  "render/summary.ts",
  "data/render.ts",
  "smells/coupling.ts",
  "extract/assemble.ts",
  "extract/project.ts",
  ...(tail
    ? ["render/tree.ts", "render/blast.ts", "declarations/find.ts"]
    : []),
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
      "Graph-derived console reports and ordinary CI; HTML/hotspots/blast/find/colored-tree/bootstrap and all53 CLI gaps remain OPEN",
    sourceOnly,
    reference: {
      node: process.version,
      v8: process.versions.v8,
      sourceHashes,
      compilerSha256: hash(fs.readFileSync(compiler)),
    },
    driverSha256: sourceOnly ? null : hash(fs.readFileSync(binary)),
    passed: cases.filter((r) => r.passed).length,
    attempted: cases.length,
    strictPairs: cases.filter(
      (r) =>
        r.passed && !r.nativeOnly && !r.qualifications.length && !sourceOnly,
    ).length,
    qualifiedPairs: cases.filter(
      (r) =>
        r.passed && !r.nativeOnly && r.qualifications.length && !sourceOnly,
    ).length,
    nativeOnlyCases: cases.filter((r) => r.passed && r.nativeOnly).length,
    sourceExecutions: cases.reduce((n, r) => n + r.source.length, 0),
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
  for (const [id, o] of reportCases) {
    if (selected && !selected.includes(id)) continue;
    if (sourceOnly && o.nativeOnly) continue;
    const location = path.join(temporary, id);
    fs.mkdirSync(location);
    let f = reportsFixture(location, o);
    const before = snapshot(f.root),
      steps = o.workflow ? reportSteps : [{ id: "main" }];
    const source = o.nativeOnly
      ? []
      : steps.map((step) => execute(f, o, step, location, id, false));
    let native = [];
    if (!sourceOnly) {
      fs.rmSync(f.root, { recursive: true, force: true });
      f = reportsFixture(location, o);
      assert.deepEqual(snapshot(f.root), before);
      native = steps.map((step) => execute(f, o, step, location, id, true));
    }
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
      for (let i = 0; i < source.length; i++) {
        const s = source[i];
        assert.ok(s.io.some((e) => e.op === "exit"));
        literal(s, o, steps[i]);
      }
      for (let i = 0; i < native.length; i++) {
        const n = native[i],
          observed = trusted(n.trace, id);
        failureKind = "semantic";
        if (o.nativeOnly) {
          assert.equal(observed.outcome.kind, "continue");
          assert.equal(observed.outcome.sameCarrier, true);
          assert.equal(observed.outcome.samePrepared, true);
          assert.equal(n.output.stdout, "");
          assert.equal(n.output.stderr, "");
          assert.deepEqual(n.files, before);
          continue;
        }
        const s = source[i];
        if (html && (steps[i].mode ?? o.mode) === "html") {
          const out = steps[i].out ?? o.out;
          if (out !== undefined && s.files[out]) {
            const wrote = s.io.findIndex(
              (event) =>
                event.op === "writeFileSync-return" && event.file === out,
            );
            const ack = s.io.findIndex(
              (event) =>
                event.op === "stdio-write" &&
                event.stream === "stderr" &&
                event.payload.startsWith("code-graph: wrote "),
            );
            assert.ok(
              wrote >= 0 && ack > wrote,
              "Source file write completes before banner",
            );
            const observedAck = observed.writeObservations.find(
              (event) =>
                event.stream === "stderr" &&
                event.payload.startsWith("code-graph: wrote "),
            );
            assert.deepEqual(
              observedAck?.fileAtAck,
              [...Buffer.from(s.files[out].base64, "base64")],
              "native file already exists at banner, including a failed banner write",
            );
          }
        }
        assert.deepEqual(n.before, s.before);
        assert.deepEqual(n.files, s.files, "real file bytes and modes");
        const error = s.events.find((e) => e.event === "uncaught"),
          writes = s.io
            .filter((e) => e.op === "stdio-write")
            .map(({ stream, payload }) => ({ stream, payload }));
        if (error && error.stream === undefined) {
          row.qualifications.push("backend-exception-diagnostic-qualified");
          assert.equal(n.output.status, 1);
          assert.equal(observed.outcome.kind, "thrown");
          assert.equal(observed.outcome.error.name, error.name);
          assert.equal(n.output.stdout, s.output.stdout);
          assert.equal(
            n.output.stderr,
            writes
              .filter((w) => w.stream === "stderr")
              .map((w) => w.payload)
              .join(""),
          );
          if (error.code) {
            assert.equal(observed.outcome.error.details.path, error.path);
            assert.equal(
              observed.outcome.error.details.cause.rawCode,
              { EISDIR: 21, EACCES: 13, ENOENT: 2 }[error.code],
            );
          } else assert.ok(observed.outcome.error.message.length > 0);
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
          if (tail && o.rawArgv)
            row.qualifications.push("caller-supplied-UTF16-argv-profile");
          if (o.rawPayload)
            row.qualifications.push(
              "source-unit-versus-native-encoded-write-observer",
            );
          assert.deepEqual(
            observed.writeObservations.map(({ stream, payload }) => ({
              stream,
              payload,
            })),
            writes.map((w) =>
              o.rawPayload ? { ...w, payload: w.payload.toWellFormed() } : w,
            ),
          );
        }
        if (o.early) assert.equal(observed.outcome.kind, o.early);
        else if (o.loadRefused)
          assert.equal(observed.outcome.kind, "reports-load-refused");
        else if (!error) assert.equal(observed.outcome.kind, "reports");
        if (o.withoutCompiler)
          assert.ok(
            !s.io.some(
              (e) => e.op === "process" && String(e.args[0]).endsWith("/tsgo"),
            ),
            "cheap Source path never starts the compiler",
          );
        literal(n, o, steps[i]);
      }
      row.qualifications = [...new Set(row.qualifications)];
      row.passed = true;
      if (!sourceOnly && !row.nativeOnly) {
        const evidence = row.qualifications.length
          ? qualifiedNativeEvidence
          : nativeEvidence;
        evidence[id] = [
          ...new Set(native.flatMap((n) => n.trace.observedCalls)),
        ];
      }
    } catch (error) {
      row.failure = {
        kind: failureKind,
        message: error.message,
        actual: error.actual,
        expected: error.expected,
      };
      failures.push({ id, ...row.failure });
    }
    cases.push(row);
    save();
  }
  if (!sourceOnly && !selected) {
    const first = cases.find((r) => r.passed && !r.nativeOnly)?.native[0]
      ?.trace;
    assert.ok(first);
    for (const changed of [
      { ...first, id: "wrong" },
      { ...first, observedCalls: [] },
      { ...first, unexpected: true },
    ]) {
      assert.throws(() => trusted(changed, first.id));
      responseGuards++;
    }
    for (const bad of [
      {},
      { id: "bad", trace: path.join(temporary, "bad.json"), argv: [] },
      {
        id: "bad",
        trace: path.join(temporary, "bad.json"),
        argv: ["."],
        compiler: 1,
      },
      {
        id: "bad",
        trace: path.join(temporary, "bad.json"),
        argv: ["."],
        compiler,
        lateReports: "yes",
      },
      {
        id: "bad",
        trace: path.join(temporary, "bad.json"),
        argv: ["."],
        compiler,
        unknown: true,
      },
    ]) {
      const r = spawnSync(binary, [], {
        input: JSON.stringify(bad),
        encoding: "utf8",
      });
      assert.ifError(r.error);
      assert.notEqual(r.status, 0);
      protocol.push({
        id: `invalid-${protocol.length}`,
        protocol: true,
        passed: true,
        status: r.status,
        stdout: r.stdout,
        stderr: r.stderr,
      });
    }
  }
  assert.deepEqual(
    Object.fromEntries(
      sourceFiles.map((file) => [
        file,
        hash(fs.readFileSync(path.join(root, "packages/code-graph/src", file))),
      ]),
    ),
    sourceHashes,
    "Source product immutable during comparison",
  );
  save();
  if (!process.env.DEMLIK_MUTATION_ALLOW_FAILURES)
    assert.deepEqual(failures, []);
} finally {
  save();
  fs.rmSync(temporary, { recursive: true, force: true });
}
