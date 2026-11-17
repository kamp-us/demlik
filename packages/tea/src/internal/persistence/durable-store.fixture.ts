import { afterEach, vi } from "vitest";
import type { Cmd } from "../../pure/core";
import {
  type EventSourcedOptions,
  isFencedStore,
  type LoggedStore,
} from "../../runtime-types";
import {
  type FencedJournal,
  type Journal,
  type JournalAppend,
  memoryJournal,
} from "../journal";
import { createLogStore } from "./log-store";

declare const storageBrand: unique symbol;
/** Opaque storage, compared by its retained bytes in existing assertions. */
export interface DurableStorage {
  readonly [storageBrand]: true;
}
export interface StoredLog {
  readonly frames: readonly string[];
  readonly checkpoint?: string;
}
/** Called after a physical write; returning true cuts that activation. */
export type StorageWrite = (bytes: string) => boolean;
export class Dropped extends Error {}
export type StorageFactory = (
  entries?: Iterable<readonly [string, string]>,
  write?: StorageWrite,
) => DurableStorage;
export type FixtureJournal = { open(): Journal; dispose(): void };
type Selection = { make(): FixtureJournal; fenced: boolean };
const memory: Selection = {
  make() {
    const journal = memoryJournal();
    return { open: () => journal, dispose() {} };
  },
  fenced: false,
};
export function journalStorage(
  make: () => FixtureJournal,
  options: { fenced?: boolean } = {},
): StorageFactory {
  const selection = { make, fenced: options.fenced === true };
  return (entries = [], write) => new Disk(entries, write, selection);
}

