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
import { Effect, Exit, Scope, Stream } from "effect";
import { z } from "zod";
import { run as runEffect } from "../../packages/tea/src/effect/index.js";
import {
  defineMachine,
  definePort,
  IdentityDropNotice,
  PortNameCollisionError,
  type Runtime,
  type Sub,
} from "../../packages/tea/src/index.js";
import {
  driveToDone,
  run as runPromise,
} from "../../packages/tea/src/promise/index.js";

const cases = [
  "identity",
  "ports",
  "events",
  "timer-fire",
  "timer-stop",
  "timer-host-cancel",
  "timer-override",
  "scope-close",
  "drive-done",
  "drive-stall",
  "drive-cancel",
] as const;
const delay = z.union([
  z.number(),
  z.enum(["nan", "infinity", "negative-infinity"]),
]);
export const runtimeHooksScript = z
  .object({
    id: z.string(),
    profile: z.enum(["promise", "effect"]),
    case: z.enum(cases),
    ms: delay,
  })
  .strict();
type Script = z.infer<typeof runtimeHooksScript>;
type Model = { n: number; owner: number };
type Msg =
  | { type: "Address"; owner: number }
  | { type: "Ping" }
  | { type: "ProjectCrash" }
  | { type: "Tick" }
  | { type: "Start" }
  | { type: "Advance" }
  | { type: "Cancel" };
type Command = { type: "Next" };
type Pulse = { type: "pulse"; n: number };
type Run = Runtime<Model, Msg, Pulse>;
const comparisonSchema = z
  .object({ trace: z.array(z.string()), state: z.number().int().nonnegative() })
  .strict();
const nativeSchema = z
  .object({
    comparison: comparisonSchema,
    observedRustCalls: z.array(z.string()).nonempty(),
  })
  .strict();
function number(value: Script["ms"]): number {
  return typeof value === "number"
    ? value
    : value === "nan"
      ? Number.NaN
      : value === "infinity"
        ? Number.POSITIVE_INFINITY
        : Number.NEGATIVE_INFINITY;
}
async function pump() {
  for (let i = 0; i < 24; i++)
    await new Promise<void>((resolve) => setImmediate(resolve));
}

