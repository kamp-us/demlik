import { AsyncLocalStorage, createHook } from "node:async_hooks";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  setTimeout as sleep,
  setImmediate as turn,
} from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  Cmd,
  type DispatchOptions,
  defineMachine,
  deliveryIdOf,
  type InterpretCell,
  type LoggedStore,
  logLedger,
  type NoCtx,
  Outcome,
  type OwedEffect,
  owed,
  type Settled,
  type TimerSub,
} from "../../index";
import { memoryJournal } from "../../mem";
import { fileJournal } from "../../node";
import { eventSourcedStore } from "../../persistence";
import {
  type DeadlinesSub,
  deadlineExceeded,
  deadlineSub,
  deadlinesSub,
} from "../../resilience";
import type { Journal } from "../journal";
import { readDeliveryLedger } from "./durable-log/format";

const state = z.object({
  steps: z.array(z.number()),
  completed: z.array(z.number()),
  fired: z.array(z.string()),
  due: z.array(z.object({ id: z.string(), atMs: z.number() })),
});
const message = z.discriminatedUnion("_tag", [
  z.object({ _tag: z.literal("step"), call: z.number(), part: z.number() }),
  z.object({ _tag: z.literal("completed"), value: z.number() }),
  z.object({
    _tag: z.literal("deadline_exceeded"),
    id: z.string(),
    atMs: z.number(),
  }),
]);
const command = z.object({ _tag: z.literal("complete"), value: z.number() });
export type State = z.infer<typeof state>;
export type Msg = z.infer<typeof message>;
export type Work = z.infer<typeof command>;
export type Store = LoggedStore<State, Msg, Work>;

export const deadlinesFor = (s: State) =>
  s.due.map(({ id, atMs }) => deadlineSub(id, atMs));
const nextDeadline = (s: State) =>
  deadlinesFor(s).reduce<number | null>(
    (next, d) => (next === null ? d.atMs : Math.min(next, d.atMs)),
    null,
  );

export function machine(timer = false) {
  return defineMachine({
    types: {
      model: {} as State,
      msg: {} as Msg,
      cmd: {} as Work,
      sub: {} as DeadlinesSub | TimerSub<Msg>,
    },
    init: (loaded) => [
      loaded ?? { steps: [], completed: [], fired: [], due: [] },
      [],
    ],
    update: {
      step: (s, m) => {
        const value = m.call * 10 + m.part;
        const due =
          m.part === 0 && (m.call % 7 === 0 || m.call === 49)
            ? [
                ...s.due,
                { id: `d-${m.call}`, atMs: 1_000_000 + (m.call + 2) * 1000 },
              ]
            : s.due;
        return [
          { ...s, steps: [...s.steps, value], due },
          [{ _tag: "complete", value }],
        ];
      },
      completed: (s, m) => [{ ...s, completed: [...s.completed, m.value] }, []],
      deadline_exceeded: (s, m) => [
        {
          ...s,
          fired: [...s.fired, m.id],
          due: s.due.filter((d) => d.id !== m.id),
        },
        [],
      ],
    },
    subs: [
      deadlinesSub(deadlinesFor),
      {
        _tag: "timer",
        deps: () =>
          timer
            ? { ms: 60_000, msg: { _tag: "completed" as const, value: -1 } }
            : null,
      },
    ],
  });
}

export interface Host {
  dispatch(msg: Msg, options?: { id: string }): Promise<void>;
  getState(): State;
  stop(): Promise<void>;
  live(): { subs: number; cmds: number };
}
export interface BootOptions {
  timer?: boolean;
  dispose?: () => Promise<void>;
  handle?: (cmd: Work) => Promise<Msg | undefined>;
  errors?: unknown[];
}
export type Boot = (store: Store, options?: BootOptions) => Promise<Host>;
export const complete = async (cmd: Work): Promise<Msg> => {
  await Promise.resolve();
  return { _tag: "completed", value: cmd.value };
};
export const storeFor = (journal: Journal) =>
  eventSourcedStore(journal, { state, message, command });

type Activation = { fibers: Set<object>; startedFibers: number };
const activation = new AsyncLocalStorage<Activation>();

/** Called only by the Effect test's runtime observers, never by production. */
export function observeFiber(fiber: { addObserver(cb: () => void): unknown }) {
  const owner = activation.getStore();
  if (!owner || owner.fibers.has(fiber)) return;
  owner.startedFibers += 1;
  owner.fibers.add(fiber);
  fiber.addObserver(() => owner.fibers.delete(fiber));
}

const activeHandles = () =>
  (
    process as typeof process & { _getActiveHandles(): object[] }
  )._getActiveHandles();
export const emptyResources = { handles: 0, timers: 0, promises: 0, fibers: 0 };

