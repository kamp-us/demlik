/** Shared crash contract: engines translate only their handler and handle doors. */
import { expect } from "vitest";
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
export async function execute(driver: Driver, cut?: number) {
  let disk: Disk;
  let writes = 0;
  let crashed = false;
  const attempts = new Map<string, number>();
  const effects = new Map<string, number>();
  let receiver = appliedEffects();
  const write = () => {
    writes += 1;
    if (!crashed && cut === writes) {
      crashed = true;
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
                if (!effects.has(cmd.file)) effects.set(cmd.file, 1);
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
  for (let index = 0; index < 200; index += 1) {
    const msg: Msg = { _tag: "picked", file: `file-${index}.png` };
    try {
      await live.dispatch(msg, { id: msg.file });
      if (disk.closed) throw new Dropped();
    } catch (error) {
      if (!disk.closed) throw error;
      disk = new Disk(new Map(disk), write);
      receiver = appliedEffects();
      live = await boot();
      await live.dispatch(msg, { id: msg.file });
    }
  }
  const final = live.getState();
  await live.stop();
  const read = memoryEventSourcedStore(new Map(disk), options);
  const log = await read.readLog();
  expect(await read.load()).toEqual(final);
  const messages = log.records.flatMap(({ record }) =>
    record._tag === "message" ? [record.id] : [],
  );
  for (let index = 0; index < 200; index += 1) {
    const key = `file-${index}.png`;
    expect(messages).toContain(JSON.stringify(["caller", key]));
    expect(attempts.get(key)).toBeGreaterThanOrEqual(1);
    expect(effects.get(key)).toBe(1);
  }
  return { state: final, writes, crashed };
}
