import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { defineProgram } from "../../packages/code-graph/src/cli.js";
import {
  resolveCollapseSettings,
  resolveNodeKindRules,
  resolveThresholds,
  withEntryPresets,
} from "../../packages/code-graph/src/config.js";
import { tsgoBinary } from "../../packages/code-graph/src/engine/tsgo.js";

const binary = process.argv[2];
assert.ok(binary);
assert.ok(process.argv.length <= 4);
assert.equal(process.version, "v22.21.1");
assert.equal(process.versions.v8, "12.4.254.21-node.33");
const repository = fileURLToPath(new URL("../..", import.meta.url));
const loader = createRequire(import.meta.url).resolve("tsx");
const directory = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "demlik-cli-frontdoor-")),
);
const compiler = await tsgoBinary();
type Stdio =
  | "normal"
  | "stdout-bad"
  | "stderr-bad"
  | "both-bad"
  | "stdout-closed";
type Input =
  | { action: "frontdoor"; argv: string[]; initial?: number; compiler?: string }
  | { action: "clean"; payload: string; initial?: number }
  | { action: "out"; payload: string; destination?: string; initial?: number }
  | {
      action: "exit";
      code: number | "NaN" | "Infinity" | "-Infinity" | "-0";
      initial?: number;
    };
type Case = {
  id: string;
  input: Input;
  stdio: Stdio;
  qualification?: "os-diagnostic" | "runtime-stack" | "argument-diagnostic";
  continuation?: boolean;
  rawArgv?: boolean;
  warning?: boolean;
};
const cases: Case[] = [];
function add(
  id: string,
  input: Input,
  options: Partial<Omit<Case, "id" | "input">> = {},
) {
  cases.push({ id, input, stdio: "normal", ...options });
}
const front = (
  id: string,
  argv: string[],
  options: Partial<Omit<Case, "id" | "input">> = {},
) => add(id, { action: "frontdoor", argv, compiler: compiler.path }, options);
for (const [index, argv] of [
  [],
  ["--help"],
  ["-h"],
  ["--unknown"],
  ["missing"],
  ["regular-file"],
  ["pkg", "--by"],
  ["missing", "--thresholds=bad.json"],
  ["pkg", "--thresholds=bad.json", "--api=missing-map", "--by=rot"],
  [
    "pkg",
    "--node-kinds=bad.json",
    "--entry-preset=unknown",
    "--api=missing-map",
  ],
  [
    "pkg",
    "--entry-preset=unknown",
    "--collapse-config=bad.json",
    "--api=missing-map",
  ],
  ["pkg", "--collapse-config=bad.json", "--api=missing-map", "--by=rot"],
  ["pkg", "--node-kinds=record-null.json", "--api=missing-map"],
  ["pkg", "--api-base=HEAD"],
  ["pkg", "--api-policy=policy.json"],
  ["pkg", "--api=missing-map", "--by=rot"],
  ["pkg", "--api=missing-map", "--hotspots-limit=20", "--by=rot"],
  ["pkg", "--api=api.json", "--api-policy=policy.json"],
  ["pkg", "--api=missing-map"],
  ["pkg", "--api="],
  ["pkg", "--api=map-malformed.json"],
  ["pkg", "--api=map-invalid.json"],
].entries())
  front(
    `preflight.${index}`,
    argv,
    index === 12 ? { qualification: "runtime-stack" } : {},
  );