/** Settlement, not garbage collection; Node's handle list omits timers. */
export async function measured<T>(work: () => Promise<T>) {
  const owner: Activation = { fibers: new Set(), startedFibers: 0 };
  const resources = new Map<number, string>();
  const handlesBefore = new Set(activeHandles());
  const hook = createHook({
    init(id, type) {
      if (activation.getStore() === owner) resources.set(id, type);
    },
    promiseResolve(id) {
      resources.delete(id);
    },
    destroy(id) {
      if (resources.get(id) !== "PROMISE") resources.delete(id);
    },
  }).enable();
  try {
    const result = await activation.run(owner, work);
    await turn();
    await turn();
    const types = [...resources.values()];
    return {
      result,
      resources: {
        handles: activeHandles().filter((h) => !handlesBefore.has(h)).length,
        timers: types.filter((t) => /^(Timeout|TIMERWRAP)$/.test(t)).length,
        promises: types.filter((t) => t === "PROMISE").length,
        fibers: owner.fibers.size,
      },
      startedFibers: owner.startedFibers,
    };
  } finally {
    hook.disable();
  }
}

async function storage(driver: "memory" | "file") {
  const dir = await mkdtemp(join(tmpdir(), "tea-per-call-"));
  const retained = memoryJournal();
  let closed = 0;
  return {
    open(): Journal {
      const raw = driver === "file" ? fileJournal(dir) : retained;
      let active = true;
      return {
        read: (...args) => {
          expect(active, "read on closed activation journal").toBe(true);
          return raw.read(...args);
        },
        append: (...args) => {
          expect(active, "write on closed activation journal").toBe(true);
          return raw.append(...args);
        },
        close: async () => {
          expect(active, "journal closed twice").toBe(true);
          active = false;
          await raw.close();
          closed += 1;
        },
      };
    },
    closed: () => closed,
    remove: () => rm(dir, { recursive: true, force: true }),
  };
}

const jobInput = z.object({ value: z.number() });
const jobOk = z.union([
  z.number(),
  z.object({ _tag: z.literal("Owed") }),
  z.void(),
]);
export const job = Cmd.define("job", {
  input: jobInput,
  ok: jobOk,
  err: ["unavailable"],
});
export type Job = ReturnType<typeof job>;
type JobMsg =
  | { readonly _tag: "start"; readonly value: number }
  | Settled<typeof job>;
const jobState = z.object({
  started: z.array(z.number()),
  settled: z.array(z.string()),
});
type JobState = z.infer<typeof jobState>;
const jobCommand = z.object({
  _tag: z.literal(job.cmdType),
  ...jobInput.shape,
});
const jobMessage = z.discriminatedUnion("_tag", [
  z.object({ _tag: z.literal("start"), ...jobInput.shape }),
  z.object({
    _tag: z.literal(job.okType),
    cmd: jobCommand,
    value: jobOk,
    at: z.number(),
  }),
  z.object({
    _tag: z.literal(job.errType),
    cmd: jobCommand,
    at: z.number(),
    error: z.object({ _tag: z.enum(["unavailable", "malformed_result"]) }),
  }),
]);
export const jobStore = (journal: Journal) =>
  eventSourcedStore(journal, {
    state: jobState,
    message: jobMessage,
    command: jobCommand,
  });
export const jobMachine = () =>
  defineMachine({
    types: {
      model: {} as JobState,
      msg: {} as { readonly _tag: "start"; readonly value: number },
    },
    cmds: [job],
    init: (loaded) => [loaded ?? { started: [], settled: [] }, []],
    update: {
      start: (s, m) => [
        { ...s, started: [...s.started, m.value] },
        [job({ value: m.value })],
      ],
      job_ok: (s, m) => [
        { ...s, settled: [...s.settled, `ok:${m.cmd.value}`] },
        [],
      ],
      job_err: (s, m) => [{ ...s, settled: [...s.settled, m.error._tag] }, []],
    },
  });
export type JobHandler = InterpretCell<JobMsg, Job, NoCtx>;
export type JobBoot = (
  store: ReturnType<typeof jobStore> | undefined,
  handle: JobHandler,
  errors?: { error: unknown; phase: string }[],
) => Promise<{
  dispatch(msg: JobMsg): Promise<void>;
  stop(): Promise<void>;
  getState(): JobState;
  live(): { subs: number; cmds: number };
}>;

const answerState = z.object({
  calls: z.array(z.number()),
  answers: z.array(z.string()),
  fired: z.array(z.string()),
  due: z.array(z.object({ id: z.string(), atMs: z.number() })),
});
type AnswerState = z.infer<typeof answerState>;
export type AnswerMsg =
  | { readonly _tag: "tick"; readonly call: number }
  | { readonly _tag: "start"; readonly value: number }
  | ReturnType<typeof deadlineExceeded<undefined>>
  | Settled<typeof job>;
const answerDeadlines = (s: AnswerState) =>
  s.due.map(({ id, atMs }) => deadlineSub(id, atMs));
