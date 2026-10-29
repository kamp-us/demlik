import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import {
  createMonitoredRun,
  liftRun,
  type MonitoredRunState,
} from "../../packages/tea/src/flow/index.js";
import {
  createSnapshot,
  type SnapshotState,
  snapshotLoadDef,
  snapshotWriteDef,
} from "../../packages/tea/src/persistence/index.js";
import { deadlineExceeded } from "../../packages/tea/src/resilience/index.js";
import { createCheckWorktree } from "./check-worktree.mjs";
import { buildParityBinary } from "./tea-example.mjs";
import { decode, normalize, numeric } from "./timing-clock.mts";

const wireNumber = z.union([
  z.number(),
  z
    .object({ $number: z.enum(["NaN", "Infinity", "-Infinity", "-0"]) })
    .strict(),
]);
type N = z.infer<typeof wireNumber>;
const n = (value: N) => numeric.parse(value);
const snapshotFields = {
  sinceLast: wireNumber,
  seq: wireNumber,
  lastSavedSeq: wireNumber.nullable(),
  lastSavedAt: wireNumber.nullable(),
};
const snapshotInput = z.object(snapshotFields).strict();
const confirmation = { seq: wireNumber, at: wireNumber, settledAt: wireNumber };
const snapshotAction = z.discriminatedUnion("op", [
  z
    .object({
      op: z.enum(["record", "force"]),
      payload: z.json(),
      at: wireNumber,
    })
    .strict(),
  z.object({ op: z.literal("confirm"), ...confirmation }).strict(),
  z
    .object({ op: z.enum(["boot", "requestLoad", "reset", "roundTrip"]) })
    .strict(),
  z
    .object({ op: z.literal("writeOk"), payload: z.json(), ...confirmation })
    .strict(),
  z
    .object({ op: z.literal("writeErr"), detail: z.json(), ...confirmation })
    .strict(),
  z
    .object({ op: z.literal("loadOk"), value: z.json(), settledAt: wireNumber })
    .strict(),
  z
    .object({
      op: z.literal("loadErr"),
      detail: z.json(),
      settledAt: wireNumber,
    })
    .strict(),
]);
const runAction = z.discriminatedUnion("op", [
  z
    .object({ op: z.literal("start"), runId: z.string(), at: wireNumber })
    .strict(),
  z
    .object({ op: z.literal("progress"), payload: z.json(), at: wireNumber })
    .strict(),
  z
    .object({
      op: z.literal("advance"),
      payload: z.json(),
      at: wireNumber,
      result: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("ok") }).strict(),
        z.object({ kind: z.literal("fail"), error: z.json() }).strict(),
      ]),
    })
    .strict(),
  z.object({ op: z.literal("markStale") }).strict(),
  z.object({ op: z.enum(["cancel", "boot"]), at: wireNumber }).strict(),
  z
    .object({
      op: z.literal("deadline"),
      id: z.string().optional(),
      at: wireNumber,
    })
    .strict(),
  z.object({ op: z.literal("confirm"), ...confirmation }).strict(),
  z.object({ op: z.enum(["reset", "roundTrip"]) }).strict(),
]);
export const monitoredRunScript = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("snapshot"),
      every: wireNumber,
      key: z.string().optional(),
      initial: snapshotInput.optional(),
      actions: z.array(snapshotAction),
    })
    .strict(),
  z
    .object({
      kind: z.literal("monitoredRun"),
      stages: z.array(z.json()),
      deadlineMs: wireNumber.optional(),
      snapshotEvery: wireNumber.optional(),
      snapshotKey: z.string().optional(),
      initial: z
        .object({
          phase: z.enum(["running", "stale"]),
          runId: z.string(),
          startedAt: wireNumber,
          lastProgressAt: wireNumber,
          progressSeq: wireNumber,
          snapshot: snapshotInput,
        })
        .strict()
        .optional(),
      lift: z.boolean(),
      actions: z.array(runAction),
    })
    .strict(),
]);
type Script = z.infer<typeof monitoredRunScript>;
function snapshotState(value: z.infer<typeof snapshotInput>): SnapshotState {
  return {
    sinceLast: n(value.sinceLast),
    seq: n(value.seq),
    lastSavedSeq: value.lastSavedSeq === null ? null : n(value.lastSavedSeq),
    lastSavedAt: value.lastSavedAt === null ? null : n(value.lastSavedAt),
  };
}
const restoredSnapshot = z
  .object({
    sinceLast: z.number().nullable(),
    seq: z.number().nullable(),
    lastSavedSeq: z.number().nullable(),
    lastSavedAt: z.number().nullable(),
  })
  .strict();
