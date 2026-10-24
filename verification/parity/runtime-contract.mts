import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { Cause, Effect, Exit, Scope } from "effect";
import { z } from "zod";
import { run as runEffect } from "../../packages/tea/src/effect/index.js";
import {
  Cmd,
  defineMachine,
  Outcome,
  type Store,
} from "../../packages/tea/src/index.js";
import { memoryStore } from "../../packages/tea/src/mem/index.js";
import { run as runPromise } from "../../packages/tea/src/promise/index.js";
import type { validateSync } from "../../packages/tea/src/pure/core.js";

const modes = [
  "success",
  "declared",
  "malformed",
  "undefined",
  "undeclared",
  "defect",
  "forged",
  "plain-failure",
] as const;
const modeSchema = z.enum(modes);
export const runtimeContractScript = z
  .object({
    profile: z.enum(["promise", "effect"]),
    steps: z.array(modeSchema),
    issue: z.string(),
    at: z.number(),
  })
  .strict();
type Script = z.infer<typeof runtimeContractScript>;
type Schema<T> = Parameters<typeof validateSync<T>>[0];
type Body = { body: string };
type Model = { started: number; progress: number; settled: unknown[] };
const fetchCommand = z
  .object({ type: z.literal("fetch"), mode: modeSchema })
  .strict();
const settledMessage = z.union([
  z
    .object({
      type: z.literal("fetch_ok"),
      cmd: fetchCommand,
      value: z.object({ body: z.string() }).strict(),
      at: z.number(),
    })
    .strict(),
  z
    .object({
      type: z.literal("fetch_err"),
      cmd: fetchCommand,
      error: z.object({ _tag: z.string() }).passthrough(),
      at: z.number(),
    })
    .strict(),
]);
const modelSchema = z
  .object({
    started: z.number().int().nonnegative(),
    progress: z.number().int().nonnegative(),
    settled: z.array(settledMessage),
  })
  .strict();
const messageSchema = z.union([
  z.object({ type: z.literal("Start"), mode: modeSchema }).strict(),
  z.object({ type: z.literal("Progress"), note: z.string() }).strict(),
  settledMessage,
]);
const commandSchema = z.union([
  fetchCommand,
  z.object({ type: z.literal("After") }).strict(),
  z.object({ type: z.literal("Plain") }).strict(),
]);
const normalizedError = z.discriminatedUnion("category", [
  z
    .object({
      category: z.literal("handler"),
      cause: z.object({ name: z.string(), message: z.string() }).strict(),
    })
    .strict(),
  z
    .object({
      category: z.literal("contract"),
      cause: z
        .object({
          name: z.enum(["UndeclaredFailureError", "OutcomeContractError"]),
          _tag: z.string(),
          message: z.string(),
          cmdType: z.string(),
        })
        .passthrough(),
    })
    .strict(),
  z
    .object({
      category: z.literal("unexpected"),
      name: z.string(),
      debug: z.string(),
    })
    .strict(),
]);
const comparisonSchema = z
  .object({
    state: modelSchema,
    saved: modelSchema.nullable(),
    clockCalls: z.number().int().nonnegative(),
    dispatches: z.array(
      z
        .object({ case: modeSchema, error: normalizedError.nullable() })
        .strict(),
    ),
    reports: z.array(
      z
        .object({
          phase: z.enum([
            "interpret",
            "reduce",
            "follow-up",
            "stop-save",
            "sub",
            "sub-cleanup",
            "discard",
            "identity-drop",
            "listener",
            "observer",
            "boot",
            "event",
            "port-emit",
          ]),
          error: normalizedError,
        })
        .strict(),
    ),
    trace: z.array(
      z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("save"), state: modelSchema }).strict(),
        z
          .object({ kind: z.literal("handler"), command: commandSchema })
          .strict(),
        z
          .object({
            kind: z.literal("commit"),
            msg: messageSchema.nullable(),
            state: modelSchema,
          })
          .strict(),
      ]),
    ),
  })
  .strict();