front("api.relative", ["pkg", "--api=api.json"]);
front("api.pretty", ["pkg", "--api=api.json", "--json", "--pretty"]);
front("api.relative-normalized-root", ["./pkg/../pkg/", "--api=api.json"]);
front("api.symlink-root", ["linked-package", "--api=api.json"]);
front("api.configs-before-dispatch", [
  "pkg",
  "--thresholds=thresholds.json",
  "--node-kinds=rules.json",
  "--entry-preset=nextjs",
  "--collapse-config=collapse.json",
  "--api=api.json",
]);
front("api.out", ["pkg", "--api=api.json", "--out=result.json"]);
front("api.stray-does-not-open-out", [
  "pkg",
  "--api=api.json",
  "--by=rot",
  "--out=must-not-be-written",
]);
add("api.zero-preserves-prior-exit", {
  action: "frontdoor",
  argv: ["pkg", "--api=api.json"],
  compiler: compiler.path,
  initial: 7,
});
front("api.out-empty", ["pkg", "--api=api.json", "--out="], {
  qualification: "os-diagnostic",
});
front(
  "api.out-missing-parent",
  ["pkg", "--api=api.json", "--out=missing/result"],
  { qualification: "os-diagnostic" },
);
front("api.out-directory", ["pkg", "--api=api.json", "--out=out-directory"], {
  qualification: "os-diagnostic",
});
front("api.warning", ["pkg", "--api=api.json"], { warning: true });
front("api.warning-bad-stderr", ["pkg", "--api=api.json"], {
  warning: true,
  stdio: "stderr-bad",
});
front("api.warning-both-bad", ["pkg", "--api=api.json"], {
  warning: true,
  stdio: "both-bad",
});
front(
  "api.warning-out-banner-bad",
  ["pkg", "--api=api.json", "--out=result.json"],
  { warning: true, stdio: "stderr-bad" },
);
front("api.stdout-bad", ["pkg", "--api=api.json"], { stdio: "stdout-bad" });
front("api.stdout-closed-pipe", ["pkg", "--api=api.json"], {
  stdio: "stdout-closed",
});
front("help.stdout-bad", ["--help"], { stdio: "stdout-bad" });
front("missing.stderr-bad", ["missing"], { stdio: "stderr-bad" });
front("api.out-banner-bad", ["pkg", "--api=api.json", "--out=result.json"], {
  stdio: "stderr-bad",
});
front("api.raw-map-name", ["pkg", "--api=raw\ud800.json"], { rawArgv: true });
front("api.raw-out-name", ["pkg", "--api=api.json", "--out=raw\ud800.txt"], {
  rawArgv: true,
});
front("api.null-out", ["pkg", "--api=api.json", "--out=raw\u0000\ud800"], {
  rawArgv: true,
  qualification: "argument-diagnostic",
});
front("path.raw-missing", ["missing\ud800"], { rawArgv: true });
front("path.null", ["raw\u0000\ud800"], { rawArgv: true });
for (const [id, argv] of [
  ["graph", ["pkg", "--graph", "--data", "--headers"]],
  ["symlink-root", ["linked-package", "--graph"]],
  [
    "configs",
    [
      "pkg",
      "--thresholds=thresholds.json",
      "--node-kinds=rules.json",
      "--entry-preset=nextjs",
      "--collapse-config=collapse.json",
      "--json",
      "--out=must-not-be-written",
    ],
  ],
] as const)
  add(
    `continue.${id}`,
    {
      action: "frontdoor",
      argv: [...argv],
      compiler: "/missing/unused/compiler",
    },
    { continuation: true },
  );
for (const [id, input] of [
  ["stdout", { action: "out", payload: "hello\n" }],
  ["stdout-empty", { action: "out", payload: "" }],
  ["stdout-raw", { action: "out", payload: "raw\ud800\u0000 pair😀\n" }],
  [
    "out",
    {
      action: "out",
      destination: "result.txt",
      payload: "raw\ud800\u0000 pair😀\n",
    },
  ],
  ["out-empty", { action: "out", destination: "result.txt", payload: "" }],
  [
    "out-missing",
    { action: "out", destination: "missing/result", payload: "body" },
  ],
  [
    "out-directory",
    { action: "out", destination: "out-directory", payload: "body" },
  ],
  [
    "out-null",
    { action: "out", destination: "raw\u0000\ud800", payload: "body" },
  ],
  [
    "clean",
    { action: "clean", payload: "raw\ud800\nline\t\u0085", initial: 7 },
  ],
] satisfies [string, Input][])
  add(
    `helper.${id}`,
    input,
    id === "out-null"
      ? { qualification: "argument-diagnostic" }
      : id === "out-missing" || id === "out-directory"
        ? { qualification: "os-diagnostic" }
        : {},
  );