const queueItem = z
  .object({
    id: z.string(),
    status: z.enum(["pending", "running", "done", "failed", "cancelled"]),
    input: z.unknown().optional(),
    enqueuedAt: z.number().nullable(),
    startedAt: z.number().nullable().optional(),
    finishedAt: z.number().nullable().optional(),
    output: z.string().optional(),
    error: z.string().optional(),
  })
  .strict();
const core = {
  stepStates: z.array(queueItem),
  startedAt: z.number().nullable(),
  lastProgressAt: z.number().nullable(),
  progressSeq: z.number().nullable(),
  snapshot: restoredSnapshot,
};
const restoredRun = z.discriminatedUnion("phase", [
  z.object({ phase: z.literal("idle"), ...core }).strict(),
  z
    .object({
      phase: z.enum(["running", "stale", "done"]),
      runId: z.string(),
      ...core,
    })
    .strict(),
  z
    .object({
      phase: z.literal("cancelled"),
      runId: z.string().nullable(),
      at: z.number().nullable(),
      ...core,
    })
    .strict(),
  z
    .object({
      phase: z.literal("failed"),
      runId: z.string(),
      ...core,
      failure: z.discriminatedUnion("reason", [
        z
          .object({ reason: z.literal("deadline"), at: z.number().nullable() })
          .strict(),
        z
          .object({
            reason: z.literal("stage"),
            stage: z.unknown().optional(),
            error: z.unknown().optional(),
          })
          .strict(),
      ]),
    })
    .strict(),
]);
const wireText = z.union([
  z.string(),
  z.object({ $utf16: z.array(z.number().int().min(0).max(65535)) }).strict(),
]);
const write = z
  .object({
    key: wireText,
    seq: wireNumber,
    at: wireNumber,
    payload: z.unknown(),
    type: z.literal("snapshot_write"),
  })
  .strict();
const load = z
  .object({ key: wireText, type: z.literal("snapshot_load") })
  .strict();
const commands = z.array(z.union([write, load]));
const expiry = z
  .object({
    type: z.literal("deadline_exceeded"),
    id: wireText,
    atMs: wireNumber,
  })
  .strict();
const event = z
  .union([
    expiry,
    z
      .object({
        type: z.enum(["snapshot_write_ok", "snapshot_load_ok"]),
        cmd: z.union([write, load]),
        value: z.unknown(),
        at: wireNumber,
      })
      .strict(),
    z
      .object({
        type: z.enum(["snapshot_write_err", "snapshot_load_err"]),
        cmd: z.union([write, load]),
        error: z.unknown(),
        at: wireNumber,
      })
      .strict(),
  ])
  .nullable();
const common = {
  stateKeys: z.array(z.string()),
  commands,
  sameState: z.boolean().nullable(),
  priorStateUnchanged: z.boolean(),
  event,
};
const outputSnapshot = snapshotInput.extend({
  sinceLast: wireNumber.nullable(),
  seq: wireNumber.nullable(),
});
const outputQueue = z
  .object({
    id: wireText,
    status: z.enum(["pending", "running", "done", "failed", "cancelled"]),
    input: z.unknown().optional(),
    enqueuedAt: wireNumber.nullable(),
    startedAt: wireNumber.nullable().optional(),
    finishedAt: wireNumber.nullable().optional(),
    output: wireText.optional(),
    error: wireText.optional(),
  })
  .strict();
const outputCore = {
  stepStates: z.array(outputQueue),
  startedAt: wireNumber.nullable(),
  lastProgressAt: wireNumber.nullable(),
  progressSeq: wireNumber.nullable(),
  snapshot: outputSnapshot,
};
const outputRun = z.discriminatedUnion("phase", [
  z.object({ phase: z.literal("idle"), ...outputCore }).strict(),
  z
    .object({
      phase: z.enum(["running", "stale", "done"]),
      runId: wireText,
      ...outputCore,
    })
    .strict(),
  z
    .object({
      phase: z.literal("cancelled"),
      runId: wireText.nullable(),
      at: wireNumber.nullable(),
      ...outputCore,
    })
    .strict(),
  z
    .object({
      phase: z.literal("failed"),
      runId: wireText,
      ...outputCore,
      failure: z.discriminatedUnion("reason", [
        z
          .object({ reason: z.literal("deadline"), at: wireNumber.nullable() })
          .strict(),
        z
          .object({
            reason: z.literal("stage"),
            stage: z.unknown().optional(),
            error: z.unknown().optional(),
          })
          .strict(),
      ]),
    })
    .strict(),
]);
const comparisonSchema = z.array(
  z.union([
    z.object({ ...common, state: outputSnapshot }).strict(),
    z
      .object({
        ...common,
        state: outputRun,
        failureKeys: z.array(z.string()),
        sameSnapshot: z.boolean().nullable(),
        deadlines: z.array(
          z
            .object({
              id: wireText,
              type: z.literal("deadline"),
              atMs: wireNumber,
            })
            .strict(),
        ),
        timer: z.object({ ms: wireNumber, msg: expiry }).strict().nullable(),
      })
      .strict(),
  ]),
);
const responseSchema = z
  .object({
    comparison: comparisonSchema,
    observedRustCalls: z.array(z.string()).nonempty(),
  })
  .strict();
