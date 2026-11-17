import { vi } from "vitest";
import type { Cmd } from "../../pure/core";
import type { EventSourcedOptions, LoggedStore } from "../../runtime-types";
import { logKey } from "./durable-log/format";
import { memoryLog } from "./durable-log/memory-log";

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

const controls = new WeakMap<
  DurableStorage,
  { disk: Disk; closed: boolean; write?: StorageWrite }
>();
function control(storage: DurableStorage) {
  const state = controls.get(storage);
  if (!state) throw new Error("Unknown durable test storage");
  return state;
}

class Disk extends Map<string, string> implements DurableStorage {
  declare readonly [storageBrand]: true;
  constructor(
    entries: Iterable<readonly [string, string]>,
    write?: StorageWrite,
  ) {
    super();
    controls.set(this, { disk: this, closed: false, write });
    // Seeding and copying are not physical writes by the activation.
    for (const [key, bytes] of entries) this.seed(key, bytes);
  }
  seed(key: string, bytes: string): void {
    super.set(key, bytes);
  }
  peek(key: string): string | undefined {
    return super.get(key);
  }
  override get(key: string) {
    if (control(this).closed) throw new Dropped();
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

/** Place ordered frames and an optional sibling checkpoint without physical writes or cuts. */
export function storageOf(
  log: StoredLog & { readonly name?: string },
  write?: StorageWrite,
): DurableStorage {
  const storage = createStorage([], write);
  for (const [index, bytes] of log.frames.entries())
    seedFrame(storage, index + 1, bytes, log.name);
  if (log.checkpoint !== undefined)
    control(storage).disk.seed(
      `${logKey(log.name)}/checkpoint`,
      log.checkpoint,
    );
  return storage;
}

/** Retained bytes are inspectable even after the activation was cut. */
export function readFrame(
  storage: DurableStorage,
  n: number,
  name = "default",
): string | undefined {
  const key = logKey(name);
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
    checkpoint: control(storage).disk.peek(`${logKey(name)}/checkpoint`),
  };
}

/** Seed frame n without invoking write observers, mutation spies, or crash cuts. */
export function seedFrame(
  storage: DurableStorage,
  n: number,
  bytes: string,
  name = "default",
): void {
  const key = logKey(name);
  control(storage).disk.seed(n === 1 ? key : `${key}/${n}`, bytes);
}

/** Seed the next frame without invoking write observers, mutation spies, or crash cuts. */
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
    const [prefix, encoded, cell] = key.split("/");
    if (prefix === "@@es" && encoded !== undefined && cell === "log")
      names.add(decodeURIComponent(encoded));
  }
  return names;
}

export function copyStorage(
  storage: DurableStorage,
  write?: StorageWrite,
): DurableStorage {
  return createStorage(control(storage).disk, write);
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

/** A detached byte view, also readable after a cut. Never a driver's handle. */
export function storageBytes(
  storage: DurableStorage,
): ReadonlyMap<string, string> {
  return new Map(control(storage).disk);
}

export function storageMutations(storage: DurableStorage) {
  const { disk } = control(storage);
  return {
    set: vi.spyOn(disk, "set"),
    remove: vi.spyOn(disk, "delete"),
    clear: vi.spyOn(disk, "clear"),
  };
}

/** The sole driver choice, including the rule tests' cache inspection door. */
export function durableLog<S, M extends { _tag: string }, C extends Cmd>(
  storage: DurableStorage,
  options: EventSourcedOptions<S, M, C>,
): ReturnType<typeof memoryLog<S, M, C>> {
  return memoryLog(control(storage).disk, options);
}

export function durableStore<S, M extends { _tag: string }, C extends Cmd>(
  storage: DurableStorage,
  options: EventSourcedOptions<S, M, C>,
): LoggedStore<S, M, C> {
  return durableLog(storage, options).store;
}
