import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { Effect, Exit, Scope } from "effect";
import { z } from "zod";
import { run as runEffect } from "../../packages/tea/src/effect/index.ts";
import {
  createLlmCall,
  type LlmFailMsg,
  type LlmRunCmd,
  type LlmSucceedMsg,
} from "../../packages/tea/src/internal/llm-call/index.ts";
import type { DeadlineExceeded } from "../../packages/tea/src/internal/resilience/deadline/index.ts";
import { run as runPromise } from "../../packages/tea/src/promise/index.ts";
import type { Machine, Sub } from "../../packages/tea/src/pure/core.ts";
import { normalize, numeric } from "./timing-clock.mts";

const encodedNumber = z.union([
  z.number(),
  z
    .object({ $number: z.enum(["NaN", "Infinity", "-Infinity", "-0"]) })
    .strict(),
]);
const input = z
  .object({
    id: z.string(),
    profile: z.enum(["promise", "effect"]),
    mode: z.enum(["success", "failure", "retry"]),
    at: encodedNumber,
  })
  .strict();
type Input = z.infer<typeof input>;
type Settlement = LlmFailMsg<"plan"> | LlmSucceedMsg<"plan", { plan: unknown }>;
type Msg = Settlement | DeadlineExceeded;
export async function reference(test: Input) {
  const at = numeric.parse(test.at);
  const knob = createLlmCall<"plan", { plan: unknown }>(
    {
      schemas: { plan: { parse: (raw) => raw } },
      ...(test.mode === "retry"
        ? {
            retry: {
              baseMs: 1,
              factor: 2,
              capMs: 4,
              jitter: "none",
              maxAttempts: 2,
            },
          }
        : {}),
    },
    () => 0.5,
  );
  type S = {
    resilience: ReturnType<typeof knob.init>;
    rows: unknown[];
    wireStrings: string[];
    done: boolean;
  };
  const update = (
    state: S,
    msg: Msg,
  ): readonly [S, readonly LlmRunCmd<"plan">[]] => {
    const rows = [...state.rows];
    const wireStrings = [...state.wireStrings];
    let result: ReturnType<typeof knob.succeed>;
    if (msg.type === "deadline_exceeded") {
      rows.push({ kind: "timer", msg });
      result = knob.onTimer(state.resilience, msg);
    } else {
      const encoded = JSON.stringify(msg);
      wireStrings.push(encoded);
      const wire: unknown = JSON.parse(encoded);
      z.object({
        type: z.enum(["resilient_run_ok", "resilient_run_err"]),
        cmd: z.object({
          key: z.string(),
          input: z.object({ purpose: z.literal("plan") }),
        }),
        at: z.number().nullable(),
      }).parse(wire);
      // JSON null is a real persisted numeric stamp, outside TS's number annotation.
      // Reflect keeps that intentional boundary visible without normalizing it.
      const holder = { msg };
      Reflect.set(holder, "msg", wire);
      const restored = holder.msg;
      rows.push({
        kind: "settlement",
        original: msg.at,
        wire,
        restored: restored.at,
      });
      result =
        "value" in restored
          ? knob.succeed(state.resilience, restored)
          : knob.fail(state.resilience, restored);
    }
    const [resilience, cmds] = result;
    rows.push({ kind: "state", clock: resilience.clockMs, state: resilience });
    const phase = resilience.calls.plan?.phase;
    return [
      {
        resilience,
        rows,
        wireStrings,
        done: phase === "succeeded" || phase === "failed",
      },
      cmds,
    ];
  };
  const machine: Machine<S, Msg, LlmRunCmd<"plan">, Sub<never>, undefined> = {
    cmds: [knob.run],
    init: () => {
      const [resilience, cmds] = knob.attempt(
        knob.init(),
        { purpose: "plan", model: null, payload: "prompt" },
        0,
      );
      return [{ resilience, rows: [], wireStrings: [], done: false }, cmds];
    },
    update: {
      resilient_run_ok: update,
      resilient_run_err: update,
      deadline_exceeded: update,
    },
  };
  let providerCalls = 0;
  const handle = (cmd: LlmRunCmd<"plan">) => {
    const n = providerCalls++;
    return test.mode === "failure" || (test.mode === "retry" && n === 0)
      ? knob.rejected("provider error")
      : knob.decode(cmd, "parsed");
  };
  const shared = {
    ctx: undefined,
    clock: () => at,
    terminal: (state: S) => state.done,
  };
  let declaredTimer: unknown = null,
    final: S;
  if (test.profile === "promise") {
    const h = runPromise(machine, {
      ...shared,
      interpret: { resilient_run: async (cmd) => handle(cmd) },
    });
    const r = await h.ready;
    await r.idle();
    if (test.mode === "retry") {
      const timer = knob.timer(r.getState().resilience);
      assert(timer);
      declaredTimer = timer;
      await r.dispatch(timer.msg);
    }
    final = await r.done();
    await r.stop();
  } else {
    const scope = await Effect.runPromise(Scope.make());
    const h = await Effect.runPromise(
      Scope.provide(scope)(
        runEffect(machine, {
          ...shared,
          interpret: {
            resilient_run: (cmd) =>
              Effect.flatMap(
                Effect.sync(() => handle(cmd)),
                (outcome) =>
                  outcome._tag === "Ok"
                    ? Effect.succeed(outcome.value)
                    : Effect.fail(outcome.error),
              ),
          },
        }),
      ),
    );
    const r = await Effect.runPromise(h.ready);
    await Effect.runPromise(r.idle());
    if (test.mode === "retry") {
      const timer = knob.timer(r.getState().resilience);
      assert(timer);
      declaredTimer = timer;
      await Effect.runPromise(r.dispatch(timer.msg));
    }
    final = await Effect.runPromise(r.done());
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }
  return {
    value: normalize({
      rows: final.rows,
      declaredTimer,
      providerCalls,
      done: final.done,
    }),
    wireStrings: final.wireStrings,
  };
}
export function cases() {
  const cases: Input[] = [];
  const clocks: z.infer<typeof encodedNumber>[] = [
    17.25,
    0,
    { $number: "-0" },
    { $number: "NaN" },
    { $number: "Infinity" },
    { $number: "-Infinity" },
  ];
  for (const profile of ["promise", "effect"]) {
    for (const mode of ["success", "failure", "retry"]) {
      for (let n = 0; n < clocks.length; n++)
        cases.push(
          input.parse({
            id: `timestamp.${profile}.${mode}.${n}`,
            profile,
            mode,
            at: clocks[n],
          }),
        );
    }
  }
  return cases;
}
export async function timestampParity(
  options: { binary?: string; reportFile?: string; cargo?: string } = {},
) {
  assert.equal(process.version, "v22.21.1");
  assert.equal(process.versions.v8, "12.4.254.21-node.33");
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
    target = process.env.CARGO_TARGET_DIR ?? join(root, "target"),
    binary =
      options.binary ?? join(target, "debug/examples/timestamp_runtime_driver");
  if (!options.binary) {
    const build = spawnSync(
      options.cargo ?? process.env.CARGO ?? "cargo",
      [
        "build",
        "--locked",
        "-p",
        "demlik-tea",
        "--example",
        "timestamp_runtime_driver",
      ],
      {
        cwd: root,
        stdio: "inherit",
        env: {
          ...process.env,
          CARGO_PROFILE_DEV_DEBUG: "0",
          CARGO_PROFILE_TEST_DEBUG: "0",
          CARGO_INCREMENTAL: "0",
          CARGO_BUILD_JOBS: "1",
        },
      },
    );
    assert.equal(build.status, 0);
  }
  const tests = cases();
  const run = spawnSync(binary, [], {
    cwd: root,
    input: `${tests.map((test) => JSON.stringify(test)).join("\n")}\n`,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(run.status, 0, run.stderr);
  const native = run.stdout
    .trim()
    .split("\n")
    .map((line) =>
      z
        .object({
          id: z.string(),
          output: z.object({
            value: z.unknown(),
            calls: z.array(z.string()),
            wireStrings: z.array(z.string()),
          }),
        })
        .parse(JSON.parse(line)),
    );
  assert.equal(native.length, tests.length);
  const results = [];
  for (let n = 0; n < tests.length; n++) {
    const test = tests[n],
      source = await reference(test);
    assert.equal(native[n].id, test.id);
    let equal = true;
    try {
      assert.deepEqual(native[n].output.value, source.value);
    } catch {
      equal = false;
    }
    results.push({
      id: test.id,
      equal,
      input: test,
      reference: source.value,
      native: native[n].output.value,
      observedCalls: native[n].output.calls,
      wireStrings: {
        reference: source.wireStrings,
        native: native[n].output.wireStrings,
      },
    });
  }
  const sourceFiles = [
    "packages/tea/src/internal/llm-call/index.ts",
    "packages/tea/src/internal/resilience/resilient-call/index.ts",
    "packages/tea/src/pure/core.ts",
    "crates/tea/src/data/number.rs",
    "crates/tea/src/command.rs",
    "crates/tea/examples/timestamp_runtime/consumer.rs",
    "crates/tea/examples/timestamp_runtime_driver.rs",
    "verification/parity/timestamps.mts",
  ];
  const hash = (path: string) =>
    createHash("sha256").update(readFileSync(path)).digest("hex");
  const report = {
    version: 1,
    scope:
      "numeric command stamps persisted and decoded before actual LlmCall transitions",
    passed: results.filter((r) => r.equal).length,
    total: results.length,
    failures: results.filter((r) => !r.equal),
    results,
    sourceHashes: Object.fromEntries(
      sourceFiles.map((path) => [path, hash(join(root, path))]),
    ),
    binaryHash: hash(binary),
    qualifications: [
      "The host explicitly dispatches the public retry timer declaration after idle; this is not a new scheduler or a timing-order equivalence claim.",
      "Parsed JSON records, stamp presence/value and transition order are compared; raw wire strings are retained separately. Unrelated error-field key insertion order is not asserted.",
      "Payloads in this persistence consumer use PlainData codecs at the message boundary. The separate opaque runtime consumer remains free of blanket codec/Clone/Send bounds.",
      "Manually missing or nonnumeric raw stamps are outside Source's public clock:number type and remain explicitly outside this numeric/persistence profile.",
    ],
  };
  const reportFile =
    options.reportFile ?? join(root, "target/parity/timestamps.json");
  mkdirSync(dirname(reportFile), { recursive: true });
  writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const { values } = parseArgs({
    options: { binary: { type: "string" }, report: { type: "string" } },
  });
  const report = await timestampParity({
    binary: values.binary,
    reportFile: values.report,
  });
  console.log(JSON.stringify({ passed: report.passed, total: report.total }));
  if (report.failures.length) process.exitCode = 1;
}