export const answerMachine = (reject = false) =>
  defineMachine({
    types: {
      model: {} as AnswerState,
      msg: {} as Exclude<AnswerMsg, Settled<typeof job>>,
      sub: {} as DeadlinesSub,
    },
    cmds: [job],
    init: (loaded) => [
      loaded ?? { calls: [], answers: [], fired: [], due: [] },
      [],
    ],
    update: {
      tick: (s, m) => [
        {
          ...s,
          calls: [...s.calls, m.call],
          due:
            m.call % 7 === 0 && m.call < 45
              ? [...s.due, { id: `d-${m.call}`, atMs: m.call + 2 }]
              : s.due,
        },
        [],
      ],
      start: (s, m) => [s, [job({ value: m.value })]],
      job_ok: (s, m) => {
        if (reject) throw new Error("answer reducer rejected");
        return [
          { ...s, answers: [...s.answers, `ok:${m.cmd.value}:${m.value}`] },
          [],
        ];
      },
      job_err: (s, m) => [
        { ...s, answers: [...s.answers, `err:${m.cmd.value}:${m.error._tag}`] },
        [],
      ],
      deadline_exceeded: (s, m) => [
        {
          ...s,
          fired: [...s.fired, m.id],
          due: s.due.filter((d) => d.id !== m.id),
        },
        [],
      ],
    },
    subs: [deadlinesSub(answerDeadlines)],
  });
export const answerStore = (journal: Journal) =>
  eventSourcedStore(journal, {
    state: answerState,
    message: z.union([
      jobMessage,
      z.object({ _tag: z.literal("tick"), call: z.number() }),
      z.object({
        _tag: z.literal("deadline_exceeded"),
        id: z.string(),
        atMs: z.number(),
      }),
    ]),
    command: jobCommand,
  });
type AnswerHost = {
  dispatch(msg: AnswerMsg, options?: DispatchOptions): Promise<void>;
  stop(): Promise<void>;
  getState(): AnswerState;
  live(): { subs: number; cmds: number };
};
export type AnswerBoot = (
  store: ReturnType<typeof answerStore> | undefined,
  handle: JobHandler,
  reject?: boolean,
  beforeReady?: (host: Pick<AnswerHost, "dispatch">) => Promise<void>,
) => Promise<AnswerHost>;

