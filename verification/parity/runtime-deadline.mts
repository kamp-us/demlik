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
import { defineMachine, type TimerDeps } from "../../packages/tea/src/index.js";
import { run as runPromise } from "../../packages/tea/src/promise/index.js";
import {
  type DeadlineExceeded,
  deadlineExceeded,
  deadlineSub,
  nextTimer,
} from "../../packages/tea/src/resilience/index.js";
export const runtimeDeadlineScript = z
  .object({
    profile: z.enum(["promise", "effect"]),
    action: z.enum(["fire", "stop", "override"]),
  })
  .strict();
type Script = z.infer<typeof runtimeDeadlineScript>;
type Model = { delivered: DeadlineExceeded | null };
const comparisonSchema = z
  .object({
    readyError: z.string().nullable(),
    trace: z.array(z.string()),
    delivered: z
      .object({
        type: z.literal("deadline_exceeded"),
        id: z.string(),
        atMs: z.number(),
      })
      .strict()
      .nullable(),
    pending: z.boolean(),
  })
  .strict();
const responseSchema = z
  .object({
    comparison: comparisonSchema,
    observedRustCalls: z.array(z.string()).nonempty(),
  })
  .strict();
async function pump() {
  for (let i = 0; i < 16; i++)
    await new Promise<void>((resolve) => setImmediate(resolve));
}
export async function executeRuntimeDeadline(input: Script) {
  const trace: string[] = [];
  let pending: (() => void) | undefined;
  const token = { deadlineTimer: true };
  const originalSet = globalThis.setTimeout,
    originalClear = globalThis.clearTimeout;
  Reflect.set(
    globalThis,
    "setTimeout",
    (callback: () => void, ms: number, ...args: unknown[]) => {
      if (ms !== 30.25)
        return Reflect.apply(originalSet, globalThis, [callback, ms, ...args]);
      trace.push(`arm:${ms}`);
      pending = () => Reflect.apply(callback, undefined, args);
      return token;
    },
  );
  Reflect.set(globalThis, "clearTimeout", (handle: unknown) => {
    if (handle === token) {
      trace.push("clear");
      pending = undefined;
    } else Reflect.apply(originalClear, globalThis, [handle]);
  });
  const machine = defineMachine({
    types: { model: {} as Model, msg: {} as DeadlineExceeded, ctx: undefined },
    init: () => [{ delivered: null }, []],
    update: { deadline_exceeded: (_s, msg) => [{ delivered: msg }, []] },
    subs: [
      {
        type: "timer",
        deps: (s) =>
          s.delivered === null
            ? nextTimer([deadlineSub("watch", 130.5)], 100.25)
            : null,
      },
    ],
  });
  const scope = await Effect.runPromise(Scope.make());
  let stop: (() => Promise<void>) | undefined;
  try {
    let getState: () => Model,
      idle: () => Promise<void>,
      done: () => Promise<Model>;
    if (input.profile === "promise") {
      const subscribe =
        input.action === "override"
          ? {
              timer: (
                _sub: { deps: TimerDeps<DeadlineExceeded> },
                _ctx: unknown,
                dispatch: (msg: DeadlineExceeded) => void,
              ) => {
                trace.push("override");
                dispatch(deadlineExceeded("override", 200.5));
                return () => {
                  trace.push("override:clear");
                };
              },
            }
          : {};
      const runtime = await runPromise(machine, {
        ctx: undefined,
        subscribe,
        terminal: (s) => s.delivered !== null,
        disposeTimeoutMs: 60_000,
      }).ready;
      getState = runtime.getState;
      idle = runtime.idle;
      done = runtime.done;
      stop = runtime.stop;
    } else {
      const subscribe =
        input.action === "override"
          ? {
              timer: () =>
                Stream.fromEffect(
                  Effect.sync(() => {
                    trace.push("override");
                    return deadlineExceeded("override", 200.5);
                  }),
                ).pipe(
                  Stream.ensuring(
                    Effect.sync(() => {
                      trace.push("override:clear");
                    }),
                  ),
                ),
            }
          : {};
      const handle = await Effect.runPromise(
        Scope.provide(scope)(
          runEffect(machine, {
            ctx: undefined,
            subscribe,
            terminal: (s) => s.delivered !== null,
            disposeTimeoutMs: 60_000,
          }),
        ),
      );
      const runtime = await Effect.runPromise(handle.ready);
      getState = runtime.getState;
      idle = () => Effect.runPromise(runtime.idle());
      done = () => Effect.runPromise(runtime.done());
      stop = () => Effect.runPromise(runtime.stop());
    }
    await pump();
    await idle();
    if (input.action === "fire") {
      trace.push("fire");
      assert(pending);
      const callback = pending;
      pending = undefined;
      callback();
      await done();
    }
    await stop();
    await pump();
    return comparisonSchema.parse({
      readyError: null,
      trace,
      delivered: getState().delivered,
      pending: pending !== undefined,
    });
  } finally {
    await stop?.();
    await Effect.runPromise(Scope.close(scope, Exit.void));
    Reflect.set(globalThis, "setTimeout", originalSet);
    Reflect.set(globalThis, "clearTimeout", originalClear);
  }
}
function command(
  binary: string,
  args: string[],
  input?: string,
  cwd = process.cwd(),
  env = process.env,
) {
  const result = spawnSync(binary, args, {
    cwd,
    env,
    input,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `${binary} exited ${result.status}\n${result.stdout}\n${result.stderr}`,
    );
  return result.stdout;
}
function binary(cwd = process.cwd(), target = process.env.CARGO_TARGET_DIR) {
  return join(
    target ? resolve(cwd, target) : join(cwd, "target"),
    "debug/examples/runtime_deadline_driver",
  );
}
function build(cwd = process.cwd(), target?: string) {
  command(
    process.env.CARGO ?? "cargo",
    [
      "build",
      "--locked",
      "-p",
      "demlik-tea",
      "--example",
      "runtime_deadline_driver",
    ],
    undefined,
    cwd,
    {
      ...process.env,
      CARGO_NET_OFFLINE: "true",
      ...(target ? { CARGO_TARGET_DIR: target } : {}),
    },
  );
}
function native(scripts: Script[], executable: string) {
  return command(
    executable,
    [],
    `${scripts.map((script) => JSON.stringify(script)).join("\n")}\n`,
  )
    .trim()
    .split("\n")
    .map((line) => responseSchema.parse(JSON.parse(line)));
}
function digest(file: string) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}
function control(
  corpus: { id: string; script: Script }[],
  expected: z.infer<typeof comparisonSchema>[],
) {
  const temporary = mkdtempSync(
      join(tmpdir(), "demlik-deadline-type-control-"),
    ),
    file = "crates/tea/src/resilience/deadline.rs",
    before = digest(file);
  try {
    for (const root of ["Cargo.toml", "Cargo.lock"])
      cpSync(root, join(temporary, root));
    cpSync("crates", join(temporary, "crates"), {
      recursive: true,
      filter: (file) =>
        !file
          .split(sep)
          .some((part) => ["target", "node_modules", ".git"].includes(part)),
    });
    if (existsSync(".cargo"))
      cpSync(".cargo", join(temporary, ".cargo"), { recursive: true });
    const source = join(temporary, file),
      text = readFileSync(source, "utf8"),
      needle = "pub use crate::TimerDeps;";
    assert.equal(digest(source), before);
    assert.equal(text.split(needle).length, 2);
    writeFileSync(
      source,
      text.replace(
        needle,
        "#[derive(Debug, Deserialize, Serialize)]\npub struct TimerDeps<M> { pub ms: f64, pub msg: M }",
      ),
    );
    const target = join(temporary, "target");
    build(temporary, target);
    const executable = binary(temporary, target),
      mutated = native(
        corpus.map((item) => item.script),
        executable,
      );
    assert.equal(mutated.length, corpus.length);
    const detectedIds = corpus
      .filter((_, index) => {
        try {
          assert.deepEqual(mutated[index].comparison, expected[index]);
          return false;
        } catch {
          return true;
        }
      })
      .map((item) => item.id);
    assert.equal(
      detectedIds.length,
      4,
      "both default-runner operations in both profiles detect the foreign timer data type",
    );
    assert.equal(digest(file), before);
    return {
      id: "separate-deadline-timer-type",
      isolation: "disposable-source-copy",
      activeSourceUnchanged: true,
      sourceBeforeSha256: before,
      mutantSourceSha256: digest(source),
      nativeBinarySha256: digest(executable),
      detectedIds,
    };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
    assert.equal(digest(file), before);
  }
}
export async function verifyRuntimeDeadline(
  reportPath = "target/parity/runtime-deadline.json",
  binaryOverride?: string,
  mutationCheck = false,
) {
  if (!binaryOverride) build();
  const executable = binaryOverride ?? binary();
  const corpus = [];
  for (const profile of ["promise", "effect"] as const)
    for (const action of ["fire", "stop", "override"] as const)
      corpus.push({
        id: `runtime-deadline.${profile}.${action}`,
        script: { profile, action },
      });
  const results = native(
    corpus.map((item) => item.script),
    executable,
  );
  assert.equal(results.length, corpus.length);
  const expected = [];
  const failures: {
    id: string;
    reference: unknown;
    native: unknown;
    message: string;
  }[] = [];
  for (let index = 0; index < corpus.length; index++) {
    const reference = await executeRuntimeDeadline(corpus[index].script);
    expected.push(reference);
    try {
      assert.deepEqual(results[index].comparison, reference, corpus[index].id);
    } catch (error) {
      failures.push({
        id: corpus[index].id,
        reference,
        native: results[index].comparison,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const cargo = process.env.CARGO ?? "cargo",
    rustc =
      process.env.RUSTC ??
      (isAbsolute(cargo) ? join(dirname(cargo), "rustc") : "rustc");
  const report = {
    runtime: {
      node: process.version,
      v8: process.versions.v8,
      rustc: command(rustc, ["--version"]).trim(),
    },
    binary: { path: executable, sha256: digest(executable) },
    compared: corpus.length,
    passed: corpus.length - failures.length,
    failures,
    controls:
      mutationCheck && !failures.length ? [control(corpus, expected)] : [],
    cases: corpus.map((item, index) => ({
      ...item,
      ...results[index],
      equal: !failures.some((failure) => failure.id === item.id),
      functions: [...new Set(results[index].observedRustCalls)].sort(),
    })),
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
  const report = await verifyRuntimeDeadline(
    parsed.values.report,
    parsed.values["native-binary"],
    parsed.values["mutation-check"],
  );
  console.log(
    JSON.stringify({
      compared: report.compared,
      passed: report.passed,
      failures: report.failures,
      controls: report.controls.map((item) => ({
        id: item.id,
        detected: item.detectedIds.length,
      })),
      report: parsed.values.report ?? "target/parity/runtime-deadline.json",
    }),
  );
  if (report.failures.length) process.exitCode = 1;
}
