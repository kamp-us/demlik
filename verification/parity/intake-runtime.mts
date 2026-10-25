import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { Effect, Exit, Scope } from "effect";
import { z } from "zod";
import { run as runEffect } from "../../packages/tea/src/effect/index.js";
import {
  createIntake,
  type IntakeCmd,
  type IntakeState,
  intakeProcessDef,
  intakeReplayDef,
} from "../../packages/tea/src/idempotency/index.js";
import {
  type Cmd,
  type Machine,
  Outcome,
  type Settled,
  type Store,
  type Sub,
} from "../../packages/tea/src/index.js";
import { run as runPromise } from "../../packages/tea/src/promise/index.js";
import { normalize } from "./timing-clock.mts";

type Hook = { key: string; amount: number };
type Receipt = { chargedCents: number };
type Model = { intake: IntakeState<Hook, Receipt> };
const processDef = intakeProcessDef<Hook>(),
  replayDef = intakeReplayDef<Receipt>();
type Notification = Settled<typeof processDef> | Settled<typeof replayDef>;
type Msg =
  | { type: "receive"; payload: Hook; at: number; id: string }
  | { type: "claim"; at: number }
  | { type: "complete"; key: string; result: Receipt; at: number }
  | { type: "boot" }
  | Notification;
interface Work extends Cmd<"intake:work"> {
  readonly key: string;
  readonly payload: Hook;
}
type Command = IntakeCmd<Hook, Receipt> | Work;
type Ctx = { queue(msg: Msg): void; capability(): number };
export const intakeRuntimeScript = z
  .object({
    profile: z.enum(["promise", "effect"]),
    mode: z.enum(["slow", "done", "unfinished"]),
    persistence: z.enum(["bytes", "retained"]),
  })
  .strict();