export function answerHostTests(
  engine: "promise" | "effect",
  boot: AnswerBoot,
) {
  describe(
    `${engine}: later answers are delivery receipts`,
    { timeout: 30_000 },
    () => {
      it.each(
        [true, false].flatMap((answerAdmitted) =>
          [true, false].map((liveLedger) => ({ answerAdmitted, liveLedger })),
        ),
      )("F1: checks the ledger before each wake hand-out (%j)", async ({
        answerAdmitted,
        liveLedger,
      }) => {
        const journal = memoryJournal();
        const store = answerStore(journal);
        const initial = await boot(store, async () => owed());
        await initial.dispatch({ _tag: "start", value: 1 });
        await initial.dispatch({ _tag: "start", value: 2 });
        await initial.stop();
        const deliveries = logLedger(await store.readLog()).surviving();
        expect(deliveries.map(({ id }) => id)).toEqual([1, 2]);
        const second = deliveries[1];
        if (!second) throw new Error("missing second delivery");
        let release!: () => void;
        let entered!: () => void;
        let acknowledge!: () => void;
        const paused = new Promise<void>((resolve) => {
          release = resolve;
        });
        const started = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const admitted = new Promise<void>((resolve) => {
          acknowledge = resolve;
        });
        const wakeStore = answerStore(journal);
        const observing: typeof wakeStore = {
          ...wakeStore,
          appendMessage: async (message) => {
            const result = await wakeStore.appendMessage(message);
            if (message.answerTo === second.id) acknowledge();
            return result;
          },
        };
        if (!liveLedger) Reflect.deleteProperty(observing, readDeliveryLedger);
        const seen: number[] = [];
        let wake: AnswerHost | undefined;
        try {
          wake = await boot(
            observing,
            async (_cmd, ctx) => {
              const id = deliveryIdOf(ctx);
              if (id === undefined) throw new Error("missing delivery id");
              seen.push(id);
              if (id === 1) {
                entered();
                await paused;
              }
              return owed();
            },
            false,
            async (booting) => {
              await started;
              let sending: Promise<void> | undefined;
              try {
                if (answerAdmitted) {
                  sending = booting.dispatch(job.ok(second.effect, 20, 1), {
                    answerTo: second.id,
                  });
                  await admitted;
                  expect(
                    logLedger(await wakeStore.readLog())
                      .surviving()
                      .map(({ id }) => id),
                  ).toEqual([1]);
                }
              } finally {
                release();
              }
              await sending;
            },
          );
          expect(seen.filter((id) => id === 2)).toEqual(
            answerAdmitted ? [] : [2],
          );
          expect(logLedger(await wakeStore.readLog()).surviving()).toEqual(
            answerAdmitted ? deliveries.slice(0, 1) : deliveries,
          );
          expect(wake.getState().answers).toEqual(
            answerAdmitted ? ["ok:2:20"] : [],
          );
        } finally {
          release();
          await wake?.stop();
          await journal.close();
        }
      });

      it.each([
        "memory",
        "file",
      ] as const)("50 closed calls answer jobs 1 to 5 calls later on %s", async (driver) => {
        const disk = await storage(driver);
        const pending = new Map<
          number,
          { id: number; effect: Job; due: number }
        >();
        const answered = new Set<number>();
        const history: { msg: AnswerMsg; options: DispatchOptions }[] = [];
        let last: AnswerState | undefined;
        let repeats = 0;
        let handoffs = 0;
        try {
          for (let call = 0; call < 50; call += 1) {
            const sample = await measured(async () => {
              const journal = disk.open();
              const store = answerStore(journal);
              const seen: OwedEffect<Job>[] = [];
              const before = [...pending.values()].map(({ id, effect }) => ({
                id,
                effect,
              }));
              const host = await boot(store, async (cmd, ctx) => {
                const id = deliveryIdOf(ctx);
                if (id === undefined) throw new Error("missing delivery id");
                expect(
                  answered.has(id),
                  "already answered id was re-handed",
                ).toBe(false);
                seen.push({ id, effect: cmd });
                if (pending.has(id)) repeats += 1;
                else {
                  handoffs += 1;
                  pending.set(id, {
                    id,
                    effect: cmd,
                    due: call + 1 + (cmd.value % 5),
                  });
                }
                return owed();
              });
              try {
                expect(seen).toEqual(before);
                if (last) expect(host.getState()).toEqual(last);
                const send = async (
                  msg: AnswerMsg,
                  options: DispatchOptions,
                ) => {
                  await host.dispatch(msg, options);
                  history.push({ msg, options });
                };
                await send({ _tag: "tick", call }, { id: `tick-${call}` });
                if (call % 5 === 0 && call <= 40)
                  await send(
                    { _tag: "start", value: call / 5 },
                    { id: `job-${call}` },
                  );
                for (const d of answerDeadlines(host.getState()).filter(
                  (d) => d.atMs <= call,
                ))
                  await send(deadlineExceeded(d.id, d.atMs), {
                    id: `deadline-${d.id}`,
                  });
                for (const [id, entry] of pending) {
                  if (entry.due > call) continue;
                  const msg =
                    entry.effect.value % 3 === 2
                      ? job.err(entry.effect, { _tag: "unavailable" }, call)
                      : job.ok(entry.effect, entry.effect.value * 10, call);
                  await send(msg, { answerTo: id });
                  pending.delete(id);
                  answered.add(id);
                }
                await host.stop();
                expect(host.live()).toEqual({ subs: 0, cmds: 0 });
                expect(logLedger(await store.readLog()).surviving()).toEqual(
                  [...pending.values()].map(({ id, effect }) => ({
                    id,
                    effect,
                  })),
                );
                last = host.getState();
              } finally {
                await host.stop();
                await journal.close();
              }
            });
            expect(sample.resources, `call ${call}`).toEqual(emptyResources);
            if (engine === "effect")
              expect(sample.startedFibers).toBeGreaterThan(0);
          }
          expect(disk.closed()).toBe(50);
          expect(handoffs).toBe(9);
          expect(repeats).toBe(25);
          expect(answered.size).toBe(9);
          expect(pending.size).toBe(0);
          expect(last).toEqual({
            calls: Array.from({ length: 50 }, (_, i) => i),
            answers: [
              "ok:0:0",
              "ok:1:10",
              "err:2:unavailable",
              "ok:3:30",
              "ok:4:40",
              "err:5:unavailable",
              "ok:6:60",
              "ok:7:70",
              "err:8:unavailable",
            ],
            fired: ["d-0", "d-7", "d-14", "d-21", "d-28", "d-35", "d-42"],
            due: [],
          });
          const controlDisk = await storage(driver);
          const controlJournal = controlDisk.open();
          const controlStore = answerStore(controlJournal);
          const control = await boot(controlStore, async () => owed());
          try {
            for (const { msg, options } of history)
              await control.dispatch(msg, options);
            expect(control.getState()).toEqual(last);
            expect(logLedger(await controlStore.readLog()).surviving()).toEqual(
              [],
            );
          } finally {
            await control.stop();
            await controlJournal.close();
            await controlDisk.remove();
          }
          console.info(
            JSON.stringify({
              engine,
              driver,
              calls: 50,
              handoffs,
              repeats,
              answers: answered.size,
              deadlines: last?.fired.length,
              owed: pending.size,
            }),
          );
        } finally {
          await disk.remove();
        }
      });
      it("admits the first answer once, ignores conflicting repeats hot and cold, and refuses unknown ids", async () => {
        const journal = memoryJournal();
        const store = answerStore(journal);
        let handed = 0;
        const handle: JobHandler = async () => {
          handed += 1;
          return owed();
        };
        const host = await boot(store, handle);
        try {
          await host.dispatch({ _tag: "start", value: 7 });
          const entry = logLedger(await store.readLog()).surviving()[0];
          if (!entry) throw new Error("missing owed delivery");
          const before = await store.readLog();
          await expect(
            host.dispatch(job.ok(entry.effect, 1, 1), { answerTo: 999 }),
          ).rejects.toThrow("Answer id is not owed");
          expect(await store.readLog()).toEqual(before);
          await host.dispatch(job.ok(entry.effect, 1, 1), {
            answerTo: entry.id,
          });
          expect(host.getState().answers).toEqual(["ok:7:1"]);
          expect(logLedger(await store.readLog()).surviving()).toEqual([]);
          const admitted = await store.readLog();
          const messages = admitted.records.filter(
            ({ record }) =>
              record._tag === "message" && record.answerTo === entry.id,
          );
          expect(messages).toHaveLength(1);
          expect(
            admitted.records.filter(
              ({ record }) => record._tag === "confirmed",
            ),
          ).toEqual([]);
          await host.dispatch(job.ok(entry.effect, 99, 2), {
            answerTo: entry.id,
          });
          expect(await store.readLog()).toEqual(admitted);
          expect(host.getState().answers).toEqual(["ok:7:1"]);
          await host.stop();
          const wake = await boot(answerStore(journal), handle);
          try {
            await wake.dispatch(
              job.err(entry.effect, { _tag: "unavailable" }, 3),
              { answerTo: entry.id },
            );
            expect(await store.readLog()).toEqual(admitted);
            expect(wake.getState().answers).toEqual(["ok:7:1"]);
            expect(handed).toBe(1);
          } finally {
            await wake.stop();
          }
        } finally {
          await host.stop();
          await journal.close();
        }
      });

      it.each([
        [
          "wrong builder tag",
          (cmd: Job) => ({ ...job.ok(cmd, 1, 1), _tag: "other_ok" }),
          "Answer tag mismatch",
        ],
        [
          "ok schema",
          (cmd: Job) => ({ ...job.ok(cmd, 1, 1), value: "bad" }),
          "Answer value rejected",
        ],
        [
          "undeclared err",
          (cmd: Job) => ({
            ...job.err(cmd, { _tag: "unavailable" }, 1),
            error: { _tag: "alien" },
          }),
          "undeclared",
        ],
        [
          "different Cmd",
          (cmd: Job) => job.ok({ ...cmd, value: 999 }, 1, 1),
          "Answer Cmd mismatch",
        ],
        [
          "nonfinite timestamp",
          (cmd: Job) => job.ok(cmd, 1, Number.NaN),
          "Answer timestamp rejected",
        ],
      ] as const)("refuses %s without writing, then admits a corrected answer on the same activation", async (_name, malformed, reason) => {
        const journal = memoryJournal();
        const store = answerStore(journal);
        const host = await boot(store, async () => owed());
        try {
          await host.dispatch({ _tag: "start", value: 1 });
          const entry = logLedger(await store.readLog()).surviving()[0];
          if (!entry) throw new Error("missing owed delivery");
          const before = await store.readLog();
          // The host receives untrusted transport data; bypass only the caller's type here.
          await expect(
            host.dispatch(malformed(entry.effect) as AnswerMsg, {
              answerTo: entry.id,
            }),
          ).rejects.toThrow(reason);
          expect(await store.readLog()).toEqual(before);
          expect(host.getState().answers).toEqual([]);
          await host.dispatch(job.ok(entry.effect, 2, 2), {
            answerTo: entry.id,
          });
          expect(host.getState().answers).toEqual(["ok:1:2"]);
          expect(logLedger(await store.readLog()).surviving()).toEqual([]);
        } finally {
          await host.stop();
          await journal.close();
        }
      });

      it("preserves admission order when a later answer and an ordinary input arrive together", async () => {
        const journal = memoryJournal();
        const store = answerStore(journal);
        const host = await boot(store, async () => owed());
        try {
          await host.dispatch({ _tag: "start", value: 1 });
          await Promise.all([
            host.dispatch(job.ok(job({ value: 1 }), 10, 1), { answerTo: 1 }),
            host.dispatch({ _tag: "tick", call: 1 }, { id: "next" }),
          ]);
          expect(host.getState().answers).toEqual(["ok:1:10"]);
          expect(host.getState().calls).toEqual([1]);
          const messages = (await store.readLog()).records.flatMap(
            ({ record }) =>
              record._tag === "message" ? [record.msg._tag] : [],
          );
          expect(messages).toEqual(["start", "job_ok", "tick"]);
        } finally {
          await host.stop();
          await journal.close();
        }
      });

      it("ordinary caller ids cannot receipt a delivery, while answerTo can; identical Cmds keep distinct ids and answer out of order", async () => {
        const journal = memoryJournal();
        const store = answerStore(journal);
        const host = await boot(store, async () => owed());
        try {
          await host.dispatch({ _tag: "start", value: 4 });
          await host.dispatch({ _tag: "start", value: 4 });
          const entries = logLedger(await store.readLog()).surviving();
          const [first, second] = entries;
          if (!first || !second) throw new Error("missing deliveries");
          expect(first.effect).toEqual(second.effect);
          expect(first.id).not.toBe(second.id);
          await host.dispatch(job.ok(first.effect, 10, 1), {
            id: String(first.id),
          });
          expect(logLedger(await store.readLog()).surviving()).toEqual(entries);
          await host.dispatch(
            job.err(second.effect, { _tag: "unavailable" }, 2),
            { answerTo: second.id },
          );
          expect(logLedger(await store.readLog()).surviving()).toEqual([first]);
          await host.dispatch(job.ok(first.effect, 20, 3), {
            answerTo: first.id,
          });
          expect(logLedger(await store.readLog()).surviving()).toEqual([]);
          expect(host.getState().answers).toEqual([
            "ok:4:10",
            "err:4:unavailable",
            "ok:4:20",
          ]);
        } finally {
          await host.stop();
          await journal.close();
        }
      });

      it("refuses answerTo with a caller id or without a log, and accepts ordinary dispatch", async () => {
        const journal = memoryJournal();
        const store = answerStore(journal);
        const host = await boot(store, async () => owed());
        const plain = await boot(undefined, async () => Outcome.ok(1));
        try {
          const before = await store.readLog();
          await expect(
            host.dispatch(
              { _tag: "tick", call: 0 },
              { answerTo: 1, id: "caller" },
            ),
          ).rejects.toThrow("An answer cannot also set id");
          expect(await store.readLog()).toEqual(before);
          await expect(
            plain.dispatch({ _tag: "tick", call: 0 }, { answerTo: 1 }),
          ).rejects.toThrow("An answer needs a logged store");
          expect(plain.getState().calls).toEqual([]);
          await plain.dispatch({ _tag: "tick", call: 0 });
          expect(plain.getState().calls).toEqual([0]);
          await host.dispatch({ _tag: "tick", call: 0 }, { id: "caller" });
          expect(host.getState().calls).toEqual([0]);
        } finally {
          await host.stop();
          await plain.stop();
          await journal.close();
        }
      });

      it.each([
        0,
        -1,
        1.5,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        Number.MAX_SAFE_INTEGER + 1,
      ])("refuses invalid delivery id %s before writing and permits retry", async (id) => {
        const journal = memoryJournal();
        const store = answerStore(journal);
        const host = await boot(store, async () => owed());
        try {
          await host.dispatch({ _tag: "start", value: 1 });
          const before = await store.readLog();
          await expect(
            host.dispatch(job.ok(job({ value: 1 }), 1, 1), { answerTo: id }),
          ).rejects.toThrow("Invalid answer delivery id");
          expect(await store.readLog()).toEqual(before);
          await host.dispatch(job.ok(job({ value: 1 }), 1, 1), { answerTo: 1 });
          expect(logLedger(await store.readLog()).surviving()).toEqual([]);
        } finally {
          await host.stop();
          await journal.close();
        }
      });

      it.each([
        false,
        true,
      ])("an admitted answer replays after a cut before folding (reducer rejects: %s), without re-handing the Cmd", async (reject) => {
        const journal = memoryJournal();
        const store = answerStore(journal);
        const host = await boot(store, async () => owed());
        await host.dispatch({ _tag: "start", value: 8 });
        await host.stop();
        const delivery = logLedger(await store.readLog()).surviving()[0];
        if (!delivery) throw new Error("missing delivery");
        // Cut the real engine after its admission has reached the real journal.
        const cut = new Error("cut after answer admission");
        const cuttingStore: ReturnType<typeof answerStore> = {
          ...answerStore(journal),
          appendMessage: async (message) => {
            const result = await store.appendMessage(message);
            if (message.answerTo !== undefined) throw cut;
            return result;
          },
        };
        const interrupted = await boot(cuttingStore, async () => owed());
        try {
          await expect(
            interrupted.dispatch(job.ok(delivery.effect, 80, 2), {
              answerTo: delivery.id,
            }),
          ).rejects.toBeDefined();
          await interrupted.stop();
          expect(interrupted.getState().answers).toEqual([]);
          expect(
            logLedger(await answerStore(journal).readLog()).surviving(),
          ).toEqual([]);
          let calls = 0;
          const waking = boot(
            answerStore(journal),
            async () => {
              calls += 1;
              return owed();
            },
            reject,
          );
          if (reject)
            await expect(waking).rejects.toThrow("answer reducer rejected");
          else {
            const wake = await waking;
            await wake.stop();
            expect(wake.getState().answers).toEqual(["ok:8:80"]);
          }
          expect(calls).toBe(0);
          const log = await answerStore(journal).readLog();
          expect(log.records.at(-1)?.record).toMatchObject(
            reject
              ? {
                  _tag: "receipt",
                  disposition: "rejected",
                  failure: { kind: "reduce" },
                }
              : { _tag: "applied" },
          );
          const again = await boot(answerStore(journal), async () => {
            throw new Error("answered delivery repeated");
          });
          await again.stop();
          expect(again.getState().answers).toEqual(reject ? [] : ["ok:8:80"]);
        } finally {
          await interrupted.stop();
          await journal.close();
        }
      });
    },
  );
}

