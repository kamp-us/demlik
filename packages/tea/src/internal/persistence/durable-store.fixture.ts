import { vi } from "vitest";
import type { Cmd } from "../../pure/core";
import type { EventSourcedOptions, LoggedStore } from "../../runtime-types";
import { memoryLog } from "./durable-log/memory-log";

declare const storageBrand: unique symbol;
/** Opaque storage, compared by its retained bytes in existing assertions. */
export interface DurableStorage {
  readonly [storageBrand]: true;
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
    for (const [key, bytes] of entries) super.set(key, bytes);
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

export function seedStorage(
  storage: DurableStorage,
  key: string,
  bytes: string,
): void {
  control(storage).disk.set(key, bytes);
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