const exitCodes: Extract<Input, { action: "exit" }>["code"][] = [
  0,
  "-0",
  3,
  -1,
  2147483647,
  2147483648,
  4294967296,
  9007199254740991,
  9007199254740992,
  -9007199254740992,
  1.5,
  "NaN",
  "Infinity",
  "-Infinity",
  1e100,
  1e21,
  10000000000.5,
];
for (const [index, code] of exitCodes.entries())
  add(`exit.${index}`, { action: "exit", code, initial: 7 });
add(
  "helper.empty-stdout-bad",
  { action: "out", payload: "" },
  { stdio: "stdout-bad" },
);
add(
  "helper.clean-stderr-bad",
  { action: "clean", payload: "refusal" },
  { stdio: "stderr-bad" },
);
add(
  "helper.out-banner-bad",
  { action: "out", destination: "result.txt", payload: "body" },
  { stdio: "stderr-bad" },
);
const selected = process.env.DEMLIK_CLI_FRONTDOOR_CASES?.split(",");
if (selected) {
  assert.equal(new Set(selected).size, selected.length);
  for (const id of selected)
    assert.ok(
      cases.some((row) => row.id === id),
      id,
    );
}
const selectedCases = selected
  ? cases.filter((row) => selected.includes(row.id))
  : cases;
function setup(cwd: string, warning: boolean) {
  fs.mkdirSync(path.join(cwd, "pkg/src"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, "pnpm-workspace.yaml"),
    'packages:\n  - "pkg"\n',
  );
  fs.writeFileSync(
    path.join(cwd, "pkg/package.json"),
    '{"name":"fixture","type":"module"}',
  );
  fs.writeFileSync(
    path.join(cwd, "pkg/tsconfig.json"),
    JSON.stringify({
      compilerOptions: { target: "ESNext", module: "ESNext", types: [] },
      include: ["src"],
    }),
  );
  fs.writeFileSync(
    path.join(cwd, "pkg/src/index.ts"),
    warning
      ? "export const value: string = 123;\n"
      : "export const value = 123;\n",
  );
  fs.symlinkSync("pkg", path.join(cwd, "linked-package"), "dir");
  fs.mkdirSync(path.join(cwd, "out-directory"));
  for (const [name, text] of Object.entries({
    "api.json": '{".":{"entry":"src/index.ts"}}',
    "raw�.json": '{".":{"entry":"src/index.ts"}}',
    "bad.json": "{bad",
    "record-null.json": '{"entryNames":{"constructor":null}}',
    "thresholds.json": '{"longFunctionLoc":23}',
    "rules.json": '{"entryNames":{"worker":["^start$"]}}',
    "collapse.json": '{"minSignals":3}',
    "map-malformed.json": "{bad",
    "map-invalid.json": '{"bad":{"entry":"src/index.ts"}}',
    "regular-file": "data",
  }))
    fs.writeFileSync(path.join(cwd, name), text);
}
function files(cwd: string): Record<string, string> {
  const result: Record<string, string> = {};
  function walk(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name),
        relative = path.relative(cwd, full);
      if (entry.isDirectory()) walk(full);
      else if (entry.isSymbolicLink())
        result[relative] = `symlink:${fs.readlinkSync(full)}`;
      else result[relative] = fs.readFileSync(full).toString("hex");
    }
  }
  walk(cwd);
  return result;
}
async function child(
  executable: string,
  args: string[],
  input: string | undefined,
  cwd: string,
  mode: Stdio,
  env: NodeJS.ProcessEnv,
) {
  const descriptors: number[] = [];
  let out: number | "pipe" = "pipe",
    err: number | "pipe" = "pipe";
  for (const stream of ["stdout", "stderr"] as const)
    if (
      mode === "both-bad" ||
      mode === (stream === "stdout" ? "stdout-bad" : "stderr-bad")
    ) {
      const file = path.join(path.dirname(cwd), `${stream}.readonly`);
      fs.writeFileSync(file, "initial");
      const fd = fs.openSync(file, "r");
      descriptors.push(fd);
      if (stream === "stdout") out = fd;
      else err = fd;
    }
  const process = spawn(executable, args, {
    cwd,
    env,
    stdio: ["pipe", out, err],
  });
  for (const fd of descriptors) fs.closeSync(fd);
  const stdout: Buffer[] = [],
    stderr: Buffer[] = [];
  process.stdout?.on("data", (chunk) => stdout.push(chunk));
  process.stderr?.on("data", (chunk) => stderr.push(chunk));
  if (mode === "stdout-closed") process.stdout?.destroy();
  process.stdin?.end(input);
  const end = await new Promise<{
    status: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    process.on("error", reject);
    process.on("close", (status, signal) => resolve({ status, signal }));
  });
  return {
    ...end,
    stdout: Buffer.concat(stdout).toString("hex"),
    stderr: Buffer.concat(stderr).toString("hex"),
  };
}
function sourcePrepared(
  input: Extract<Input, { action: "frontdoor" }>,
  cwd: string,
) {
  const before = process.cwd();
  process.chdir(cwd);
  try {
    const p = defineProgram().exitOverride();
    p.parse(input.argv, { from: "user" });
    const opts = p.opts();
    const report = (message: string) => {
      throw new Error(message);
    };
    const thresholds = resolveThresholds(opts.thresholds, report);
    const fileRules = resolveNodeKindRules(opts.nodeKinds, report);
    assert.ok(fileRules);
    const rules = withEntryPresets(fileRules, opts.entryPreset, report);
    const collapse = resolveCollapseSettings(opts.collapseConfig, report);
    return JSON.parse(
      JSON.stringify({
        kind: "continue",
        root: fs.realpathSync(path.resolve(p.processedArgs[0])),
        options: opts,
        given: Object.keys(opts).filter(
          (key) => p.getOptionValueSource(key) === "cli",
        ),
        thresholds,
        rules,
        collapse,
      }),
    );
  } finally {
    process.chdir(before);
  }
}
const results: Record<string, unknown>[] = [],
  failures: { id: string; message: string }[] = [];