export async function executeRuntimeHooks(input: Script) {
  const trace: string[] = [];
  const ms = number(input.ms);
  const timerCase = input.case.startsWith("timer-");
  const savedSet = globalThis.setTimeout,
    savedClear = globalThis.clearTimeout;
  let nextTimer = 0;
  const pending = new Map<unknown, () => void>();
  if (timerCase) {
    Reflect.set(
      globalThis,
      "setTimeout",
      (callback: () => void, delayMs: number, ...args: unknown[]) => {
        if (delayMs === 60_000)
          return Reflect.apply(savedSet, globalThis, [
            callback,
            delayMs,
            ...args,
          ]);
        const token = { hookTimer: ++nextTimer };
        trace.push(`arm:${delayMs}`);
        pending.set(token, () => Reflect.apply(callback, undefined, args));
        return token;
      },
    );
    Reflect.set(globalThis, "clearTimeout", (handle: unknown) => {
      if (
        typeof handle === "object" &&
        handle !== null &&
        "hookTimer" in handle
      ) {
        trace.push("clear");
        pending.delete(handle);
      } else Reflect.apply(savedClear, globalThis, [handle]);
    });
  }
  function machine(label: string) {
    const next = (s: Model, n: number, commands: readonly Command[] = []) =>
      [{ ...s, n }, commands] as const;
    return defineMachine({
      types: {
        model: {} as Model,
        msg: {} as Msg,
        cmd: {} as Command,
        sub: {} as Sub<"source", { label: string }>,
        ctx: undefined,
      },
      init: () => [{ n: 0, owner: 1 }, []],
      update: {
        Address: (s) => next(s, s.n + 1),
        Ping: (s) => next(s, s.n + 1),
        ProjectCrash: (s) => next(s, s.n + 1),
        Tick: (s) => next(s, 1),
        Start: (s) =>
          next(s, 1, input.case === "drive-done" ? [{ type: "Next" }] : []),
        Advance: (s) => next(s, s.n + 1, s.n + 1 < 3 ? [{ type: "Next" }] : []),
        Cancel: (s) => next(s, 9),
      },
      identity:
        input.case === "identity"
          ? {
              ofState: (s: Model) => {
                trace.push("ofState");
                return { owner: s.owner };
              },
              ofMsg: (msg: Msg) => {
                trace.push(`ofMsg:${msg.type}`);
                return msg.type === "Address"
                  ? { owner: msg.owner }
                  : undefined;
              },
            }
          : undefined,
      subs: [
        {
          type: "timer",
          deps: (s) =>
            timerCase && s.n === 0
              ? { ms, msg: { type: "Tick" } as const }
              : null,
        },
        {
          type: "source",
          deps: () => (input.case === "scope-close" ? { label } : null),
        },
      ],
    });
  }
  const scope = await Effect.runPromise(Scope.make());
  async function boot(label: string, hold?: Promise<void>): Promise<Run> {
    const shared = {
      ctx: undefined,
      clock: () => 17.25,
      disposeTimeoutMs: 60_000,
      terminal: (s: Model) => s.n > 0,
      events: (msg: Msg, state: Model): readonly Pulse[] => {
        if (input.case !== "events") return [];
        trace.push(`project:${msg.type}:${state.n}`);
        if (msg.type === "ProjectCrash") throw new Error("projector boom");
        return [{ type: "pulse", n: state.n }];
      },
      telemetry:
        input.case === "events"
          ? (event: { seq: number; msgType: string; at: number }) => {
              trace.push(`telemetry:${event.seq}:${event.msgType}:${event.at}`);
              return event.seq === 2
                ? Promise.reject(new Error("telemetry boom"))
                : undefined;
            }
          : undefined,
      onError: (error: unknown, context: { phase: string }) =>
        trace.push(
          `error:${context.phase}:${error instanceof IdentityDropNotice ? `${error.name}:${error.msgType}:${error.message}` : error instanceof Error ? error.message : String(error)}`,
        ),
    };
    if (input.profile === "promise") {
      const subscribe = {
        source: (sub: Sub<"source", { label: string }>) => {
          const label = sub.deps.label;
          trace.push(`source:${label}:start`);
          return async () => {
            trace.push(`source:${label}:close-start`);
            await hold;
            trace.push(`source:${label}:close-done`);
          };
        },
        ...(input.case === "timer-override"
          ? {
              timer: (
                _sub: unknown,
                _ctx: unknown,
                dispatch: (msg: Msg) => void,
              ) => {
                trace.push("override");
                dispatch({ type: "Tick" });
                return () => {
                  trace.push("override:clear");
                };
              },
            }
          : {}),
      };
      return runPromise(machine(label), {
        ...shared,
        interpret: { Next: async () => ({ type: "Advance" }) as const },
        subscribe,
      }).ready;
    }
    const source = (sub: Sub<"source", { label: string }>) => {
      const label = sub.deps.label;
      trace.push(`source:${label}:start`);
      return Stream.never.pipe(
        Stream.ensuring(
          Effect.promise(async () => {
            trace.push(`source:${label}:close-start`);
            await hold;
            trace.push(`source:${label}:close-done`);
          }),
        ),
      );
    };
    const subscribe = {
      source,
      ...(input.case === "timer-override"
        ? {
            timer: () =>
              Stream.fromEffect(
                Effect.sync(() => {
                  trace.push("override");
                  return { type: "Tick" } as const;
                }),
              ).pipe(
                Stream.ensuring(
                  Effect.sync(() => {
                    trace.push("override:clear");
                  }),
                ),
              ),
          }
        : {}),
    };
    const handle = await Effect.runPromise(
      Scope.provide(scope)(
        runEffect(machine(label), {
          ...shared,
          interpret: {
            Next: () => Effect.succeed({ type: "Advance" } as const),
          },
          subscribe,
        }),
      ),
    );
    const runtime = await Effect.runPromise(handle.ready);
    // This bridge preserves synchronous listeners and the actual enumerable live
    // work symbol. TS exports driveToDone only from promise; these are no claim of
    // an Effect drive export (the paired corpus uses Promise drive cases only).
    const bridge: Run = {
      ...runtime,
      ready: Promise.resolve().then(() => bridge),
      dispatch: (msg, options) =>
        Effect.runPromise(runtime.dispatch(msg, options)),
      dispatchOnce: (msg) => Effect.runPromise(runtime.dispatchOnce(msg)),
      idle: () => Effect.runPromise(runtime.idle()),
      done: () => Effect.runPromise(runtime.done()),
      stop: () => Effect.runPromise(runtime.stop()),
    };
    return bridge;
  }
  let runtime: Run | undefined;
  try {
    runtime = await boot("first");
    switch (input.case) {
      case "identity": {
        runtime.onBoot((s) => trace.push(`boot:${s.n}`));
        const callback = () => trace.push("changed");
        const first = runtime.subscribe(callback),
          duplicate = runtime.subscribe(callback);
        first();
        runtime.subscribe(callback);
        duplicate();
        await runtime.dispatch({ type: "Address", owner: 1 });
        const repeat = runtime.subscribe(callback);
        repeat();
        runtime.subscribe(callback);
        repeat();
        await runtime.dispatch({ type: "Address", owner: 2 });
        await runtime.dispatch({ type: "Ping" });
        break;
      }
      case "ports": {
        const name = `runtime-hooks:${input.id}`,
          port = definePort<number>(name);
        try {
          definePort<string>(name);
          assert.fail("duplicate port name admitted");
        } catch (error) {
          assert(error instanceof PortNameCollisionError);
          trace.push(`collision:${error.name}:${error.message}`);
        }
        const second = await boot("second");
        second.subscribePort(port, (n) => trace.push(`other:${n}`));
        let own: () => void, removed: () => void;
        const current = runtime;
        own = runtime.subscribePort(port, (n) => {
          trace.push(`first:${n}`);
          own();
          removed();
          current.subscribePort(port, (n) => trace.push(`added:${n}`));
        });
        removed = runtime.subscribePort(port, (n) =>
          trace.push(`removed:${n}`),
        );
        runtime.subscribePort(port, (n) => {
          trace.push(`bad:${n}`);
          throw new Error("port boom");
        });
        const same = (n: number) => trace.push(`same:${n}`);
        const stale = runtime.subscribePort(port, same),
          duplicate = runtime.subscribePort(port, same);
        stale();
        runtime.subscribePort(port, same);
        duplicate();
        runtime.emitPort(port, 1);
        runtime.emitPort(port, 2);
        second.emitPort(port, 3);
        const replacement = definePort<number>(
            `runtime-hooks:replacement:${input.id}`,
          ),
          callback = (n: number) => trace.push(`replacement:${n}`);
        const old = runtime.subscribePort(replacement, callback);
        old();
        runtime.subscribePort(replacement, callback);
        old();
        runtime.emitPort(replacement, 4);
        await second.stop();
        break;
      }
      case "events": {
        runtime.subscribe(() => trace.push("changed"));
        runtime.observe((msg, s) => trace.push(`observe:${msg.type}:${s.n}`));
        await runtime.dispatch({ type: "Ping" });
        const first = runtime.on("pulse", (event) => {
          trace.push(`event:first:${event.n}`);
          throw new Error("event boom");
        });
        const cb = (event: Pulse) => trace.push(`event:second:${event.n}`);
        const second = runtime.on("pulse", cb),
          duplicate = runtime.on("pulse", cb);
        await runtime.dispatch({ type: "Ping" });
        await runtime.dispatch({ type: "ProjectCrash" });
        first();
        second();
        duplicate();
        await runtime.dispatch({ type: "Ping" });
        const old = runtime.on("pulse", cb);
        old();
        const replacement = runtime.on("pulse", cb);
        old();
        await runtime.dispatch({ type: "Ping" });
        replacement();
        const keeper = runtime.on("pulse", () => {}),
          stale = runtime.on("pulse", cb),
          other = runtime.on("pulse", cb);
        stale();
        runtime.on("pulse", cb);
        other();
        await runtime.dispatch({ type: "Ping" });
        keeper();
        break;
      }
      case "timer-fire":
      case "timer-stop":
      case "timer-host-cancel":
      case "timer-override": {
        // Stabilize runnable boot follow-ups before installing the controlled-fire
        // observations; this is an explicit fixture barrier on both hosts.
        await pump();
        await runtime.idle();
        runtime.onBoot((s) => trace.push(`boot:${s.n}`));
        runtime.observe((msg, s) => trace.push(`commit:${msg.type}:${s.n}`));
        if (input.case === "timer-fire") {
          await pump();
          if (ms !== Number.POSITIVE_INFINITY || input.profile === "promise") {
            for (let i = 0; i < 4 && runtime.getState().n === 0; i++) {
              const entry = pending.entries().next().value;
              if (entry) {
                pending.delete(entry[0]);
                trace.push("fire");
                entry[1]();
              }
              await pump();
            }
            await runtime.done();
          }
        } else if (input.case === "timer-override") await runtime.idle();
        else if (input.case === "timer-host-cancel") {
          const token = pending.keys().next().value;
          assert.notEqual(token, undefined);
          trace.push("host:cancel");
          Reflect.apply(globalThis.clearTimeout, globalThis, [token]);
          await pump();
        }
        break;
      }
      case "scope-close": {
        assert.equal(input.profile, "effect");
        let release!: () => void;
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        await boot("second", held);
        trace.push("host:close-start");
        let closed = false;
        const closing = Effect.runPromise(Scope.close(scope, Exit.void)).then(
          () => {
            closed = true;
          },
        );
        await pump();
        trace.push(`host:close-pending:${!closed}`);
        release();
        await closing;
        trace.push("host:close-done");
        return comparisonSchema.parse({ trace, state: 0 });
      }
      case "drive-done":
      case "drive-stall":
      case "drive-cancel": {
        assert.equal(
          input.profile,
          "promise",
          "TS owns the drive helper on promise only",
        );
        runtime.observe((msg, s) => trace.push(`commit:${msg.type}:${s.n}`));
        const controller = new AbortController();
        if (input.case === "drive-cancel") controller.abort();
        try {
          const state = await driveToDone(
            runtime,
            { type: "Start" },
            (s) => s.n >= 3,
            input.case === "drive-cancel"
              ? {
                  signal: controller.signal,
                  cancel: () => ({ type: "Cancel" }),
                }
              : {},
          );
          trace.push(`drive:done:${state.n}`);
        } catch (error) {
          assert(error instanceof Error && "state" in error);
          const state = z
            .object({ n: z.number() })
            .passthrough()
            .parse(error.state);
          trace.push(`drive:${error.name}:${state.n}`);
        }
        break;
      }
    }
    await pump();
    const state = runtime.getState().n;
    await runtime.stop();
    return comparisonSchema.parse({ trace, state });
  } finally {
    await runtime?.stop();
    await Effect.runPromise(Scope.close(scope, Exit.void));
    if (timerCase) {
      Reflect.set(globalThis, "setTimeout", savedSet);
      Reflect.set(globalThis, "clearTimeout", savedClear);
    }
  }
}
function command(binary: string, args: string[], input?: string) {
  const child = spawnSync(binary, args, {
    input,
    encoding: "utf8",
    env: process.env,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (child.error) throw child.error;
  if (child.status !== 0)
    throw new Error(
      `${binary} exited ${child.status}\n${child.stdout}\n${child.stderr}`,
    );
  return child.stdout;
}
function scripts() {
  const output: { id: string; script: Script }[] = [];
  for (const profile of ["promise", "effect"] as const) {
    for (const kind of cases) {
      if (kind === "scope-close" && profile !== "effect") continue;
      if (kind.startsWith("drive-") && profile !== "promise") continue;
      const id = `runtime-hooks.${profile}.${kind}`;
      output.push({ id, script: { id, profile, case: kind, ms: 17.25 } });
    }
    for (const ms of [
      0,
      -1,
      "nan",
      "infinity",
      "negative-infinity",
      0.0000001,
      2147483649.5,
      4503599627.370497,
      4503599627.370499,
      4503599627.370501,
    ] as const) {
      const id = `runtime-hooks.${profile}.timer-fire.${ms}`;
      output.push({ id, script: { id, profile, case: "timer-fire", ms } });
    }
  }
  return output;
}
function digest(file: string) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}
function controls(
  corpus: ReturnType<typeof scripts>,
  expected: z.infer<typeof comparisonSchema>[],
) {
  const specifications = [
    {
      id: "identity-filter-bypass",
      file: "crates/tea/src/runtime/engine.rs",
      needle: "identity.misaddressed(&state, &message)",
      replacement: "false && identity.misaddressed(&state, &message)",
    },
    {
      id: "scope-stop-not-awaited",
      file: "crates/tea/src/runtime/scope.rs",
      needle: "(member.stop)().await;",
      replacement: "tokio::task::spawn_local((member.stop)());",
    },
  ];
  const receipts = [];
  const cargo = process.env.CARGO ?? "cargo";
  for (const specification of specifications) {
    const temporary = mkdtempSync(
      join(tmpdir(), "demlik-runtime-hooks-control-"),
    );
    const activeHash = digest(specification.file);
    try {
      for (const file of ["Cargo.toml", "Cargo.lock"])
        cpSync(file, join(temporary, file));
      cpSync("crates", join(temporary, "crates"), {
        recursive: true,
        filter: (file) =>
          !file
            .split(sep)
            .some((part) => ["target", "node_modules", ".git"].includes(part)),
      });
      if (existsSync(".cargo"))
        cpSync(".cargo", join(temporary, ".cargo"), { recursive: true });
      const source = join(temporary, specification.file),
        original = readFileSync(source, "utf8");
      assert.equal(digest(source), activeHash);
      assert.equal(
        original.split(specification.needle).length,
        2,
        "unique source control target",
      );
      writeFileSync(
        source,
        original.replace(specification.needle, specification.replacement),
      );
      const mutantHash = digest(source);
      const build = spawnSync(
        cargo,
        [
          "build",
          "--locked",
          "-p",
          "demlik-tea",
          "--example",
          "runtime_hooks_driver",
        ],
        {
          cwd: temporary,
          encoding: "utf8",
          env: {
            ...process.env,
            CARGO_NET_OFFLINE: "true",
            CARGO_TARGET_DIR: join(temporary, "target"),
          },
          maxBuffer: 64 * 1024 * 1024,
        },
      );
      if (build.error) throw build.error;
      assert.equal(build.status, 0, build.stdout + build.stderr);
      const binary = join(
          temporary,
          "target/debug/examples/runtime_hooks_driver",
        ),
        actual = command(
          binary,
          [],
          `${corpus.map((item) => JSON.stringify(item.script)).join("\n")}\n`,
        )
          .trim()
          .split("\n")
          .map((line) => nativeSchema.parse(JSON.parse(line)));
      assert.equal(actual.length, corpus.length);
      const detectedIds = corpus
        .filter((_, index) => {
          try {
            assert.deepEqual(actual[index].comparison, expected[index]);
            return false;
          } catch {
            return true;
          }
        })
        .map((item) => item.id);
      assert(detectedIds.length > 0, `${specification.id} must be observed`);
      assert.equal(
        digest(specification.file),
        activeHash,
        "active source untouched",
      );
      receipts.push({
        id: specification.id,
        isolation: "disposable-source-copy",
        activeSourceUnchanged: true,
        sourceBeforeSha256: activeHash,
        mutantSourceSha256: mutantHash,
        nativeBinarySha256: digest(binary),
        detectedIds,
      });
    } finally {
      rmSync(temporary, { recursive: true, force: true });
      assert.equal(
        digest(specification.file),
        activeHash,
        "control did not edit active source",
      );
    }
  }
  return receipts;
}
export async function verifyRuntimeHooks(
  reportPath = "target/parity/runtime-hooks.json",
  binaryOverride?: string,
  mutationCheck = false,
) {
  const cargo = process.env.CARGO ?? "cargo",
    rustc =
      process.env.RUSTC ??
      (isAbsolute(cargo) ? join(dirname(cargo), "rustc") : "rustc");
  if (!binaryOverride)
    command(cargo, [
      "build",
      "--locked",
      "-p",
      "demlik-tea",
      "--example",
      "runtime_hooks_driver",
    ]);
  const binary =
    binaryOverride ??
    join(
      process.env.CARGO_TARGET_DIR
        ? resolve(process.env.CARGO_TARGET_DIR)
        : "target",
      "debug",
      "examples",
      "runtime_hooks_driver",
    );
  const corpus = scripts();
  const native = command(
    binary,
    [],
    `${corpus.map((item) => JSON.stringify(item.script)).join("\n")}\n`,
  )
    .trim()
    .split("\n")
    .map((line) => nativeSchema.parse(JSON.parse(line)));
  assert.equal(native.length, corpus.length);
  const expectedCases = [];
  const evidence = [];
  for (let index = 0; index < corpus.length; index++) {
    const item = corpus[index],
      expected = await executeRuntimeHooks(item.script);
    const actual = native[index];
    expectedCases.push(expected);
    try {
      assert.deepEqual(actual.comparison, expected);
    } catch (error) {
      mkdirSync(dirname(reportPath), { recursive: true });
      writeFileSync(
        reportPath,
        JSON.stringify(
          {
            failed: item.id,
            script: item.script,
            native: actual,
            typescript: expected,
          },
          null,
          2,
        ),
      );
      throw error;
    }
    evidence.push({
      id: item.id,
      script: item.script,
      comparison: actual.comparison,
      observedRustCalls: actual.observedRustCalls,
      functions: [...new Set(actual.observedRustCalls)].sort(),
    });
  }
  const report = {
    runtime: {
      node: process.version,
      v8: process.versions.v8,
      rustc: command(rustc, ["--version"]).trim(),
    },
    binary: {
      path: binary,
      sha256: createHash("sha256").update(readFileSync(binary)).digest("hex"),
    },
    compared: corpus.length,
    controls: mutationCheck ? controls(corpus, expectedCases) : [],
    cases: evidence,
  };
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const parsed = parseArgs({
    options: {
      report: { type: "string" },
      "native-binary": { type: "string" },
      "mutation-check": { type: "boolean", default: false },
    },
    strict: true,
  });
  const result = await verifyRuntimeHooks(
    parsed.values.report,
    parsed.values["native-binary"],
    parsed.values["mutation-check"],
  );
  console.log(
    JSON.stringify({
      compared: result.compared,
      controls: result.controls.map((control) => ({
        id: control.id,
        detected: control.detectedIds.length,
      })),
      report: parsed.values.report ?? "target/parity/runtime-hooks.json",
    }),
  );
}