export function owedHostTests(engine: "promise" | "effect", boot: JobBoot) {
  describe(`${engine}: hand work back as data`, () => {
    it.each([
      "memory",
      "file",
    ] as const)("20 calls retain owed jobs on %s", async (driver) => {
      const disk = await storage(driver);
      let surviving: readonly OwedEffect<Job>[] = [];
      let repeats = 0;
      let handedBack = 0;
      try {
        for (let call = 0; call < 20; call += 1) {
          const before = surviving;
          const seen: OwedEffect<Job>[] = [];
          const errors: { error: unknown; phase: string }[] = [];
          const sample = await measured(async () => {
            const journal = disk.open();
            const store = jobStore(journal);
            const host = await boot(
              store,
              async (cmd, ctx) => {
                const id = deliveryIdOf(ctx);
                expect(id).toBeTypeOf("number");
                if (id === undefined) throw new Error("missing delivery id");
                const delivery = { id, effect: cmd };
                seen.push(delivery);
                if (cmd.value % 4 === 0) return owed();
                return Outcome.ok(cmd.value);
              },
              errors,
            );
            try {
              expect(seen).toEqual(before);
              repeats += seen.length;
              await host.dispatch({ _tag: "start", value: call });
              expect(seen.slice(0, -1)).toEqual(before);
              expect(seen.at(-1)?.effect).toEqual(job({ value: call }));
              const latest = seen.at(-1);
              expect(latest).toBeDefined();
              if (call % 4 === 0 && latest) {
                surviving = [...before, latest];
                handedBack += 1;
              }
              await host.stop();
              expect(host.live()).toEqual({ subs: 0, cmds: 0 });
              expect(logLedger(await store.readLog()).surviving()).toEqual(
                surviving,
              );
              expect(host.getState()).toEqual({
                started: Array.from({ length: call + 1 }, (_, i) => i),
                settled: Array.from({ length: call + 1 }, (_, i) => i)
                  .filter((i) => i % 4 !== 0)
                  .map((i) => `ok:${i}`),
              });
              expect(errors).toEqual([]);
            } finally {
              await host.stop();
              await journal.close();
            }
          });
          expect(sample.resources, `call ${call}`).toEqual(emptyResources);
          if (engine === "effect")
            expect(sample.startedFibers).toBeGreaterThan(0);
        }
        expect(disk.closed()).toBe(20);
        expect(handedBack).toBe(5);
        expect(repeats).toBe(55);
        expect(new Set(surviving.map(({ id }) => id)).size).toBe(5);
      } finally {
        await disk.remove();
      }
    });

    it.each([
      ["Ok", Outcome.ok(7), ["ok:7"]],
      ["Err", Outcome.err({ _tag: "unavailable" as const }), ["unavailable"]],
      ["an Owed-shaped Ok", Outcome.ok({ _tag: "Owed" as const }), ["ok:7"]],
    ] as const)("confirms %s and never re-hands it", async (_name, answer, settled) => {
      const journal = memoryJournal();
      const errors: { error: unknown; phase: string }[] = [];
      let calls = 0;
      const handle: JobHandler = async () => {
        calls += 1;
        return answer;
      };
      const store = jobStore(journal);
      const host = await boot(store, handle, errors);
      try {
        await host.dispatch({ _tag: "start", value: 7 });
        await host.stop();
        expect(host.getState().settled).toEqual(settled);
        expect(logLedger(await store.readLog()).surviving()).toEqual([]);
        const wake = await boot(jobStore(journal), handle, errors);
        await wake.stop();
        expect(calls).toBe(1);
        expect(errors).toEqual([]);
      } finally {
        await host.stop();
        await journal.close();
      }
    });

    it("refuses owed without a log through the interpret error sink", async () => {
      const errors: { error: unknown; phase: string }[] = [];
      const host = await boot(undefined, async () => owed(), errors);
      try {
        await host.dispatch({ _tag: "start", value: 1 });
        expect(host.getState().settled).toEqual([]);
        expect(errors).toHaveLength(1);
        expect(errors[0]?.phase).toBe("interpret");
        expect(errors[0]?.error).toEqual(
          new Error("Owed requires a logged invocation"),
        );
      } finally {
        await host.stop();
      }
    });

    it("clears a handed-back entry only through the store's existing confirmation", async () => {
      const journal = memoryJournal();
      const store = jobStore(journal);
      const host = await boot(store, async () => owed());
      try {
        await host.dispatch({ _tag: "start", value: 1 });
        await host.stop();
        const pending = logLedger(await store.readLog()).surviving();
        expect(pending).toHaveLength(1);
        const entry = pending[0];
        if (!entry) throw new Error("missing owed delivery");
        await store.confirmEffect(entry.id);
        const wake = await boot(jobStore(journal), async () => {
          throw new Error("confirmed work repeated");
        });
        await wake.stop();
        expect(logLedger(await store.readLog()).surviving()).toEqual([]);
      } finally {
        await host.stop();
        await journal.close();
      }
    });
  });
}

