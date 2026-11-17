import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { defineMachine, StoreConflictError } from "../../index";
import { fileJournal } from "../../node";
import { sqliteJournal } from "../../node/turn-journal.fixture";
import { eventSourcedStore } from "../../persistence";
import { type FencedJournal, type Journal, memoryJournal } from "../journal";

export const options = {
  state: z.object({ n: z.number() }),
  message: z.object({ _tag: z.literal("go") }),
  command: z.never(),
  snapshotEvery: 1,
};
const program = defineMachine({
  types: { model: {} as { n: number }, msg: {} as { _tag: "go" } },
  init: () => [{ n: 0 }, []],
  update: { go: (s) => [{ n: s.n + 1 }, []] },
});
export const birth = {
  _tag: "birth" as const,
  at: 0,
  state: { n: 0 },
  cmds: [],
  timers: [],
};
export const stream = JSON.stringify(["default", "log"]);

export type BoundaryDriver = (
  machine: typeof program,
  store: ReturnType<
    typeof eventSourcedStore<{ n: number }, { _tag: "go" }, never>
  >,
) => Promise<{
  getState(): { n: number };
  dispatch(msg: { _tag: "go" }, opts?: { id: string }): Promise<void>;
  stop(): Promise<void>;
}>;

export function boundaryContract(
  engine: string,
  runMachine: BoundaryDriver,
): void {
  describe("factory boundary", { timeout: 240_000 }, () => {
    for (const kind of ["memory", "file", "sqlite"])
      test(`A6 ${kind} ${engine}: stale writer refused through the existing logged failure path`, async () => {
        const dir = mkdtempSync(join(tmpdir(), "tea-log-store-"));
        const shared = memoryJournal({ fenced: true });
        const open = (): FencedJournal =>
          kind === "memory"
            ? shared
            : kind === "file"
              ? fileJournal(dir, { fenced: true })
              : sqliteJournal(join(dir, "journal.db"), () => {});
        const ja = open(),
          jb = open();
        const a = eventSourcedStore(ja, { ...options, fenced: true }),
          b = eventSourcedStore(jb, { ...options, fenced: true });
        try {
          await a.commitStep(birth);
          await b.readLog();
          const first = await runMachine(program, a),
            second = await runMachine(program, b);
          await first.dispatch({ _tag: "go" }, { id: "first" });
          const error = await second
            .dispatch({ _tag: "go" }, { id: "second" })
            .catch((e) => e);
          expect(error.cause).toBeInstanceOf(StoreConflictError);
          expect(error.cause.cause).toMatchObject({
            _tag: "journal_conflict",
            expected: 1,
            head: 3,
          });
          expect(first.getState()).toEqual({ n: 1 });
          expect(second.getState()).toEqual({ n: 0 });
          const before = await ja.read(stream, 0);
          const again = await second
            .dispatch({ _tag: "go" }, { id: "third" })
            .catch((e) => e);
          expect(again.cause).toBe(error.cause);
          expect(await ja.read(stream, 0)).toEqual(before);
          await first.stop();
          await second.stop();
        } finally {
          await ja.close();
          if (jb !== ja) await jb.close();
          rmSync(dir, { recursive: true, force: true });
        }
      });

    test(`${engine}: a genuinely asynchronous driver survives concurrent dispatch and cold open`, async () => {
      const base = memoryJournal();
      const pause = () =>
        new Promise<void>((resolve) => setTimeout(resolve, 0));
      const driver: Journal = {
        ...base,
        async read(stream, after) {
          await pause();
          return base.read(stream, after);
        },
        async append(stream, records) {
          await pause();
          return base.append(stream, records);
        },
      };
      const live = await runMachine(
        program,
        eventSourcedStore(driver, options),
      );
      const messages = Array.from({ length: 3 }, (_, i) => ({
        id: String(i),
        msg: { _tag: "go" as const },
      }));
      await Promise.all(
        messages.map(({ id, msg }) => live.dispatch(msg, { id })),
      );
      const model = { n: messages.length };
      expect(live.getState()).toEqual(model);
      await live.stop();
      const wake = await runMachine(
        program,
        eventSourcedStore(driver, options),
      );
      expect(wake.getState()).toEqual(model);
      await wake.stop();
    });
  });
}