try {
  for (const row of selectedCases) {
    const owner = path.join(directory, row.id);
    fs.mkdirSync(owner);
    const cwd = path.join(owner, "cwd");
    setup(cwd, row.warning ?? false);
    const temporary = path.join(owner, "temp");
    fs.mkdirSync(temporary);
    const env = { ...process.env, TMPDIR: temporary };
    let source: unknown;
    let sourceRun: Awaited<ReturnType<typeof child>> | undefined;
    if (row.continuation) {
      assert.equal(row.input.action, "frontdoor");
      source = sourcePrepared(
        row.input as Extract<Input, { action: "frontdoor" }>,
        cwd,
      );
    } else {
      const sourceTrace = path.join(owner, "source.trace");
      const request = path.join(owner, "source.request");
      fs.writeFileSync(
        request,
        JSON.stringify({
          trace: sourceTrace,
          input: row.input,
          rawArgv: row.rawArgv,
        }),
      );
      sourceRun = await child(
        process.execPath,
        [
          "--import",
          loader,
          path.join(repository, "verification/parity/cli-frontdoor-source.mts"),
          ...(row.input.action === "frontdoor" && !row.rawArgv
            ? row.input.argv
            : []),
        ],
        undefined,
        cwd,
        row.stdio,
        { ...env, DEMLIK_FRONTDOOR_REQUEST: request },
      );
      assert.ok(fs.existsSync(sourceTrace), JSON.stringify(sourceRun));
      source = {
        ...sourceRun,
        events: fs
          .readFileSync(sourceTrace, "utf8")
          .trimEnd()
          .split("\n")
          .map((line) => JSON.parse(line)),
        files: files(cwd),
        tempResidues: fs.readdirSync(temporary),
      };
    }
    fs.rmSync(cwd, { recursive: true, force: true });
    setup(cwd, row.warning ?? false);
    fs.rmSync(temporary, { recursive: true, force: true });
    fs.mkdirSync(temporary);
    const nativeTrace = path.join(owner, "native.trace");
    const nativeRun = await child(
      binary,
      [],
      JSON.stringify({ trace: nativeTrace, input: row.input }),
      cwd,
      row.stdio,
      env,
    );
    let native: Record<string, unknown> | undefined;
    const qualifications: string[] = [];
    if (row.rawArgv) qualifications.push("typed-argv-source-injection");
    if (row.continuation) qualifications.push("prepared-continuation-only");
    if (row.qualification) qualifications.push(row.qualification);
    let passed = false;
    try {
      assert.ok(fs.existsSync(nativeTrace), JSON.stringify(nativeRun));
      native = z
        .record(z.string(), z.unknown())
        .parse(JSON.parse(fs.readFileSync(nativeTrace, "utf8")));
      assert.ok(z.array(z.string()).parse(native.observedCalls).length);
      const output = z.record(z.string(), z.unknown()).parse(native.output);
      const io = z
        .object({
          stored: z.number().nullable(),
          requested: z.number().nullable(),
          pending: z.array(
            z.object({
              stream: z.enum(["stdout", "stderr"]),
              osCode: z.number().nullable(),
            }),
          ),
        })
        .parse(output.io);
      if (row.continuation) {
        const { io: _, ...actual } = output;
        assert.deepEqual(actual, source);
        assert.equal(nativeRun.stdout, "");
        assert.equal(nativeRun.stderr, "");
      } else {
        const expected = z
          .object({
            status: z.number().nullable(),
            signal: z.unknown(),
            stdout: z.string(),
            stderr: z.string(),
            events: z.array(z.record(z.string(), z.unknown())),
            files: z.record(z.string(), z.string()),
            tempResidues: z.array(z.string()),
          })
          .parse(source);
        assert.equal(nativeRun.status, expected.status);
        assert.equal(nativeRun.signal, null);
        assert.equal(nativeRun.stdout, expected.stdout);
        assert.deepEqual(files(cwd), expected.files);
        // tsx's reference-only loader cache also uses TMPDIR. Retain all entries
        // in the receipt; cleanup belongs to the actual API emit/base owners.
        const compilerResidues = (entries: string[]) =>
          entries.filter((name) => name.startsWith("code-graph-api-"));
        assert.deepEqual(
          compilerResidues(fs.readdirSync(temporary)),
          compilerResidues(expected.tempResidues),
        );
        const caught = expected.events.find(
          (event) => event.event === "thrown",
        );
        const late = expected.events.find(
          (event) => event.event === "uncaught",
        );
        const exit = expected.events.find((event) => event.event === "exit");
        if (row.qualification === "argument-diagnostic") {
          const error = z
            .object({
              name: z.literal("TypeError"),
              code: z.literal("ERR_INVALID_ARG_VALUE"),
              argument: z.string(),
              location: z.literal("path"),
              cause: z.string().min(1),
              causeKind: z.literal("InvalidInput"),
              message: z.string(),
            })
            .parse(
              row.input.action === "frontdoor" ? output.failure : output.error,
            );
          assert.equal(error.argument, "raw\u0000\ud800");
          assert.match(error.message, /native argument diagnostic:/);
          if (row.input.action === "frontdoor") {
            assert.equal(output.apiCode, 3);
            assert.equal(io.stored, 3);
            assert.match(
              Buffer.from(expected.stderr, "hex").toString(),
              /^code-graph: unexpected error: The argument 'path'.*without null bytes/,
            );
            assert.equal(
              Buffer.from(nativeRun.stderr, "hex").toString(),
              `code-graph: unexpected error: ${error.message}\n`,
            );
          } else {
            assert.equal(caught?.name, error.name);
            assert.equal(caught.code, error.code);
            assert.match(
              String(caught.message),
              /^The argument 'path'.*without null bytes/,
            );
            assert.equal(io.stored, caught.exitCode ?? null);
            assert.equal(nativeRun.stderr, "");
          }
        } else if (row.qualification === "os-diagnostic") {
          assert.match(
            Buffer.from(expected.stderr, "hex").toString(),
            /ENOENT|EISDIR/,
          );
          const error = z
            .object({
              name: z.literal("Error"),
              path: z.string(),
              osCode: z.number(),
            })
            .parse(
              row.input.action === "frontdoor" ? output.failure : output.error,
            );
          const destination =
            row.input.action === "out"
              ? row.input.destination
              : row.input.action === "frontdoor"
                ? row.input.argv
                    .find((argument) => argument.startsWith("--out="))
                    ?.slice(6)
                : undefined;
          assert.equal(error.path, destination);
          assert.equal(error.osCode, destination === "out-directory" ? 21 : 2);
          if (row.input.action === "frontdoor")
            assert.equal(
              Buffer.from(nativeRun.stderr, "hex").toString(),
              `code-graph: unexpected error: ${z.object({ message: z.string() }).parse(output.failure).message}\n`,
            );
          else {
            assert.equal(nativeRun.stderr, "");
            assert.equal(caught?.path, error.path);
            assert.equal(caught?.name, error.name);
            assert.equal(
              caught?.code,
              error.osCode === 21 ? "EISDIR" : "ENOENT",
            );
          }
          assert.equal(
            io.stored,
            row.input.action === "frontdoor"
              ? (exit?.exitCode ?? null)
              : (caught?.exitCode ?? null),
          );
        } else if (row.qualification === "runtime-stack") {
          assert.equal(output.kind, "thrown");
          assert.deepEqual(output.error, {
            name: late?.name,
            message: late?.message,
          });
          assert.equal(io.stored, late?.exitCode ?? null);
        } else if (caught) {
          qualifications.push("runtime-stack");
          assert.deepEqual(output.error, {
            name: caught.name,
            code: caught.code,
            message: caught.message,
          });
          assert.equal(io.stored, caught.exitCode ?? null);
        } else if (io.pending.length) {
          qualifications.push("stdio-runtime-notification");
          assert.equal(
            expected.stderr === "" ||
              row.stdio === "stdout-bad" ||
              row.stdio === "stdout-closed",
            true,
          );
          if (output.immediate === true) {
            assert.equal(late, undefined);
            assert.equal(io.stored, 0);
          } else {
            assert.ok(late);
            assert.equal(
              late.code,
              io.pending[0].osCode === 9 ? "EBADF" : "EPIPE",
            );
            assert.equal(late.stream, io.pending[0].stream);
            assert.equal(io.stored, late.exitCode ?? null);
          }
        } else {
          assert.equal(nativeRun.stderr, expected.stderr);
          assert.equal(io.stored, exit?.exitCode ?? null);
        }
      }
      passed = true;
    } catch (error) {
      failures.push({ id: row.id, message: String(error) });
    }
    results.push({
      ...row,
      executionProfile: row.continuation
        ? "prepared-component"
        : row.input.action !== "frontdoor"
          ? "source-helper-process"
          : row.rawArgv
            ? "typed-argv-cli-process"
            : "full-cli-process",
      passed,
      qualifications,
      source,
      native: {
        ...nativeRun,
        trace: native,
        files: files(cwd),
        tempResidues: fs.readdirSync(temporary),
      },
    });
  }
  const invalidInputs: [string, string, RegExp][] = [
    ["malformed-json", "{", /EOF|key must be/],
    [
      "unknown-outer-field",
      JSON.stringify({ input: { action: "clean", payload: "body" }, extra: 1 }),
      /unknown field/,
    ],
    ["missing-input", "{}", /missing field/],
    ["unknown-action", JSON.stringify({ action: "missing" }), /unknown action/],
    [
      "argv-not-array",
      JSON.stringify({ action: "frontdoor", argv: "pkg" }),
      /invalid type/,
    ],
    [
      "unknown-input-field",
      JSON.stringify({ action: "clean", payload: "body", extra: 1 }),
      /unknown field/,
    ],
    ["missing-payload", JSON.stringify({ action: "out" }), /missing field/],
    [
      "wrong-exit-code",
      JSON.stringify({ action: "exit", code: "bogus" }),
      /untagged enum JsNumberInput/,
    ],
    [
      "wrong-destination",
      JSON.stringify({ action: "out", payload: "body", destination: 7 }),
      /expected a JavaScript string/,
    ],
    [
      "unsafe-initial",
      JSON.stringify({ action: "clean", payload: "body", initial: 2147483648 }),
      /invalid value/,
    ],
  ];
  for (const [id, input, diagnostic] of invalidInputs) {
    const trace = path.join(directory, `invalid-${id}.trace`);
    const envelope =
      id === "malformed-json"
        ? input
        : id === "unknown-outer-field"
          ? JSON.stringify({ ...JSON.parse(input), trace })
          : id === "missing-input"
            ? JSON.stringify({ trace })
            : JSON.stringify({ trace, input: JSON.parse(input) });
    const native = await child(
      binary,
      [],
      envelope,
      directory,
      "normal",
      process.env,
    );
    let passed = false;
    try {
      assert.notEqual(native.status, 0, id);
      assert.equal(native.stdout, "", id);
      assert.equal(fs.existsSync(trace), false, id);
      assert.match(
        Buffer.from(native.stderr, "hex").toString(),
        diagnostic,
        id,
      );
      passed = true;
    } catch (error) {
      failures.push({ id: `invalid.${id}`, message: String(error) });
    }
    results.push({
      id: `invalid.${id}`,
      valid: false,
      input: envelope,
      native,
      passed,
      observedCalls: [],
    });
  }
  const passing = results.filter(
    (row) => row.valid !== false && row.passed === true,
  );
  const report = {
    passed: passing.length,
    attempted: selectedCases.length,
    unqualifiedPairs: passing.filter(
      (row) => (row.qualifications as string[]).length === 0,
    ).length,
    qualifiedPairs: passing.filter(
      (row) => (row.qualifications as string[]).length > 0,
    ).length,
    rejectedInvalidInputs: results.filter(
      (row) => row.valid === false && row.passed === true,
    ).length,
    profiles: Object.fromEntries(
      [
        "full-cli-process",
        "typed-argv-cli-process",
        "source-helper-process",
        "prepared-component",
      ].map((profile) => {
        const rows = passing.filter((row) => row.executionProfile === profile);
        return [
          profile,
          {
            passing: rows.length,
            exact: rows.filter(
              (row) => (row.qualifications as string[]).length === 0,
            ).length,
          },
        ];
      }),
    ),
    nativeEvidence: Object.fromEntries(
      passing
        .filter((row) => (row.qualifications as string[]).length === 0)
        .map((row) => [
          row.id,
          (row.native as { trace: { observedCalls: string[] } }).trace
            .observedCalls,
        ]),
    ),
    qualifiedNativeEvidence: Object.fromEntries(
      passing
        .filter((row) => (row.qualifications as string[]).length > 0)
        .map((row) => [
          row.id,
          (row.native as { trace: { observedCalls: string[] } }).trace
            .observedCalls,
        ]),
    ),
    driverSha256: createHash("sha256")
      .update(fs.readFileSync(binary))
      .digest("hex"),
    reference: {
      node: process.version,
      v8: process.versions.v8,
      compiler,
      sourceHashes: Object.fromEntries(
        ["cli.ts", "index.ts", "config.ts", "api/cli.ts"].map((file) => [
          file,
          createHash("sha256")
            .update(
              fs.readFileSync(
                path.join(repository, "packages/code-graph/src", file),
              ),
            )
            .digest("hex"),
        ]),
      ),
      profile:
        "actual spawned frozen index.ts and actual helper functions; explicit prepared-only Source function comparisons for non-API continuations; per-case OS/stack/stdio/raw-argv qualifications; no functional graph completion claimed",
    },
    failures,
    cases: results,
  };
  if (process.argv[3])
    fs.writeFileSync(process.argv[3], `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    JSON.stringify({
      passed: report.passed,
      attempted: report.attempted,
      failures,
    }),
  );
  assert.deepEqual(failures, []);
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
