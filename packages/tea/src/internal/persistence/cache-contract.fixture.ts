import { describe, expect, test } from "vitest";
import { z } from "zod";
import { StoreConflictError } from "../../runtime-types";
import type { FencedJournal, Journal } from "../journal";
import { eventSourcedStore } from "./log-store";

export type OpenJournals = () => {
  open(): Journal;
  close(): Promise<void>;
};
const options = {
  state: z.object({ n: z.number() }),
  message: z.object({ _tag: z.literal("go") }),
  command: z.never(),
  snapshotEvery: 1,
};
const birth = {
  _tag: "birth" as const,
  at: 0,
  state: { n: 0 },
  cmds: [],
  timers: [],
};
const message = (id: string) => ({
  _tag: "message" as const,
  id,
  at: 0,
  msg: { _tag: "go" as const },
});
function counted(base: Journal) {
  const calls = { reads: 0, appends: 0 };
  const driver: Journal = {
    ...base,
    async read(s, a) {
      calls.reads++;
      return base.read(s, a);
    },
    async append(s, r) {
      calls.appends++;
      return base.append(s, r);
    },
    ...("appendFenced" in base
      ? {
          async appendFenced(
            s: string,
            r: readonly [string, ...string[]],
            head: number,
          ) {
            calls.appends++;
            return (base as FencedJournal).appendFenced(s, r, head);
          },
        }
      : {}),
  };
  return {
    driver,
    calls,
    clear() {
      calls.reads = 0;
      calls.appends = 0;
    },
  };
}
export function cacheContract(
  name: string,
  make: OpenJournals,
  fenced: boolean,
): void {
  describe(`${name} cache`, { timeout: 120_000 }, () => {
    test("loaded writer: 1,000 admissions + commits, no driver reads", async () => {
      const fixture = make();
      const c = counted(fixture.open());
      const live = fenced
        ? eventSourcedStore(c.driver as FencedJournal, {
            ...options,
            fenced: true,
          })
        : eventSourcedStore(c.driver, options);
      try {
        await live.commitStep(birth);
        expect(c.calls.reads).toBe(2);
        c.clear();
        for (let i = 0; i < 1000; i++) {
          await live.appendMessage(message(String(i)));
          await live.commitStep({
            _tag: "applied",
            sourceId: String(i),
            state: { n: i + 1 },
            cmds: [],
            timers: [],
          });
        }
        expect(c.calls).toEqual({ reads: 0, appends: 2000 });
        expect(await live.load()).toEqual({ n: 1000 });
        expect((await live.readLog()).records).toHaveLength(2001);
        expect(c.calls).toEqual({ reads: 0, appends: 2000 });
        console.info(JSON.stringify({ case: "loaded-1000", name, ...c.calls }));
        await live.appendMessage(message("checkpoint"));
        c.clear();
        await live.commitStep({
          _tag: "applied",
          sourceId: "checkpoint",
          state: { n: 1001 },
          cmds: [],
          timers: [],
        });
        expect(c.calls).toEqual({ reads: 0, appends: 1 });
        expect((await live.readLog()).snapshot?.through).toBe(2002);
        console.info(
          JSON.stringify({ case: "automatic-checkpoint", name, ...c.calls }),
        );
      } finally {
        await fixture.close();
      }
    });
    test(
      fenced
        ? "stale fence refuses, then next call rebuilds"
        : "must-fail control: plain stale writer is outside the contract",
      async () => {
        const fixture = make();
        const c = counted(fixture.open());
        const other = fixture.open();
        const first = fenced
          ? eventSourcedStore(c.driver as FencedJournal, {
              ...options,
              fenced: true,
            })
          : eventSourcedStore(c.driver, options);
        const second = fenced
          ? eventSourcedStore(other as FencedJournal, {
              ...options,
              fenced: true,
            })
          : eventSourcedStore(other, options);
        try {
          await first.commitStep(birth);
          await second.load();
          await second.appendMessage(message("other"));
          c.clear();
          const error = await first
            .appendMessage(message("stale"))
            .catch((e) => e);
          expect(c.calls).toEqual({ reads: 0, appends: 1 });
          if (fenced) {
            expect(error).toBeInstanceOf(StoreConflictError);
            expect(error.cause).toMatchObject({
              _tag: "journal_conflict",
              expected: 1,
              head: 2,
            });
            const recovered = await first.readLog();
            expect(recovered.records).toHaveLength(2);
            expect(c.calls).toEqual({ reads: 2, appends: 1 });
            expect(recovered).toEqual(
              await eventSourcedStore(other, options).readLog(),
            );
          } else {
            const requiresFence = async () =>
              expect(error).toBeInstanceOf(StoreConflictError);
            await expect(requiresFence()).rejects.toThrow();
            expect(error.message).toBe("Invalid durable log ordering");
            await expect(first.readLog()).rejects.toThrow(
              "Invalid durable log ordering",
            );
          }
          console.info(
            JSON.stringify({
              case: "stale",
              name,
              result: error.name,
              message: error.message,
              ...c.calls,
            }),
          );
        } finally {
          await fixture.close();
        }
      },
    );
    test("append failure before/after storage forces next-call recovery", async () => {
      for (const applied of [false, true]) {
        const fixture = make();
        const base = fixture.open();
        let armed = false;
        const refusal = {
          _tag: "journal_io" as const,
          operation: "append" as const,
          message: "lost acknowledgement",
          uncertain: true,
        };
        const refuse = async (append: () => ReturnType<Journal["append"]>) => {
          if (!armed) return append();
          armed = false;
          if (applied) await append();
          return refusal;
        };
        const fault: Journal = {
          ...base,
          append: (s, r) => refuse(() => base.append(s, r)),
          ...("appendFenced" in base
            ? {
                appendFenced: (
                  s: string,
                  r: readonly [string, ...string[]],
                  h: number,
                ) =>
                  refuse(
                    () =>
                      (base as FencedJournal).appendFenced(
                        s,
                        r,
                        h,
                      ) as ReturnType<Journal["append"]>,
                  ),
              }
            : {}),
        };
        const c = counted(fault);
        const live = fenced
          ? eventSourcedStore(c.driver as FencedJournal, {
              ...options,
              fenced: true,
            })
          : eventSourcedStore(c.driver, options);
        try {
          await live.commitStep(birth);
          c.clear();
          armed = true;
          await expect(
            live.appendMessage(message("uncertain")),
          ).rejects.toMatchObject({ cause: refusal });
          expect(c.calls.reads).toBe(0);
          const recovered = await live.readLog();
          expect(c.calls.reads).toBe(2);
          expect(recovered.records).toHaveLength(applied ? 2 : 1);
          expect(recovered).toEqual(
            await eventSourcedStore(base, options).readLog(),
          );
          await live.appendMessage(message("after-recovery"));
          expect(c.calls.reads).toBe(2);
        } finally {
          await fixture.close();
        }
      }
    });
  });
}
