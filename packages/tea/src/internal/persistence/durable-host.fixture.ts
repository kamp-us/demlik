/** Shared crash contract: engines translate only their handler and handle doors. */
import fc from "fast-check";
import { expect, test } from "vitest";
import { z } from "zod";
import type { DispatchOptions, LoggedStore } from "../../index";
import { appliedEffects, defineMachine, idempotentEffect } from "../../index";
import { memoryEventSourcedStore } from "../../mem";

/** Persisted uploader State schema. */
export const stateSchema = z.object({
  files: z.array(z.string()),
  uploaded: z.array(z.string()),
});
/** Uploader input and completion schemas. */
export const messageSchema = z.discriminatedUnion("_tag", [
  z.object({ _tag: z.literal("picked"), file: z.string() }),
  z.object({ _tag: z.literal("uploaded"), file: z.string() }),
]);
/** The persisted upload command schema. */
export const commandSchema = z.object({
  _tag: z.literal("upload"),
  file: z.string(),
});
/** Uploader State. */
export type State = z.infer<typeof stateSchema>;
/** Uploader input or completion message. */
export type Msg = z.infer<typeof messageSchema>;
/** Upload work handed to a receiver. */
export type Upload = z.infer<typeof commandSchema>;
/** Shared memory-log schemas for both engines. */
export const options = {
  state: stateSchema,
  message: messageSchema,
  command: commandSchema,
};
/** The uploader used by both engine contracts. */
export const machine = () =>
  defineMachine({
    types: { model: {} as State, msg: {} as Msg, cmd: {} as Upload },
    init: (loaded) => [loaded ?? { files: [], uploaded: [] }, []],
    update: {
      picked: (s, m) => [
        { ...s, files: [...s.files, m.file] },
        [{ _tag: "upload", file: m.file }],
      ],
      uploaded: (s, m) => [{ ...s, uploaded: [...s.uploaded, m.file] }, []],
    },
  });
/** The engine-neutral handle the crash harness drives. */
export interface Driven {
  dispatch(msg: Msg, opts?: DispatchOptions): Promise<void>;
  stop(): Promise<void>;
  getState(): State;
}
/** Translate one engine into the shared crash harness. */
export type Driver = (
  store: LoggedStore<State, Msg, Upload>,
  upload: (cmd: Upload) => Promise<Msg>,
) => Promise<Driven>;

class Dropped extends Error {}
class Disk extends Map<string, string> {
  closed = false;
  constructor(
    entries: Map<string, string>,
    private readonly write: () => boolean,
  ) {
    super();
    for (const [k, v] of entries) super.set(k, v);
  }
  override get(key: string) {
    if (this.closed) throw new Dropped();
    return super.get(key);
  }
  override set(key: string, bytes: string) {
    if (this.closed) throw new Dropped();
    super.set(key, bytes);
    if (this.write()) {
      this.closed = true;
      throw new Dropped();
    }
    return this;
  }
}

/** Crash after a selected acknowledged-or-uncertain physical write, including birth. */
export async function execute(
  driver: Driver,
  cut?: number | readonly number[],
  messageCount = 200,
) {
  let disk: Disk;
  let writes = 0;
  const cuts = new Set(typeof cut === "number" ? [cut] : cut);
  const crashedAt = new Set<number>();
  const attempts = new Map<string, number>();
  const effects = new Map<string, number>();
  const receipts = new Set<string>();
  let receiver = appliedEffects();
  const write = () => {
    writes += 1;
    if (cuts.has(writes)) {
      crashedAt.add(writes);
      return true;
    }
    return false;
  };
  disk = new Disk(new Map(), write);
  const boot = async (): Promise<Driven> => {
    for (;;) {
      const own = disk;
      try {
        return await driver(
          memoryEventSourcedStore(own, options),
          async (cmd) => {
            if (own.closed) throw new Dropped();
            attempts.set(cmd.file, (attempts.get(cmd.file) ?? 0) + 1);
            await receiver.run(
              idempotentEffect(cmd.file, () => {
                // Receiver atomically accepts its business key together with the effect.
                if (receipts.has(cmd.file)) return;
                effects.set(cmd.file, (effects.get(cmd.file) ?? 0) + 1);
                receipts.add(cmd.file);
              }),
            );
            if (own.closed) throw new Dropped();
            return { _tag: "uploaded", file: cmd.file };
          },
        );
      } catch (error) {
        if (!own.closed) throw error;
        disk = new Disk(new Map(own), write);
        receiver = appliedEffects();
      }
    }
  };
  let live = await boot();
  for (let index = 0; index < messageCount; index += 1) {
    const msg: Msg = { _tag: "picked", file: `file-${index}.png` };
    for (;;) {
      try {
        await live.dispatch(msg, { id: msg.file });
        if (disk.closed) throw new Dropped();
        break;
      } catch (error) {
        if (!disk.closed) throw error;
        disk = new Disk(new Map(disk), write);
        receiver = appliedEffects();
        live = await boot();
      }
    }
  }
  const final = live.getState();
  await live.stop();
  const read = memoryEventSourcedStore(new Map(disk), options);
  const log = await read.readLog();
  const expected = Array.from(
    { length: messageCount },
    (_, index) => `file-${index}.png`,
  );
  expect(final.files).toEqual(expected);
  expect(final.uploaded).toEqual(expected);
  expect(await read.load()).toEqual({ files: expected, uploaded: expected });
  const admitted = log.records.flatMap(({ record }) =>
    record._tag === "message" ? [record.msg] : [],
  );
  expect(
    admitted.filter((msg) => msg._tag === "picked").map((msg) => msg.file),
  ).toEqual(expected);
  expect(
    admitted.filter((msg) => msg._tag === "uploaded").map((msg) => msg.file),
  ).toEqual(expected);
  expect([...receipts]).toEqual(expected);
  const messages = log.records.flatMap(({ record }) =>
    record._tag === "message" ? [record.id] : [],
  );
  for (let index = 0; index < messageCount; index += 1) {
    const key = `file-${index}.png`;
    expect(messages).toContain(JSON.stringify(["caller", key]));
    expect(attempts.get(key)).toBeGreaterThanOrEqual(1);
    expect(effects.get(key)).toBe(1);
  }
  expect([...crashedAt]).toEqual([...cuts].sort((a, b) => a - b));
  return { state: final, writes, crashed: crashedAt.size > 0 };
}

/** The same independent oracle on both engines: 100 long scripts plus a short exhaustive sweep. */
export function crashContract(engine: string, driver: Driver): void {
  let reference: ReturnType<typeof execute> | undefined;
  // Ten independently seeded batches keep each default-timeout test small; all 100 runs still drive 200 messages.
  test.each(
    Array.from({ length: 10 }, (_, index) => index),
  )(`T2 ${engine}: 200 messages, 10 crash scripts, batch %i of 10`, async (batch) => {
    reference ??= execute(driver);
    const baseline = await reference;
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(fc.integer({ min: 1, max: baseline.writes }), {
          minLength: 1,
          maxLength: 3,
        }),
        async (cuts) => {
          const recovered = await execute(driver, cuts);
          expect(recovered.crashed).toBe(true);
          expect(recovered.state).toEqual(baseline.state);
        },
      ),
      { numRuns: 10, seed: (fc.readConfigureGlobal().seed ?? 42) + batch },
    );
  });
  test(`T2 ${engine}: 12 messages, crash after every single store write`, async () => {
    const baseline = await execute(driver, undefined, 12);
    for (let cut = 1; cut <= baseline.writes; cut += 1)
      await execute(driver, cut, 12);
  });
}