type Capture = readonly { stream: string; records: string[] }[];
type Control = {
  disk: Disk;
  closed: boolean;
  write?: StorageWrite;
  generation: number;
  selection: Selection;
  tail: Promise<void>;
  resource?: FixtureJournal;
  handle?: Journal;
  ready?: Promise<void>;
  checkpointHeads: Map<string, number>;
  snapshot?: Promise<Capture>;
};
const controls = new WeakMap<DurableStorage, Control>();
function control(storage: DurableStorage): Control {
  const state = controls.get(storage);
  if (!state) throw new Error("Unknown durable test storage");
  return state;
}
// Labels for synchronous observations only. Journal streams hold the actual storage.
const observationKey = (name = "default") => JSON.stringify([name, "records"]);
class Disk extends Map<string, string> implements DurableStorage {
  declare readonly [storageBrand]: true;
  constructor(
    entries: Iterable<readonly [string, string]>,
    write?: StorageWrite,
    selection: Selection = memory,
  ) {
    super();
    controls.set(this, {
      disk: this,
      closed: false,
      write,
      generation: 0,
      selection,
      tail: Promise.resolve(),
      checkpointHeads: new Map(),
    });
    for (const [key, bytes] of entries) this.seed(key, bytes);
  }
  seed(key: string, bytes: string): void {
    super.set(key, bytes);
    const state = control(this);
    state.generation += 1;
    state.resource = undefined;
    state.handle = undefined;
    state.ready = undefined;
    state.snapshot = undefined;
  }
  peek(key: string): string | undefined {
    return super.get(key);
  }
  override set(key: string, bytes: string) {
    const state = control(this);
    if (state.closed) throw new Dropped();
    super.set(key, bytes);
    if (state.write?.(bytes)) {
      state.closed = true;
      throw new Dropped();
    }
    return this;
  }
}
export function createStorage(
  entries: Iterable<readonly [string, string]> = [],
  write?: StorageWrite,
): DurableStorage {
  return new Disk(entries, write);
}
export function storageOf(
  log: StoredLog & { readonly name?: string },
  write?: StorageWrite,
  make: StorageFactory = createStorage,
): DurableStorage {
  const storage = make([], write);
  for (const [index, bytes] of log.frames.entries())
    seedFrame(storage, index + 1, bytes, log.name);
  if (log.checkpoint !== undefined) {
    control(storage).disk.seed(
      `${observationKey(log.name)}/checkpoint`,
      log.checkpoint,
    );
    control(storage).checkpointHeads.set(
      JSON.stringify([log.name ?? "default", "checkpoint"]),
      1,
    );
  }
  return storage;
}
export function readFrame(
  storage: DurableStorage,
  n: number,
  name = "default",
): string | undefined {
  const key = observationKey(name);
  return control(storage).disk.peek(n === 1 ? key : `${key}/${n}`);
}
export function storedLog(
  storage: DurableStorage,
  name = "default",
): StoredLog {
  const frames: string[] = [];
  for (let n = 1; ; n += 1) {
    const bytes = readFrame(storage, n, name);
    if (bytes === undefined) break;
    frames.push(bytes);
  }
  return {
    frames,
    checkpoint: control(storage).disk.peek(
      `${observationKey(name)}/checkpoint`,
    ),
  };
}
export function seedFrame(
  storage: DurableStorage,
  n: number,
  bytes: string,
  name = "default",
): void {
  const key = observationKey(name);
  control(storage).disk.seed(n === 1 ? key : `${key}/${n}`, bytes);
}
export function appendFrame(
  storage: DurableStorage,
  bytes: string,
  name = "default",
): void {
  seedFrame(storage, storedLog(storage, name).frames.length + 1, bytes, name);
}
export function storedLogs(storage: DurableStorage): ReadonlySet<string> {
  const names = new Set<string>();
  for (const key of control(storage).disk.keys()) {
    const [name, kind] = JSON.parse(key.slice(0, key.lastIndexOf("]") + 1));
    if (typeof name === "string" && kind === "records") names.add(name);
  }
  return names;
}
const queued = <T>(state: Control, use: () => Promise<T>): Promise<T> => {
  const next = state.tail.then(use);
  state.tail = next.then(
    () => {},
    () => {},
  );
  return next;
};
export function copyStorage(
  storage: DurableStorage,
  write?: StorageWrite,
): DurableStorage {
  const original = control(storage);
  const copy = new Disk(original.disk, write, original.selection);
  const target = control(copy);
  target.checkpointHeads = new Map(original.checkpointHeads);
  const resource = original.resource;
  if (resource) {
    // Capture precedes later writes even when the driver's reads yield before observing storage.
    target.snapshot = queued(original, async () => {
      const source = resource.open();
      try {
        return await Promise.all(
          [...storedLogs(storage)].flatMap((name) =>
            ["log", "checkpoint"].map(async (kind) => {
              const stream = JSON.stringify([name, kind]);
              const result = await source.read(stream, 0);
              if (result._tag !== "read")
                throw new Error(result.message, { cause: result });
              return {
                stream,
                records: result.entries.map((entry) => entry.record),
              };
            }),
          ),
        );
      } finally {
        if (source !== original.handle) await source.close();
      }
    });
  } else target.snapshot = original.snapshot;
  return copy;
}
export function onStorageWrite(
  storage: DurableStorage,
  write: (bytes: string) => void,
): void {
  control(storage).write = (bytes) => {
    write(bytes);
    return false;
  };
}
export function storageClosed(storage: DurableStorage): boolean {
  return control(storage).closed;
}
export function storageMutations(storage: DurableStorage) {
  const { disk } = control(storage);
  return {
    set: vi.spyOn(disk, "set"),
    remove: vi.spyOn(disk, "delete"),
    clear: vi.spyOn(disk, "clear"),
  };
}

