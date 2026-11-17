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
import { defineMachine, type LoggedStore, type TimerSub } from "../../index";
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

export function perCallHostTests(engine: "promise" | "effect", boot: Boot) {
  describe(`${engine}: a completed activation ends`, () => {
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