type Script = z.infer<typeof intakeRuntimeScript>;
const durableModel = z.object({
  intake: z.object({
    seen: z.object({
      entries: z.record(
        z.string(),
        z.object({
          value: z.discriminatedUnion("phase", [
            z.object({ phase: z.literal("pending") }),
            z.object({
              phase: z.literal("done"),
              result: z.object({ chargedCents: z.number() }).optional(),
            }),
          ]),
          atMs: z.number().nullable(),
        }),
      ),
      order: z.array(z.string()),
    }),
    queue: z.array(
      z.object({
        id: z.string(),
        status: z.enum(["pending", "running"]),
        input: z.object({ key: z.string(), amount: z.number() }),
        enqueuedAt: z.number().nullable(),
        startedAt: z.number().nullable().optional(),
      }),
    ),
  }),
});
function wire(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}
export async function executeIntakeRuntime(raw: unknown) {
  const input = intakeRuntimeScript.parse(raw);
  const trace: unknown[] = [],
    snapshots: unknown[] = [];
  let saved: string | Model | null = null,
    workers = 0,
    processes = 0,
    replays = 0,
    finish = input.mode === "done";
  const intake = createIntake<Hook, Receipt>({
    keyOf: (p) => p.key,
    ttlMs: 1000,
  });
  const savedState = () =>
    saved === null
      ? null
      : typeof saved === "string"
        ? JSON.parse(saved)
        : wire(saved);
  const store: Store<Model> = {
    async load() {
      trace.push({ kind: "load", state: savedState() });
      return saved;
    },
    async save(state) {
      trace.push({ kind: "save", state: wire(state) });
      saved = input.persistence === "bytes" ? JSON.stringify(state) : state;
    },
    migrate(raw) {
      if (raw === null || raw === undefined) return null;
      const value: unknown = typeof raw === "string" ? JSON.parse(raw) : raw;
      durableModel.parse(value);
      const holder: { model: Model | null } = { model: null };
      Reflect.set(holder, "model", value);
      return holder.model;
    },
  };
  const pass = (state: Model): readonly [Model, readonly Command[]] => [
    state,
    [],
  ];
  const machine: Machine<Model, Msg, Command, Sub<never>, Ctx> = {
    cmds: [processDef, replayDef],
    init: (loaded) => [loaded ?? { intake: intake.init() }, []],
    update: {
      receive: (state, msg) => {
        const [next, cmds] = intake.receive(
          state.intake,
          msg.payload,
          msg.at,
          msg.id,
        );
        return [{ intake: next }, cmds];
      },
      complete: (state, msg) => {
        const [next, cmds] = intake.complete(
          state.intake,
          msg.key,
          msg.result,
          msg.at,
        );
        return [{ intake: next }, cmds];
      },
      boot: (state) => {
        const [next, cmds] = intake.boot(state.intake);
        return [{ intake: next }, cmds];
      },
      claim: (state, msg) => {
        const claim = intake.claimNext(state.intake, msg.at);
        return claim
          ? [
              { intake: claim.state },
              [
                {
                  type: "intake:work",
                  key: claim.claimed.input.key,
                  payload: claim.claimed.input,
                },
              ],
            ]
          : [state, []];
      },
      "intake:process_ok": pass,
      "intake:process_err": pass,
      "intake:replay_ok": pass,
      "intake:replay_err": pass,
    },
  };
  for (let life = 0; life < 2; life++) {
    let enqueue: (msg: Msg) => void = () => {
      throw Error("runtime not ready");
    };
    const ctx: Ctx = { queue: (msg) => enqueue(msg), capability: () => 100 };
    const shared = { ctx, store, clock: () => 123.25 };
    const committed = (msg: Msg | null, state: Model) =>
      trace.push({ kind: "commit", msg: normalize(msg), state: wire(state) });
    const process = (command: ReturnType<typeof processDef>, context: Ctx) => {
      trace.push({ kind: "handler", command: normalize(command) });
      processes++;
      if (input.mode !== "slow") context.queue({ type: "claim", at: 1 });
    };
    const replay = (command: ReturnType<typeof replayDef>) => {
      trace.push({ kind: "handler", command: normalize(command) });
      replays++;
    };
    const work = (command: Work, context: Ctx): Msg | undefined => {
      trace.push({ kind: "handler", command: normalize(command) });
      workers++;
      return finish
        ? {
            type: "complete",
            key: command.key,
            result: {
              chargedCents: command.payload.amount * context.capability(),
            },
            at: 10,
          }
        : undefined;
    };
    let dispatch: (msg: Msg) => Promise<unknown>,
      idle: () => Promise<unknown>,
      getState: () => Model,
      stop: () => Promise<unknown>;
    if (input.profile === "promise") {
      const handle = runPromise(machine, {
        ...shared,
        interpret: {
          "intake:process": async (command, context) => {
            process(command, context);
            return Outcome.ok(undefined);
          },
          "intake:replay": async (command) => {
            replay(command);
            return Outcome.ok(undefined);
          },
          "intake:work": async (command, context) => work(command, context),
        },
      });
      handle.onBoot((state) => committed(null, state));
      handle.observe(committed);
      const runtime = await handle.ready;
      dispatch = (msg) => runtime.dispatch(msg);
      idle = () => runtime.idle();
      getState = runtime.getState;
      stop = () => runtime.stop();
    } else {
      const scope = await Effect.runPromise(Scope.make());
      const handle = await Effect.runPromise(
        Scope.provide(scope)(
          runEffect(machine, {
            ...shared,
            interpret: {
              "intake:process": (command) =>
                Effect.sync(() => {
                  process(command, ctx);
                  return undefined;
                }),
              "intake:replay": (command) =>
                Effect.sync(() => {
                  replay(command);
                  return undefined;
                }),
              "intake:work": (command) => Effect.sync(() => work(command, ctx)),
            },
          }),
        ),
      );
      handle.onBoot((state) => committed(null, state));
      handle.observe(committed);
      const runtime = await Effect.runPromise(handle.ready);
      dispatch = (msg) => Effect.runPromise(runtime.dispatch(msg));
      idle = () => Effect.runPromise(runtime.idle());
      getState = runtime.getState;
      stop = () => Effect.runPromise(Scope.close(scope, Exit.void));
    }
    enqueue = (msg) => {
      void dispatch(msg);
    };
    if (life === 0) {
      await dispatch({
        type: "receive",
        payload: { key: "evt_1", amount: 5 },
        at: 0,
        id: "q1",
      });
      await idle();
      if (input.mode === "slow") {
        await dispatch({
          type: "receive",
          payload: { key: "evt_1", amount: 5 },
          at: 2000,
          id: "q2",
        });
        await idle();
      }
    } else {
      finish = true;
      await dispatch({ type: "boot" });
      await dispatch({ type: "claim", at: 100 });
      await idle();
      await dispatch({
        type: "receive",
        payload: { key: "evt_1", amount: 5 },
        at: 101,
        id: "duplicate",
      });
      await idle();
    }
    snapshots.push({
      life,
      state: wire(getState()),
      saved: savedState(),
      workers,
      processes,
      replays,
    });
    await stop();
  }
  return normalize({ snapshots, trace });
}
export function intakeRuntimeCases() {
  const cases: {
    id: string;
    profile: Script["profile"];
    mode: Script["mode"];
    persistence: Script["persistence"];
  }[] = [];
  const profiles: Script["profile"][] = ["promise", "effect"],
    modes: Script["mode"][] = ["slow", "done", "unfinished"],
    stores: Script["persistence"][] = ["bytes", "retained"];
  for (const profile of profiles)
    for (const mode of modes)
      for (const persistence of stores)
        cases.push({
          id: `intake-runtime.${profile}.${mode}.${persistence}`,
          profile,
          mode,
          persistence,
        });
  return cases;
}
export async function intakeRuntimeParity(
  options: { binary?: string; reportFile?: string } = {},
) {
  assert.equal(process.version, "v22.21.1");
  assert.equal(process.versions.v8, "12.4.254.21-node.33");
  const root = resolve(dirname(new URL(import.meta.url).pathname), "../.."),
    binary =
      options.binary ??
      join(
        process.env.CARGO_TARGET_DIR ?? join(root, "target"),
        "debug/examples/intake_runtime_driver",
      );
  if (!options.binary) {
    const build = spawnSync(
      process.env.CARGO ?? "cargo",
      [
        "build",
        "--locked",
        "-p",
        "demlik-tea",
        "--example",
        "intake_runtime_driver",
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
  const cases = intakeRuntimeCases(),
    run = spawnSync(binary, [], {
      cwd: root,
      input: `${cases.map((c) => JSON.stringify(c)).join("\n")}\n`,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  assert.equal(run.status, 0, run.stderr);
  const native = run.stdout
    .trim()
    .split("\n")
    .map((s) =>
      z
        .object({
          id: z.string(),
          output: z.object({ value: z.unknown(), calls: z.array(z.string()) }),
        })
        .parse(JSON.parse(s)),
    );
  assert.equal(native.length, cases.length);
  const results: {
    id: string;
    equal: boolean;
    reference: unknown;
    rust: unknown;
    publicCalls: string[];
  }[] = [];
  for (let i = 0; i < cases.length; i++) {
    const test = cases[i];
    assert.equal(native[i].id, test.id);
    const { id: _, ...input } = test;
    const reference = await executeIntakeRuntime(input);
    let equal = true;
    try {
      assert.deepEqual(native[i].output.value, reference);
    } catch {
      equal = false;
    }
    results.push({
      id: test.id,
      equal,
      reference,
      rust: native[i].output.value,
      publicCalls: native[i].output.calls,
    });
  }
  const failures = results.filter((r) => !r.equal),
    hash = (p: string) =>
      createHash("sha256").update(readFileSync(p)).digest("hex"),
    files = [
      "packages/tea/src/internal/idempotency/idempotent-intake/index.ts",
      "crates/tea/src/idempotency/intake.rs",
      "crates/tea/src/idempotency/intake/wire.rs",
      "crates/tea/examples/intake_runtime/consumer.rs",
      "crates/tea/examples/intake_runtime_driver.rs",
      "verification/parity/intake-runtime.mts",
    ];
  if (failures.length === 0)
    for (const result of results)
      for (const value of [result.reference, result.rust]) {
        const snapshots = z
          .object({
            snapshots: z
              .array(
                z.object({
                  workers: z.number(),
                  processes: z.number(),
                  replays: z.number(),
                  state: z.unknown(),
                  saved: z.unknown(),
                }),
              )
              .length(2),
          })
          .parse(value).snapshots;
        const mode = result.id.split(".")[2];
        assert.equal(snapshots[0].workers, mode === "slow" ? 0 : 1);
        assert.equal(snapshots[1].workers, mode === "unfinished" ? 2 : 1);
        assert.equal(snapshots[1].processes, 1);
        assert.equal(snapshots[1].replays, 1);
        for (const snapshot of snapshots)
          assert.deepEqual(snapshot.state, snapshot.saved);
      }
  const capabilityMappingProposal = [
    "new",
    "init",
    "receive",
    "complete",
    "boot",
    "claim_next",
  ].map((method) => ({
    sourceSymbol:
      method === "new"
        ? "createIntake"
        : method === "claim_next"
          ? "claimNext"
          : method,
    nativeSymbol: `Intake::${method}`,
    sourcePath: files[0],
    nativePath: files[1],
    caseIds: results
      .filter((r) => r.equal && r.publicCalls.includes(`Intake::${method}`))
      .map((r) => r.id),
  }));
  const report = {
    version: 1,
    passed: results.length - failures.length,
    total: results.length,
    failures,
    results,
    capabilityMappingProposal,
    binaryHash: hash(binary),
    sourceHashes: Object.fromEntries(
      files.map((f) => [f, hash(join(root, f))]),
    ),
    openGaps: [],
    engine: { node: process.version, v8: process.versions.v8 },
    qualifications: [
      "Fresh runtimes share retained storage or actual JSON bytes, not an OS process kill or external durable host deployment.",
      "The application opts into Hook/Receipt JSON codecs at its Store boundary. Separate public native tests prove opaque borrowed P/R/K values need no blanket Clone/serde/Send.",
      "The native host owns a local non-Send callback and the model has no Clone bound. Runtime scheduling uses awaited serial operations and explicit idle; arbitrary executors/concurrent producer ordering are not claimed.",
      "Effect Source explicitly awaits scope close; native explicitly awaits stop. Async Drop is not used as awaited-cleanup evidence.",
    ],
  };
  const reportFile =
    options.reportFile ?? join(root, "target/parity/intake-runtime.json");
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
  const r = await intakeRuntimeParity({
    binary: values.binary,
    reportFile: values.report,
  });
  console.log(
    JSON.stringify({
      passed: r.passed,
      total: r.total,
      failures: r.failures.map((f) => f.id),
      report: values.report ?? "target/parity/intake-runtime.json",
    }),
  );
  if (r.failures.length) process.exitCode = 1;
}