export function durableLog<S, M extends { _tag: string }, C extends Cmd>(
  storage: DurableStorage,
  options: EventSourcedOptions<S, M, C>,
): ReturnType<typeof createLogStore<S, M, C>> {
  const state = control(storage);
  const ensure = async (): Promise<Journal> => {
    if (state.closed) throw new Dropped();
    if (!state.handle) {
      // Bound fixture descriptors, not the production store's cache or driver lifetime.
      if (handles.size >= 64) {
        const oldest = handles.entries().next().value;
        if (oldest) {
          const [handle, owner] = oldest;
          await handle.close();
          if (owner.handle === handle) {
            owner.handle = undefined;
            owner.ready = undefined;
          }
          handles.delete(handle);
        }
      }
      const existing = state.resource !== undefined;
      state.resource ??= state.selection.make();
      resources.add(state.resource);
      const handle = state.resource.open();
      state.handle = handle;
      state.ready = (async () => {
        if (existing) return;
        const saved: Capture = state.snapshot
          ? await state.snapshot
          : [...storedLogs(storage)].flatMap((name) => {
              const log = storedLog(storage, name);
              return [
                {
                  stream: JSON.stringify([name, "log"]),
                  records: [...log.frames],
                },
                {
                  stream: JSON.stringify([name, "checkpoint"]),
                  records: log.checkpoint === undefined ? [] : [log.checkpoint],
                },
              ];
            });
        for (const { stream, records } of saved) {
          const [first, ...rest] = records;
          if (first === undefined) continue;
          const ack = await handle.append(stream, [first, ...rest]);
          if (ack._tag !== "appended")
            throw new Error(ack.message, { cause: ack });
        }
      })();
      handles.set(handle, state);
    }
    await state.ready;
    return state.handle;
  };
  const observe = (stream: string, ack: JournalAppend): void => {
    const [name, kind] = JSON.parse(stream) as [string, "log" | "checkpoint"];
    const root = observationKey(name);
    const labels = {
      log: (seq: number) => (seq === 1 ? root : `${root}/${seq}`),
      checkpoint: () => `${root}/checkpoint`,
    } satisfies Record<typeof kind, (seq: number) => string>;
    if (kind === "checkpoint") state.checkpointHeads.set(stream, ack.head);
    for (const entry of ack.entries)
      state.disk.set(labels[kind](entry.seq), entry.record);
  };
  const driver: FencedJournal = {
    fenced: true,
    async read(stream, after) {
      return (await ensure()).read(stream, after);
    },
    append(stream, records) {
      return queued(state, async () => {
        const result = await (await ensure()).append(stream, records);
        if (result._tag === "appended") observe(stream, result);
        return result;
      });
    },
    appendFenced(stream, records, expected) {
      return queued(state, async () => {
        const handle = await ensure();
        if (!("appendFenced" in handle))
          throw new Error("Expected fenced driver");
        const result = await (handle as FencedJournal).appendFenced(
          stream,
          records,
          expected,
        );
        if (result._tag === "appended") observe(stream, result);
        return result;
      });
    },
    async close() {
      await (await ensure()).close();
    },
  };
  let live = createLogStore(driver, {
    ...options,
    fenced: state.selection.fenced,
  });
  let generation = state.generation;
  const current = () => {
    if (state.closed) throw new Dropped();
    if (generation !== state.generation) {
      live = createLogStore(driver, {
        ...options,
        fenced: state.selection.fenced,
      });
      generation = state.generation;
    }
    return live;
  };
  const store: LoggedStore<S, M, C> = {
    logged: true,
    async load() {
      return current().store.load();
    },
    async save(value) {
      return current().store.save(value);
    },
    migrate: live.store.migrate,
    async readLog() {
      return current().store.readLog();
    },
    async appendMessage(message) {
      return current().store.appendMessage(message);
    },
    async commitStep(step) {
      return current().store.commitStep(step);
    },
    async confirmEffect(id) {
      return current().store.confirmEffect(id);
    },
    async checkpoint() {
      return current().store.checkpoint();
    },
  };
  if (state.selection.fenced)
    Object.assign(store, {
      fenced: true as const,
      async loadFenced() {
        const active = current().store;
        if (!isFencedStore(active)) throw new Error("Expected fenced store");
        return active.loadFenced();
      },
      async saveFenced() {
        throw new Error("Logged State can only change through commitStep");
      },
    });
  return {
    store,
    inspect() {
      const active = current();
      const saved = storedLog(storage, options.key);
      return active.inspect({
        entries: saved.frames.map((record, i) => ({ seq: i + 1, record })),
        checkpoint: saved.checkpoint,
        checkpointHead: state.checkpointHeads.get(
          JSON.stringify([options.key ?? "default", "checkpoint"]),
        ),
      });
    },
  };
}
export function durableStore<S, M extends { _tag: string }, C extends Cmd>(
  storage: DurableStorage,
  options: EventSourcedOptions<S, M, C>,
): LoggedStore<S, M, C> {
  return durableLog(storage, options).store;
}
const resources = new Set<FixtureJournal>();
const handles = new Map<Journal, Control>();
afterEach(async () => {
  for (const handle of handles.keys()) await handle.close();
  handles.clear();
  for (const resource of resources) resource.dispose();
  resources.clear();
});