export function perCallHostTests(engine: "promise" | "effect", boot: Boot) {
  describe(`${engine}: a completed activation ends`, () => {
    it("confirms a void return without a Msg and never re-hands it", async () => {
      const journal = memoryJournal();
      const store = storeFor(journal);
      let calls = 0;
      const handle = async () => {
        calls += 1;
        return undefined;
      };
      const host = await boot(store, { handle });
      try {
        await host.dispatch({ _tag: "step", call: 1, part: 0 });
        await host.stop();
        expect(host.getState().completed).toEqual([]);
        expect(logLedger(await store.readLog()).surviving()).toEqual([]);
        const wake = await boot(storeFor(journal), { handle });
        await wake.stop();
        expect(calls).toBe(1);
      } finally {
        await host.stop();
        await journal.close();
      }
    });

    it.each([
      "memory",
      "file",
    ] as const)("50 calls on fresh %s journal handles equal one continuous history", async (driver) => {
      const disk = await storage(driver);
      const history: { msg: Msg; id: string }[] = [];
      const counts = [];
      let last: State | undefined;
      let next: number | null = null;
      try {
        for (let call = 0; call < 50; call += 1) {
          const sample = await measured(async () => {
            const journal = disk.open();
            const host = await boot(storeFor(journal));
            try {
              if (last) expect(host.getState()).toEqual(last);
              expect(nextDeadline(host.getState())).toBe(next);
              const messages: Msg[] = [
                { _tag: "step", call, part: 0 },
                ...Array.from({ length: call % 2 }, () => ({
                  _tag: "step" as const,
                  call,
                  part: 1,
                })),
                ...deadlinesFor(host.getState())
                  .filter((d) => d.atMs <= 1_000_000 + call * 1000)
                  .map((d) => deadlineExceeded(d.id, d.atMs)),
              ];
              expect(messages.length).toBeGreaterThanOrEqual(1);
              expect(messages.length).toBeLessThanOrEqual(3);
              for (const [i, msg] of messages.entries()) {
                const id = `call-${call}-${i}`;
                await host.dispatch(msg, { id });
                history.push({ msg, id });
              }
              await host.stop();
              expect(host.live()).toEqual({ subs: 0, cmds: 0 });
              last = host.getState();
              next = nextDeadline(last);
            } finally {
              await host.stop();
              await journal.close();
            }
          });
          counts.push(sample.resources);
          expect.soft(sample.resources, `call ${call}`).toEqual(emptyResources);
          if (engine === "effect")
            expect(sample.startedFibers).toBeGreaterThan(0);
        }
        expect(disk.closed()).toBe(50);
        expect(last?.steps).toHaveLength(75);
        expect(last?.completed).toEqual(last?.steps);
        expect(last?.fired).toHaveLength(7);
        expect(next).toBe(1_051_000);
        console.info(JSON.stringify({ engine, driver, calls: counts }));

        const controlDisk = await storage(driver);
        const journal = controlDisk.open();
        const control = await boot(storeFor(journal));
        try {
          for (const { msg, id } of history)
            await control.dispatch(msg, { id });
          await control.stop();
          expect(control.getState()).toEqual(last);
        } finally {
          await control.stop();
          await journal.close();
          await controlDisk.remove();
        }
      } finally {
        await disk.remove();
      }
    });

    it("clears a losing stop timer after a completed handler and cancels the built-in timer", async () => {
      const sample = await measured(async () => {
        const journal = memoryJournal();
        const host = await boot(storeFor(journal), { timer: true });
        await host.dispatch({ _tag: "step", call: 0, part: 0 });
        await host.stop();
        expect(host.getState().completed).toEqual([0]);
        expect(host.live()).toEqual({ subs: 0, cmds: 0 });
        await journal.close();
      });
      expect(sample.resources).toEqual(emptyResources);
    });

    it("waits for async subscription disposal without leaving a drain Promise", async () => {
      let disposed = false;
      const sample = await measured(async () => {
        const journal = memoryJournal();
        const host = await boot(storeFor(journal), {
          dispose: async () => {
            await sleep(1);
            disposed = true;
          },
        });
        await host.dispatch({ _tag: "step", call: 0, part: 0 });
        await host.stop();
        expect(disposed).toBe(true);
        expect(host.live()).toEqual({ subs: 0, cmds: 0 });
        await journal.close();
      });
      expect(sample.resources).toEqual(emptyResources);
    });
  });
}