type Executed = {
  comparison: z.infer<typeof comparisonSchema>;
  effectExits: string[];
};

function failureData(error: unknown) {
  if (!(error instanceof Error)) throw error;
  if (
    error.name === "UndeclaredFailureError" ||
    error.name === "OutcomeContractError"
  ) {
    return {
      category: "contract",
      cause: {
        name: error.name,
        message: error.message,
        ...Object.fromEntries(Object.entries(error)),
      },
    };
  }
  return {
    category: "handler",
    cause: { name: error.name, message: error.message },
  };
}
export async function executeRuntimeContract(input: Script): Promise<Executed> {
  const trace: unknown[] = [],
    reports: unknown[] = [],
    effectExits: string[] = [];
  const issue = input.issue;
  const output: Schema<Body> = {
    "~standard": {
      version: 1,
      vendor: "runtime-contract",
      validate(value) {
        if (
          value !== null &&
          typeof value === "object" &&
          "body" in value &&
          typeof value.body === "string"
        )
          return { value: { body: value.body } };
        return { issues: [{ path: ["body"], message: issue }] };
      },
    },
  };
  const fetch = Cmd.define("fetch", {
    input: z.object({ mode: modeSchema }),
    ok: output,
    err: ["timeout"],
  });
  type Fetch = ReturnType<typeof fetch>;
  type Msg =
    | { type: "Start"; mode: z.infer<typeof modeSchema> }
    | { type: "Progress"; note: string }
    | ReturnType<typeof fetch.ok>
    | ReturnType<typeof fetch.err>;
  type Command = Fetch | { type: "After" } | { type: "Plain" };
  const machine = defineMachine({
    types: {
      model: {} as Model,
      msg: {} as Msg,
      cmd: {} as Command,
      ctx: undefined,
    },
    cmds: [fetch],
    init: (loaded) => [loaded ?? { started: 0, progress: 0, settled: [] }, []],
    update: {
      Start: (state, msg) => [
        { ...state, started: state.started + 1 },
        [
          msg.mode === "plain-failure"
            ? { type: "Plain" }
            : fetch({ mode: msg.mode }),
          { type: "After" },
        ],
      ],
      Progress: (state) => [{ ...state, progress: state.progress + 1 }, []],
      fetch_ok: (state, msg) => [
        { ...state, settled: [...state.settled, msg] },
        [],
      ],
      fetch_err: (state, msg) => [
        { ...state, settled: [...state.settled, msg] },
        [],
      ],
    },
  });
  const saved = memoryStore<Model>(null);
  const store: Store<Model> = {
    load: () => saved.load(),
    migrate: (raw) => saved.migrate(raw),
    async save(state) {
      trace.push({ kind: "save", state });
      await saved.save(state);
    },
  };
  let clockCalls = 0;
  const shared = {
    ctx: undefined,
    store,
    clock: () => {
      clockCalls++;
      return input.at;
    },
    onError: (error: unknown, context: { phase: string }) =>
      reports.push({ phase: context.phase, error: failureData(error) }),
  };
  const definedBoom = new Error("defined handler defect"),
    plainBoom = new Error("plain handler failure");
  const declared = { _tag: "timeout", afterMs: 12, details: { attempt: 2 } };
  const undeclared = { _tag: "unknown", reason: "undeclared detail" };
  let dispatch: (msg: Msg) => Promise<void>,
    getState: () => Model,
    stop: () => Promise<void>;
  const committed = (msg: Msg, state: Model) =>
    trace.push({ kind: "commit", msg, state });
  const booted = (state: Model) =>
    trace.push({ kind: "commit", msg: null, state });
  if (input.profile === "promise") {
    const interpret = {
      fetch: async (cmd: Fetch) => {
        trace.push({ kind: "handler", command: cmd });
        return Outcome.ok({ body: "kept", extra: "stripped" });
      },
      After: async (cmd: { type: "After" }) => {
        trace.push({ kind: "handler", command: cmd });
        return { type: "Progress", note: "after" } as const;
      },
      Plain: async (cmd: { type: "Plain" }) => {
        trace.push({ kind: "handler", command: cmd });
        throw plainBoom;
      },
    };
    // Deliberately malformed caller values enter only this verification boundary.
    Reflect.set(
      interpret,
      "fetch",
      async (cmd: Fetch, _ctx: unknown, emit: (msg: Msg) => void) => {
        trace.push({ kind: "handler", command: cmd });
        switch (cmd.mode) {
          case "success":
            return Outcome.ok({ body: "kept", extra: "stripped" });
          case "declared":
            return Outcome.err(declared);
          case "malformed":
            return Outcome.ok({ body: 12 });
          case "undefined":
            return undefined;
          case "undeclared":
            return Outcome.err(undeclared);
          case "defect":
            throw definedBoom;
          case "forged":
            emit(fetch.ok(cmd, { body: "forged" }, input.at));
            return undefined;
          case "plain-failure":
            throw new Error("plain uses its own command");
        }
      },
    );
    const handle = runPromise(machine, { ...shared, interpret });
    handle.onBoot(booted);
    handle.observe(committed);
    const runtime = await handle.ready;
    dispatch = (msg) => runtime.dispatch(msg);
    getState = runtime.getState;
    stop = runtime.stop;
  } else {
    const interpret = {
      fetch: (cmd: Fetch) =>
        Effect.sync(() => {
          trace.push({ kind: "handler", command: cmd });
          return { body: "kept", extra: "stripped" };
        }),
      After: (cmd: { type: "After" }) =>
        Effect.sync(() => {
          trace.push({ kind: "handler", command: cmd });
          return { type: "Progress", note: "after" } as const;
        }),
      Plain: (cmd: { type: "Plain" }) =>
        Effect.sync(() => {
          trace.push({ kind: "handler", command: cmd });
        }).pipe(Effect.andThen(Effect.fail(plainBoom))),
    };
    Reflect.set(interpret, "fetch", (cmd: Fetch) =>
      Effect.suspend<unknown, unknown, never>(() => {
        trace.push({ kind: "handler", command: cmd });
        switch (cmd.mode) {
          case "success":
            return Effect.succeed({ body: "kept", extra: "stripped" });
          case "declared":
            return Effect.fail(declared);
          case "malformed":
            return Effect.succeed({ body: 12 });
          case "undefined":
            return Effect.succeed(undefined);
          case "undeclared":
            return Effect.fail(undeclared);
          case "defect":
            return Effect.die(definedBoom);
          // Effect cells have no checked dispatch callback. A forged successful
          // return is output data, so it passes through the actual output parser.
          case "forged":
            return Effect.succeed(fetch.ok(cmd, { body: "forged" }, input.at));
          case "plain-failure":
            return Effect.die(new Error("plain uses its own command"));
        }
      }),
    );
    const scope = await Effect.runPromise(Scope.make());
    const handle = await Effect.runPromise(
      Scope.provide(scope)(runEffect(machine, { ...shared, interpret })),
    );
    handle.onBoot(booted);
    handle.observe(committed);
    async function settled<A, E>(work: Effect.Effect<A, E>) {
      const exit = await Effect.runPromiseExit(work);
      if (Exit.isSuccess(exit)) return exit.value;
      effectExits.push(Cause.hasFails(exit.cause) ? "typed-failure" : "defect");
      throw Cause.squash(exit.cause);
    }
    const runtime = await settled(handle.ready);
    dispatch = (msg) => settled(runtime.dispatch(msg));
    getState = runtime.getState;
    stop = () => Effect.runPromise(Scope.close(scope, Exit.void));
  }
  const dispatches: unknown[] = [];
  for (const mode of input.steps) {
    let error: unknown = null;
    try {
      await dispatch({ type: "Start", mode });
    } catch (cause) {
      error = failureData(cause);
    }
    dispatches.push({ case: mode, error });
    await dispatch({ type: "Progress", note: "check" });
  }
  const state = getState();
  await stop();
  return {
    comparison: comparisonSchema.parse({
      state,
      saved: await saved.load(),
      trace,
      reports,
      dispatches,
      clockCalls,
    }),
    effectExits,
  };
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}
function digest(value: unknown) {
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}
type CommandOptions = { cwd?: string; env?: NodeJS.ProcessEnv };
function command(
  binary: string,
  args: string[],
  input?: string,
  options: CommandOptions = {},
) {
  const result = spawnSync(binary, args, {
    encoding: "utf8",
    input,
    maxBuffer: 64 * 1024 * 1024,
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `${binary} ${args.join(" ")} exited ${result.status}\n${result.stdout}\n${result.stderr}`,
    );
  return result.stdout;
}
function cargo() {
  return process.env.CARGO ?? "cargo";
}
function rustc() {
  const configured = process.env.RUSTC;
  if (configured) return configured;
  const executable = cargo();
  return isAbsolute(executable) ? join(dirname(executable), "rustc") : "rustc";
}
function nativeBinary(
  cwd = process.cwd(),
  target = process.env.CARGO_TARGET_DIR,
) {
  return join(
    target ? resolve(cwd, target) : join(cwd, "target"),
    "debug",
    "examples",
    "runtime_contract_driver",
  );
}
function buildRust(cwd = process.cwd(), target?: string) {
  const env = {
    ...process.env,
    CARGO_NET_OFFLINE: "true",
    ...(target ? { CARGO_TARGET_DIR: target } : {}),
  };
  command(
    cargo(),
    [
      "build",
      "--locked",
      "-p",
      "demlik-tea",
      "--example",
      "runtime_contract_driver",
    ],
    undefined,
    { cwd, env },
  );
}
const nativeResponseSchema = z
  .object({
    comparison: comparisonSchema,
    observedRustCalls: z.array(z.string()).nonempty(),
  })
  .strict();
function native(scripts: Script[], binary = nativeBinary()) {
  const output = command(
    binary,
    [],
    `${scripts.map((script) => JSON.stringify(script)).join("\n")}\n`,
  );
  const responses = output
    .trim()
    .split("\n")
    .map((line) => nativeResponseSchema.parse(JSON.parse(line)));
  assert.equal(responses.length, scripts.length, "native response count");
  return responses;
}
function fileDigest(file: string) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}
function mutationControl(
  cases: ReturnType<typeof scripts>,
  expected: Executed[],
) {
  const temporary = mkdtempSync(
    join(tmpdir(), "demlik-runtime-contract-control-"),
  );
  const source = "crates/tea/src/runtime/engine.rs",
    activeDigest = fileDigest(source);
  try {
    for (const file of ["Cargo.toml", "Cargo.lock"])
      cpSync(file, join(temporary, file));
    cpSync("crates", join(temporary, "crates"), {
      recursive: true,
      filter: (file) =>
        !file
          .split(sep)
          .some(
            (part) =>
              part === "target" || part === "node_modules" || part === ".git",
          ),
    });
    if (existsSync(".cargo"))
      cpSync(".cargo", join(temporary, ".cargo"), { recursive: true });
    const copiedSource = join(temporary, source),
      original = readFileSync(copiedSource, "utf8"),
      needle = "let result = if defined {";
    assert.equal(
      original.split(needle).length,
      2,
      "mutation target must be unique",
    );
    assert.equal(
      fileDigest(copiedSource),
      activeDigest,
      "disposable source copy matches the tested engine",
    );
    writeFileSync(
      copiedSource,
      original.replace(needle, "let result = if false && defined {"),
    );
    const mutantDigest = fileDigest(copiedSource),
      target = join(temporary, "target");
    buildRust(temporary, target);
    const mutant = native(
      cases.map((item) => item.script),
      nativeBinary(temporary, target),
    );
    const detected = cases
      .filter((_, index) => {
        try {
          assert.deepEqual(
            mutant[index].comparison,
            expected[index].comparison,
          );
          return false;
        } catch {
          return true;
        }
      })
      .map((item) => item.id);
    assert.ok(detected.length > 0);
    assert.equal(
      fileDigest(source),
      activeDigest,
      "active source remains unchanged",
    );
    return {
      name: "defined-handler-failure-propagates",
      isolation: "disposable-source-copy",
      source,
      baselineSourceDigest: activeDigest,
      mutantSourceDigest: mutantDigest,
      activeSourceUnchanged: true,
      detected,
    };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
function scripts() {
  const result: Array<{ id: string; script: Script }> = [];
  for (const profile of ["promise", "effect"] as const) {
    for (const mode of modes)
      result.push({
        id: `${profile}:${mode}`,
        script: {
          profile,
          steps: [mode],
          issue: "Caller issue: expected body text ✓",
          at: 17.25,
        },
      });
    for (let seed = 1; seed <= 16; seed++) {
      let state = seed;
      const steps = Array.from({ length: 12 }, () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return modes[(state >>> 16) % modes.length];
      });
      result.push({
        id: `${profile}:sequence:${seed}`,
        script: {
          profile,
          steps,
          issue: `Caller issue ${seed}: body "text"\u0000`,
          at: 17.25,
        },
      });
    }
  }
  return result;
}
function independentExpectations(
  script: Script,
  output: Awaited<ReturnType<typeof executeRuntimeContract>>["comparison"],
) {
  const expectedSettled = script.steps.filter(
    (mode) =>
      ["success", "declared", "malformed"].includes(mode) ||
      (script.profile === "effect" &&
        (mode === "undefined" || mode === "forged")),
  ).length;
  assert.equal(output.state.started, script.steps.length);
  assert.equal(
    output.state.progress,
    script.steps.length * 2 -
      script.steps.filter((mode) => mode === "plain-failure").length,
  );
  assert.equal(output.state.settled.length, expectedSettled);
  assert.deepEqual(output.saved, output.state);
  assert.equal(
    output.dispatches.filter(
      (row) =>
        typeof row === "object" &&
        row !== null &&
        "error" in row &&
        row.error !== null,
    ).length,
    script.steps.filter((mode) => mode === "plain-failure").length,
  );
  assert.equal(
    output.reports.length,
    script.steps.filter(
      (mode) =>
        mode === "undeclared" ||
        mode === "defect" ||
        (mode === "forged" && script.profile === "promise"),
    ).length,
  );
  for (const settled of output.state.settled) {
    const parsed = z
      .object({
        type: z.enum(["fetch_ok", "fetch_err"]),
        at: z.number(),
        value: z.unknown().optional(),
        error: z.unknown().optional(),
      })
      .passthrough()
      .parse(settled);
    assert.equal(parsed.at, script.at);
    if (parsed.type === "fetch_ok")
      assert.deepEqual(parsed.value, { body: "kept" });
    if (
      parsed.error !== null &&
      typeof parsed.error === "object" &&
      "_tag" in parsed.error &&
      parsed.error._tag === "malformed_result"
    )
      assert.deepEqual(parsed.error, {
        _tag: "malformed_result",
        issues: [{ path: "body", message: script.issue }],
      });
  }
}
export async function verifyRuntimeContracts(
  mutation = false,
  reportPath = "target/parity/runtime-contract.json",
  binaryOverride?: string,
) {
  assert.equal(process.version, "v22.21.1");
  assert.equal(process.versions.v8, "12.4.254.21-node.33");
  assert.ok(
    !(mutation && binaryOverride),
    "the disposable mutation control builds its own binary; use the override for central mutation runs",
  );
  const cases = scripts(),
    expected: Executed[] = [];
  for (const item of cases) {
    const parsed = runtimeContractScript.parse(item.script);
    const value = await executeRuntimeContract(parsed);
    independentExpectations(parsed, value.comparison);
    expected.push(value);
  }
  if (!binaryOverride) buildRust();
  const binary = binaryOverride ? resolve(binaryOverride) : nativeBinary();
  let actual = native(
    cases.map((item) => item.script),
    binary,
  );
  const failures: {
    id: string;
    message: string;
    typescript: { ok: true; output: unknown };
    rust: { ok: true; output: unknown };
  }[] = [];
  cases.forEach((item, index) => {
    try {
      assert.deepEqual(
        actual[index].comparison,
        expected[index].comparison,
        item.id,
      );
    } catch (error) {
      failures.push({
        id: `runtime-contract.${item.id}`,
        message: error instanceof Error ? error.message : String(error),
        typescript: { ok: true, output: expected[index].comparison },
        rust: { ok: true, output: actual[index].comparison },
      });
    }
  });
  const controls = [];
  if (mutation && !failures.length) {
    controls.push(mutationControl(cases, expected));
    actual = native(
      cases.map((item) => item.script),
      binary,
    );
    cases.forEach((item, index) => {
      assert.deepEqual(
        actual[index].comparison,
        expected[index].comparison,
        `rechecked:${item.id}`,
      );
    });
  }
  const report = {
    status: failures.length ? "failed" : "passed",
    passed: cases.length - failures.length,
    failures,
    binarySha256: createHash("sha256")
      .update(readFileSync(binary))
      .digest("hex"),
    node: process.version,
    v8: process.versions.v8,
    rustc: command(rustc(), ["--version"]).trim(),
    comparisonCount: cases.length,
    scriptStepsPerImplementation: cases.reduce(
      (count, item) => count + item.script.steps.length,
      0,
    ),
    appliedTransitionsPerImplementation: expected.reduce(
      (count, item) =>
        count +
        item.comparison.trace.filter(
          (entry) => entry.kind === "commit" && entry.msg !== null,
        ).length,
      0,
    ),
    executions: {
      typescript: cases.length,
      rustBaseline: cases.length,
      rustMutation: controls.length ? cases.length : 0,
      rustRechecked: controls.length ? cases.length : 0,
    },
    cases: cases.map((item, index) => ({
      id: item.id,
      input: item.script,
      equal: !failures.some(
        (failure) => failure.id === `runtime-contract.${item.id}`,
      ),
      observedRustCalls: actual[index].observedRustCalls,
      observedRustFunctions: [...new Set(actual[index].observedRustCalls)],
      settled: expected[index].comparison.state.settled,
      dispatches: expected[index].comparison.dispatches,
      reports: expected[index].comparison.reports,
      effectExits: expected[index].effectExits,
      sourceDigest: digest(expected[index].comparison),
      rustDigest: digest(actual[index].comparison),
      trace:
        item.script.steps.length === 1
          ? expected[index].comparison.trace
          : undefined,
    })),
    controls,
    scope: {
      compared:
        "Actual settled messages, contract failure data, original handler failure payloads, later commands, store writes and public commits.",
      normalization:
        "Error stack/object identity are omitted. Native RuntimeError::Handler and the original public TS failure share category handler plus retained cause data.",
      profileDifferences: {
        undefined:
          "Promise handler undefined skips settlement; Effect.succeed(undefined) is output-parsed and produces malformed_result for this schema.",
        forged:
          "Promise uses its real checked callback and drops a forged terminal dispatch. Effect cells have no callback; returning that forged object is successful raw output and is output-parsed.",
      },
    },
  };
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return {
    cases: cases.length,
    passed: cases.length - failures.length,
    failures: failures.length,
    controls: controls.length,
    report: reportPath,
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const { values } = parseArgs({
    options: {
      "mutation-check": { type: "boolean", default: false },
      "native-binary": { type: "string" },
      report: {
        type: "string",
        default: "target/parity/runtime-contract.json",
      },
    },
  });
  const result = await verifyRuntimeContracts(
    values["mutation-check"],
    values.report,
    values["native-binary"],
  );
  console.log(JSON.stringify(result));
  if (result.failures) process.exitCode = 1;
}