export function executeMonitoredRun(value: unknown) {
  const script = monitoredRunScript.parse(value);
  if (script.kind === "snapshot") {
    const knob = createSnapshot<unknown>({
      every: n(script.every),
      key: script.key,
    });
    let state = script.initial ? snapshotState(script.initial) : knob.init();
    const row = (
      commands: readonly unknown[],
      sameState: boolean | null,
      priorStateUnchanged: boolean,
      event: unknown = null,
    ) =>
      normalize({
        stateKeys: Object.keys(state),
        state,
        commands,
        sameState,
        priorStateUnchanged,
        event,
      });
    const rows = [row([], null, true)];
    for (const action of script.actions) {
      const previous = state,
        before = normalize(state);
      let commands: readonly unknown[] = [],
        event: unknown = null;
      switch (action.op) {
        case "record":
          [state, commands] = knob.record(
            state,
            decode(action.payload),
            n(action.at),
          );
          break;
        case "force":
          [state, commands] = knob.force(
            state,
            decode(action.payload),
            n(action.at),
          );
          break;
        case "confirm": {
          const cmd = knob.write({
            key: "foreign/ack",
            seq: n(action.seq),
            at: n(action.at),
            payload: null,
          });
          const msg = knob.write.ok(cmd, undefined, n(action.settledAt));
          event = msg;
          [state, commands] = knob.confirm(state, msg);
          break;
        }
        case "boot":
          [state, commands] = knob.boot(state);
          break;
        case "requestLoad":
          [state, commands] = knob.requestLoad(state);
          break;
        case "reset":
          state = knob.init();
          break;
        case "roundTrip":
          {
            const restored = restoredSnapshot.parse(
              JSON.parse(JSON.stringify(state)),
            );
            const host = { state };
            Reflect.set(host, "state", restored);
            state = host.state;
          }
          break;
        case "writeOk": {
          const def = snapshotWriteDef<unknown>();
          const cmd = def({
            key: "definition",
            seq: n(action.seq),
            at: n(action.at),
            payload: decode(action.payload),
          });
          event = def.ok(cmd, undefined, n(action.settledAt));
          break;
        }
        case "writeErr": {
          const def = snapshotWriteDef<unknown>();
          const cmd = def({
            key: "definition",
            seq: n(action.seq),
            at: n(action.at),
            payload: null,
          });
          event = def.err(
            cmd,
            { _tag: "snapshot_write_failed", detail: decode(action.detail) },
            n(action.settledAt),
          );
          break;
        }
        case "loadOk": {
          const def = snapshotLoadDef<unknown>();
          const cmd = def({ key: "definition" });
          event = def.ok(cmd, decode(action.value), n(action.settledAt));
          break;
        }
        case "loadErr": {
          const def = snapshotLoadDef<unknown>();
          const cmd = def({ key: "definition" });
          event = def.err(
            cmd,
            { _tag: "snapshot_load_failed", detail: decode(action.detail) },
            n(action.settledAt),
          );
          break;
        }
      }
      rows.push(
        row(
          commands,
          state === previous,
          JSON.stringify(before) === JSON.stringify(normalize(previous)),
          event,
        ),
      );
    }
    return comparisonSchema.parse(rows);
  }
  const knob = createMonitoredRun<unknown, unknown>({
    stages: script.stages.map(decode),
    deadlineMs:
      script.deadlineMs === undefined ? undefined : n(script.deadlineMs),
    snapshotEvery:
      script.snapshotEvery === undefined ? undefined : n(script.snapshotEvery),
    snapshotKey: script.snapshotKey,
  });
  let state: MonitoredRunState<unknown> = knob.init();
  if (script.initial) {
    const initial = script.initial;
    state = {
      ...knob.start(state, initial.runId, n(initial.startedAt))[0],
      phase: initial.phase,
      runId: initial.runId,
      lastProgressAt: n(initial.lastProgressAt),
      progressSeq: n(initial.progressSeq),
      snapshot: snapshotState(initial.snapshot),
    };
  }
  const ack = knob.checkpoint,
    marker = { opaque: true };
  const row = (
    commands: readonly unknown[],
    sameState: boolean | null,
    sameSnapshot: boolean | null,
    priorStateUnchanged: boolean,
    event: unknown = null,
  ) =>
    normalize({
      stateKeys: Object.keys(state),
      failureKeys: state.phase === "failed" ? Object.keys(state.failure) : [],
      state,
      commands,
      sameState,
      sameSnapshot,
      priorStateUnchanged,
      event,
      deadlines: knob.deadlines(state),
      timer: knob.timer(state),
    });
  const rows = [row([], null, null, true)];
  for (const action of script.actions) {
    const previous = state,
      before = normalize(state);
    let commands: readonly ReturnType<typeof knob.checkpoint>[] = [],
      event: unknown = null;
    switch (action.op) {
      case "start":
        [state, commands] = knob.start(state, action.runId, n(action.at));
        break;
      case "progress":
        [state, commands] = knob.progress(
          state,
          decode(action.payload),
          n(action.at),
        );
        break;
      case "advance":
        [state, commands] = knob.advance(
          state,
          decode(action.payload),
          action.result.kind === "ok"
            ? { kind: "ok" }
            : { kind: "fail", error: decode(action.result.error) },
          n(action.at),
        );
        break;
      case "markStale":
        [state, commands] = knob.markStale(state);
        break;
      case "cancel":
        [state, commands] = knob.cancel(state, n(action.at));
        break;
      case "boot":
        [state, commands] = knob.boot(state, n(action.at));
        break;
      case "deadline": {
        const id = action.id ?? knob.deadlines(state)[0]?.id ?? "rogue";
        const msg = deadlineExceeded(id, n(action.at));
        event = msg;
        [state, commands] = knob.onDeadline(state, msg);
        break;
      }
      case "confirm": {
        const cmd = ack({
          key: "foreign/ack",
          seq: n(action.seq),
          at: n(action.at),
          payload: null,
        });
        const msg = ack.ok(cmd, undefined, n(action.settledAt));
        event = msg;
        state = knob.confirmSnapshot(state, msg);
        break;
      }
      case "reset":
        state = knob.init();
        break;
      case "roundTrip": {
        const restored = restoredRun.parse(JSON.parse(JSON.stringify(state)));
        // JSON omits own undefined fields that the source alias still requires.
        // Reflect keeps this restored-data boundary explicit in the fixture.
        const host = { state };
        Reflect.set(host, "state", restored);
        state = host.state;
        break;
      }
    }
    if (script.lift) {
      const [host, lifted] = liftRun({ run: previous, marker }, [
        state,
        commands,
      ]);
      assert.equal(host.marker, marker);
      state = host.run;
      commands = lifted;
    }
    rows.push(
      row(
        commands,
        state === previous,
        state.snapshot === previous.snapshot,
        JSON.stringify(before) === JSON.stringify(normalize(previous)),
        event,
      ),
    );
  }
  return comparisonSchema.parse(rows);
}
type Case = { id: string; script: Script };
function corpus(): Case[] {
  const cases: Case[] = [];
  const snap = (
    id: string,
    every: N,
    actions: z.infer<typeof snapshotAction>[],
    key?: string,
    initial?: z.infer<typeof snapshotInput>,
  ) =>
    cases.push({
      id: `snapshot.${id}`,
      script: {
        kind: "snapshot",
        every,
        actions,
        ...(key === undefined ? {} : { key }),
        ...(initial ? { initial } : {}),
      },
    });
  const confirm = (
    seq: N,
    at: N,
    settledAt: N = 77.25,
  ): z.infer<typeof snapshotAction> => ({ op: "confirm", seq, at, settledAt });
  snap(
    "cadence-force-watermark",
    2,
    [
      { op: "record", payload: { step: 1 }, at: 10 },
      { op: "record", payload: { step: 2 }, at: 20 },
      { op: "force", payload: { step: 3 }, at: 30 },
      confirm(2, 30),
      confirm(1, 20),
      confirm(2, 999),
      { op: "record", payload: { step: 4 }, at: 40 },
      { op: "boot" },
      { op: "requestLoad" },
      { op: "roundTrip" },
    ],
    "checkpoint",
  );
  snap(
    "definitions",
    2,
    [
      {
        op: "writeOk",
        payload: { local: [1, false] },
        seq: 1,
        at: 10,
        settledAt: 20,
      },
      {
        op: "writeErr",
        detail: { code: "disk_full" },
        seq: 2,
        at: 20,
        settledAt: 30,
      },
      { op: "loadOk", value: { step: 3 }, settledAt: 40 },
      { op: "loadOk", value: null, settledAt: 50 },
      { op: "loadOk", value: { $undefined: true }, settledAt: 60 },
      { op: "loadErr", detail: { code: "unavailable" }, settledAt: 70 },
      { op: "requestLoad" },
    ],
    "",
  );
  for (const [label, every] of Object.entries({
    zero: 0,
    negative: -3,
    fractional: 1.5,
    nan: { $number: "NaN" },
    infinity: { $number: "Infinity" },
    negativeInfinity: { $number: "-Infinity" },
    negativeZero: { $number: "-0" },
  }))
    snap(`cadence-${label}`, wireNumber.parse(every), [
      { op: "record", payload: 1, at: { $number: "-0" } },
      { op: "record", payload: 2, at: { $number: "Infinity" } },
      { op: "record", payload: 3, at: { $number: "NaN" } },
      { op: "force", payload: { $number: "-0" }, at: 1.25 },
      { op: "boot" },
      { op: "requestLoad" },
    ]);
  snap(
    "nonfinite-watermark",
    2,
    [
      confirm({ $number: "Infinity" }, 1),
      confirm(3, 2),
      confirm({ $number: "NaN" }, 3),
      confirm(-2, 4),
      {
        op: "force",
        payload: { $undefined: true },
        at: { $number: "-Infinity" },
      },
    ],
    undefined,
    {
      sinceLast: { $number: "NaN" },
      seq: { $number: "Infinity" },
      lastSavedSeq: null,
      lastSavedAt: null,
    },
  );
  for (let seed = 1; seed <= 12; seed++) {
    let rng = seed;
    const draw = (n: number) => {
      rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0;
      return rng % n;
    };
    const actions: z.infer<typeof snapshotAction>[] = [];
    for (let i = 0; i < 32; i++) {
      const d = draw(8);
      actions.push(
        d === 0
          ? { op: "boot" }
          : d === 1
            ? confirm(draw(7), i * 3)
            : d === 2
              ? { op: "requestLoad" }
              : d === 3
                ? { op: "force", payload: { seed, position: i }, at: i * 3 }
                : { op: "record", payload: { seed, position: i }, at: i * 3 },
      );
    }
    actions.push({ op: "roundTrip" });
    snap(`generated-${seed}`, 1 + (seed % 5), actions);
  }
  const run = (
    id: string,
    actions: z.infer<typeof runAction>[],
    options: Partial<
      Omit<Extract<Script, { kind: "monitoredRun" }>, "kind" | "actions">
    > = {},
  ) =>
    cases.push({
      id: `monitored-run.${id}`,
      script: {
        kind: "monitoredRun",
        stages: [],
        lift: false,
        actions,
        ...options,
      },
    });
  const start = (runId = "r", at: N = 10): z.infer<typeof runAction> => ({
    op: "start",
    runId,
    at,
  });
  const advance = (
    at: N,
    error?: z.infer<ReturnType<typeof z.json>>,
  ): z.infer<typeof runAction> => ({
    op: "advance",
    payload: { at },
    at,
    result: error === undefined ? { kind: "ok" } : { kind: "fail", error },
  });
  run(
    "pipeline-boot-and-terminal",
    [
      start("", 10),
      { op: "progress", payload: { step: 0 }, at: 11 },
      advance(20),
      { op: "markStale" },
      advance(30),
      { op: "boot", at: 9000 },
      { op: "deadline", id: "monitored:safety::2", at: 9001 },
      { op: "confirm", seq: 2, at: 30, settledAt: 9002 },
      advance(9010),
      { op: "confirm", seq: 1, at: 11, settledAt: 9011 },
      { op: "cancel", at: 9012 },
      { op: "roundTrip" },
      start("new", 9020),
    ],
    {
      stages: [{ name: "a" }, { name: "b" }, { name: "c" }],
      deadlineMs: 1000,
      snapshotEvery: 2,
      snapshotKey: "run/cp",
      lift: true,
    },
  );
  run(
    "idle-cancel-noops",
    [
      { op: "progress", payload: 1, at: 1 },
      advance(2),
      { op: "markStale" },
      { op: "boot", at: 3 },
      { op: "deadline", id: "monitored:safety::0", at: 4 },
      { op: "cancel", at: 5 },
      { op: "cancel", at: 6 },
      { op: "roundTrip" },
      start("", 10),
      { op: "cancel", at: 11 },
      { op: "roundTrip" },
    ],
    { deadlineMs: 20, lift: true },
  );
  run(
    "single-shot-forced",
    [
      start(),
      { op: "progress", payload: 1, at: 11 },
      { op: "markStale" },
      advance(12),
      { op: "progress", payload: 2, at: 13 },
      advance(14),
      { op: "boot", at: 15 },
      { op: "deadline", id: "monitored:safety:r:2", at: 16 },
    ],
    { snapshotEvery: 9, snapshotKey: "", deadlineMs: 25.5 },
  );
  run(
    "disabled-checkpoint-confirm",
    [
      start(),
      { op: "confirm", seq: 7, at: 1, settledAt: 999 },
      { op: "deadline", id: "monitored:safety:r:0", at: 0 },
      { op: "roundTrip" },
      start("again", 10),
    ],
    { snapshotKey: "ignored" },
  );
  for (const [label, error] of Object.entries({
    record: { code: "E", detail: [1, false] },
    null: null,
    undefined: { $undefined: true },
    number: { $number: "NaN" },
  }))
    run(
      `stage-failure-${label}`,
      [
        start(),
        advance(20, z.json().parse(error)),
        { op: "cancel", at: 21 },
        { op: "boot", at: 22 },
        { op: "roundTrip" },
        start("restarted", 30),
      ],
      { snapshotEvery: 1, lift: true },
    );
  run(
    "stage-failure-pipeline",
    [
      start(),
      advance(20, { reason: "io" }),
      { op: "roundTrip" },
      start("after-error", 30),
    ],
    {
      stages: [{ stage: "a" }, { stage: "b" }],
      snapshotEvery: 1,
      deadlineMs: 20,
    },
  );
  run(
    "live-watchdog",
    [
      start(),
      { op: "markStale" },
      { op: "markStale" },
      { op: "progress", payload: 1, at: 20 },
      { op: "deadline", id: "monitored:safety:r:0", at: 21 },
      { op: "boot", at: 1000 },
      { op: "deadline", id: "monitored:safety:r:1", at: 1001 },
      { op: "deadline", at: 0 },
      { op: "deadline", at: 2000 },
      { op: "roundTrip" },
    ],
    { stages: ["one", "two"], deadlineMs: 50, snapshotEvery: 3 },
  );
  for (const [label, value] of Object.entries({
    zero: 0,
    negative: -5,
    nan: { $number: "NaN" },
    infinity: { $number: "Infinity" },
    negativeInfinity: { $number: "-Infinity" },
    negativeZero: { $number: "-0" },
  }))
    run(
      `number-${label}`,
      [
        start("clock", wireNumber.parse(value)),
        {
          op: "progress",
          payload: { $number: "NaN" },
          at: wireNumber.parse(value),
        },
        { op: "deadline", at: wireNumber.parse(value) },
        start("second", 1),
        advance(2),
      ],
      {
        deadlineMs: wireNumber.parse(value),
        snapshotEvery: wireNumber.parse(value),
      },
    );
  const emptySnapshot = {
    sinceLast: 0,
    seq: 0,
    lastSavedSeq: null,
    lastSavedAt: null,
  };
  for (const [label, seq] of Object.entries({
    nan: { $number: "NaN" },
    infinity: { $number: "Infinity" },
    negativeZero: { $number: "-0" },
    large: 1e21,
  }))
    run(
      `restored-sequence-${label}`,
      [
        {
          op: "deadline",
          id: `monitored:safety:r:${label === "large" ? "1e+21" : label === "nan" ? "NaN" : label === "infinity" ? "Infinity" : "0"}`,
          at: 1,
        },
      ],
      {
        deadlineMs: 10,
        initial: {
          phase: "stale",
          runId: "r",
          startedAt: 0,
          lastProgressAt: 0,
          progressSeq: wireNumber.parse(seq),
          snapshot: emptySnapshot,
        },
      },
    );
  run(
    "utf16-identities",
    [
      start("\ud800😀\u0000", 10),
      { op: "progress", payload: { value: "\udfff" }, at: 11 },
      { op: "deadline", at: 12 },
    ],
    { deadlineMs: 20, snapshotEvery: 1, snapshotKey: "cp/\ud800", lift: true },
  );
  for (let seed = 1; seed <= 12; seed++) {
    let rng = seed;
    const draw = (n: number) => {
      rng = (Math.imul(rng, 1103515245) + 12345) >>> 0;
      return rng % n;
    };
    const actions: z.infer<typeof runAction>[] = [start(`seed-${seed}`, 0)];
    for (let i = 1; i <= 36; i++) {
      switch (draw(10)) {
        case 0:
          actions.push({ op: "markStale" });
          break;
        case 1:
          actions.push({ op: "boot", at: i * 3 });
          break;
        case 2:
          actions.push(advance(i * 3));
          break;
        case 3:
          actions.push({
            op: "confirm",
            seq: draw(5),
            at: i * 3,
            settledAt: i * 3 + 1,
          });
          break;
        case 4:
          actions.push({ op: "deadline", id: "stale-alarm", at: i * 3 });
          break;
        case 5:
          actions.push({ op: "roundTrip" });
          break;
        case 6:
          actions.push(start(`seed-${seed}-${i}`, i * 3));
          break;
        default:
          actions.push({ op: "progress", payload: { seed, i }, at: i * 3 });
      }
    }
    run(`generated-${seed}`, actions, {
      stages: seed % 2 ? ["a", "b", "c"] : [],
      deadlineMs: 17.25,
      ...(seed % 3 ? { snapshotEvery: 1 + (seed % 5) } : {}),
      lift: seed % 2 === 0,
    });
  }
  snap(
    "null-counter-restore",
    2,
    [
      { op: "roundTrip" },
      { op: "record", payload: 1, at: 10 },
      { op: "record", payload: 2, at: 20 },
      confirm(1, 20),
      { op: "force", payload: 3, at: 30 },
    ],
    undefined,
    {
      sinceLast: { $number: "NaN" },
      seq: { $number: "Infinity" },
      lastSavedSeq: { $number: "Infinity" },
      lastSavedAt: { $number: "NaN" },
    },
  );
  run(
    "null-clock-restore",
    [
      start("r", { $number: "NaN" }),
      { op: "progress", payload: 1, at: { $number: "Infinity" } },
      { op: "roundTrip" },
      { op: "boot", at: 100 },
      advance(200),
      { op: "roundTrip" },
    ],
    { stages: ["one", "two"], deadlineMs: 25, snapshotEvery: 1 },
  );
  run(
    "null-watchdog-sequence",
    [
      { op: "roundTrip" },
      { op: "deadline", id: "monitored:safety:r:NaN", at: 1 },
      { op: "progress", payload: 1, at: 10 },
      { op: "boot", at: 20 },
      { op: "deadline", at: { $number: "NaN" } },
      { op: "roundTrip" },
      { op: "boot", at: 30 },
    ],
    {
      deadlineMs: 10,
      snapshotEvery: 2,
      initial: {
        phase: "stale",
        runId: "r",
        startedAt: 0,
        lastProgressAt: 0,
        progressSeq: { $number: "NaN" },
        snapshot: {
          sinceLast: { $number: "NaN" },
          seq: { $number: "NaN" },
          lastSavedSeq: null,
          lastSavedAt: null,
        },
      },
    },
  );
  run(
    "null-cancel-at",
    [
      { op: "cancel", at: { $number: "NaN" } },
      { op: "roundTrip" },
      { op: "boot", at: 10 },
      start("after", 20),
    ],
    { deadlineMs: 10, lift: true },
  );
  run(
    "undefined-stage-restore-ok",
    [start(), { op: "roundTrip" }, { op: "boot", at: 100 }, advance(101)],
    { stages: [{ $undefined: true }], lift: true },
  );
  run(
    "undefined-stage-restore-failure",
    [
      start(),
      { op: "roundTrip" },
      advance(101, { code: "failed" }),
      { op: "roundTrip" },
    ],
    { stages: [{ $undefined: true }], snapshotEvery: 1 },
  );
  return cases;
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
      `${binary} exited ${result.status}; completed ${result.stdout.trim().split("\n").filter(Boolean).length} output lines\n${result.stderr.slice(-8000)}`,
    );
  return result.stdout;
}
function binary(cwd = process.cwd(), target = process.env.CARGO_TARGET_DIR) {
  return join(
    target ? resolve(cwd, target) : join(cwd, "target"),
    "debug/monitored_run_driver",
  );
}
function build(cwd = process.cwd(), target?: string) {
  command(
    process.env.CARGO ?? "cargo",
    [
      "build",
      "--locked",
      "-p",
      "demlik-parity",
      "--bin",
      "monitored_run_driver",
    ],
    undefined,
    cwd,
    {
      ...process.env,
      CARGO_NET_OFFLINE: "true",
      ...(target ? {} : {}),
    },
  );
}
function native(cases: Case[], executable: string) {
  const result = spawnSync(executable, [], {
    input: `${cases.map((item) => JSON.stringify(normalize(item.script))).join("\n")}\n`,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  const lines = result.stdout.trim().split("\n").filter(Boolean);
  if (result.status !== 0)
    throw new Error(
      `${executable} exited ${result.status} while running ${cases[lines.length]?.id ?? "after corpus"}\n${result.stderr.slice(-8000)}`,
    );
  return lines.map((line, index) => {
    try {
      return responseSchema.parse(JSON.parse(line));
    } catch (cause) {
      throw new Error(`Invalid native response for ${cases[index].id}`, {
        cause,
      });
    }
  });
}
function digest(file: string) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}
const mutations = [
  {
    id: "monitored-boot-reuses-alarm",
    file: "crates/tea/src/flow/monitored_run.rs",
    needle: "next.core.snapshot = self.snapshot.boot(&state.snapshot).state;",
    replacement:
      "next.core.progress_seq = state.progress_seq; next.core.snapshot = self.snapshot.boot(&state.snapshot).state;",
  },
  {
    id: "snapshot-stale-ack-regresses",
    file: "crates/tea/src/persistence/snapshot.rs",
    needle: "if state.last_saved_seq.is_some_and(|last| input.seq <= last)",
    replacement: "if false",
  },
];
function controls(cases: Case[], expected: z.infer<typeof comparisonSchema>[]) {
  return mutations.map((mutation) => {
    const mutationCheck = createCheckWorktree(process.cwd(), "monitored-run");
    let mutationFailure: unknown;
    try {
      const temporary = mutationCheck.root,
        before = digest(mutation.file);
      try {
        const file = join(temporary, mutation.file),
          source = readFileSync(file, "utf8");
        assert.equal(digest(file), before);
        assert.equal(source.split(mutation.needle).length, 2);
        writeFileSync(
          file,
          source.replace(mutation.needle, mutation.replacement),
        );
        const target = join(temporary, "target");
        build(temporary, target);
        const executable = binary(temporary, target),
          results = native(cases, executable);
        assert.equal(results.length, cases.length);
        const detectedIds = cases
          .filter((_, index) => {
            try {
              assert.deepEqual(results[index].comparison, expected[index]);
              return false;
            } catch {
              return true;
            }
          })
          .map((item) => item.id);
        assert(detectedIds.length > 0, `${mutation.id} must change output`);
        assert.equal(digest(mutation.file), before);
        return {
          id: mutation.id,
          isolation: "registered-worktree-default-target",
          sourceBeforeSha256: before,
          mutantSourceSha256: digest(file),
          nativeBinarySha256: digest(executable),
          activeSourceUnchanged: true,
          detectedIds,
        };
      } finally {
        assert.equal(digest(mutation.file), before);
      }
    } catch (error) {
      mutationFailure = error;
      throw error;
    } finally {
      mutationCheck.remove(mutationFailure);
    }
  });
}
export function verifyMonitoredRun(
  reportPath = "target/parity/monitored-run.json",
  binaryOverride?: string,
  mutationCheck = false,
) {
  let producer: ReturnType<typeof buildParityBinary> | null = null;
  let executable: string;
  if (binaryOverride) {
    executable = binaryOverride;
  } else {
    producer = buildParityBinary(
      process.env.CARGO ?? "cargo",
      "monitored_run_driver",
      reportPath,
    );
    executable = binaryOverride ?? producer.binary;
  }
  const cases = corpus(),
    expected = cases.map((item) => executeMonitoredRun(item.script)),
    results = native(cases, executable);
  assert.equal(results.length, cases.length);
  const failures: {
    id: string;
    message: string;
    reference: unknown;
    native: unknown;
  }[] = [];
  cases.forEach((item, index) => {
    try {
      assert.deepEqual(results[index].comparison, expected[index], item.id);
    } catch (error) {
      failures.push({
        id: item.id,
        message: error instanceof Error ? error.message : String(error),
        reference: expected[index],
        native: results[index].comparison,
      });
    }
  });
  const cadence =
    expected[
      cases.findIndex((item) => item.id === "snapshot.cadence-force-watermark")
    ];
  assert.equal(outputSnapshot.parse(cadence[5].state).lastSavedAt, 30);
  assert.equal(cadence[6].sameState, true);
  const cold =
    expected[
      cases.findIndex(
        (item) => item.id === "monitored-run.pipeline-boot-and-terminal",
      )
    ];
  const coldState = outputRun.parse(cold[6].state);
  assert.equal(coldState.phase, "running");
  assert.equal(coldState.progressSeq, 4);
  const cargo = process.env.CARGO ?? "cargo",
    rustc =
      process.env.RUSTC ??
      (isAbsolute(cargo) ? join(dirname(cargo), "rustc") : "rustc");
  const report = {
    producer,
    runtime: {
      node: process.version,
      v8: process.versions.v8,
      rustc: command(rustc, ["--version"]).trim(),
    },
    binary: { path: executable, sha256: digest(executable) },
    compared: cases.length,
    transitions: cases.reduce(
      (sum, item) => sum + item.script.actions.length,
      0,
    ),
    passed: cases.length - failures.length,
    failures,
    controls:
      mutationCheck && !failures.length ? controls(cases, expected) : [],
    cases: cases.map((item, index) => ({
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
  const { values } = parseArgs({
    options: {
      report: { type: "string" },
      "native-binary": { type: "string" },
      "mutation-check": { type: "boolean", default: false },
    },
    strict: true,
  });
  const report = verifyMonitoredRun(
    values.report,
    values["native-binary"],
    values["mutation-check"],
  );
  console.log(
    JSON.stringify({
      compared: report.compared,
      transitions: report.transitions,
      passed: report.passed,
      failures: report.failures,
      controls: report.controls.map((item) => ({
        id: item.id,
        detected: item.detectedIds.length,
      })),
      report: values.report ?? "target/parity/monitored-run.json",
    }),
  );
  if (report.failures.length) process.exitCode = 1;
}
