import { z } from "zod";
export const numeric = z.union([
  z.number(),
  z
    .object({ $number: z.enum(["NaN", "Infinity", "-Infinity", "-0"]) })
    .transform(
      ({ $number }) =>
        ({ NaN, Infinity, "-Infinity": -Infinity, "-0": -0 })[$number],
    ),
]);
export function encodeNumber(value: number): unknown {
  if (Number.isNaN(value)) return { $number: "NaN" };
  if (value === Infinity) return { $number: "Infinity" };
  if (value === -Infinity) return { $number: "-Infinity" };
  if (Object.is(value, -0)) return { $number: "-0" };
  return value;
}
export function decode(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(decode);
  const entries = Object.entries(value);
  if (entries.length === 1) {
    const [key, raw] = entries[0];
    if (key === "$number") return numeric.parse(value);
    if (key === "$undefined" && raw === true) return undefined;
    if (key === "$utf16")
      return String.fromCharCode(
        ...z.array(z.number().int().min(0).max(65535)).parse(raw),
      );
    if (key === "$object")
      return Object.fromEntries(
        z
          .array(z.tuple([z.unknown(), z.unknown()]))
          .parse(raw)
          .map(([key, value]) => [String(decode(key)), decode(value)]),
      );
  }
  return Object.fromEntries(
    entries.map(([key, value]) => [key, decode(value)]),
  );
}
function text(value: string): unknown {
  const units = Array.from({ length: value.length }, (_, index) =>
    value.charCodeAt(index),
  );
  for (let index = 0; index < units.length; index++) {
    const unit = units[index];
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = units[index + 1];
      if (next >= 0xdc00 && next <= 0xdfff) index++;
      else return { $utf16: units };
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return { $utf16: units };
  }
  return value;
}
export function normalize(value: unknown): unknown {
  if (value === undefined) return { $undefined: true };
  if (typeof value === "number") return encodeNumber(value);
  if (typeof value === "string") return text(value);
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(normalize);
  const entries = Object.entries(value);
  return entries.some(([key]) => typeof text(key) !== "string")
    ? { $object: entries.map(([key, value]) => [text(key), normalize(value)]) }
    : Object.fromEntries(
        entries.map(([key, value]) => [key, normalize(value)]),
      );
}
export function errorValue(value: unknown): unknown {
  return value instanceof Error
    ? { name: value.name, message: value.message }
    : normalize(value);
}
export function hostDelay(ms: number): number {
  return !(ms >= 1 && ms <= 2147483647) ? 1 : Math.trunc(ms);
}
export class Clock {
  tasks = new Map<number, { due: number; callback: () => void }>();
  next = 0;
  events: unknown[] = [];
  errors: unknown[] = [];
  constructor(
    public now: number,
    private failAt?: number,
  ) {}
  arm(callback: () => void, ms: number) {
    const id = this.next++;
    const due = this.now + hostDelay(ms);
    const failed = this.failAt === id + 1;
    this.events.push({
      kind: "arm",
      id,
      at: encodeNumber(this.now),
      ms: encodeNumber(ms),
      due: encodeNumber(due),
      failed,
    });
    if (failed) throw new Error(`arm failed ${id + 1}`);
    this.tasks.set(id, { due, callback });
    return id;
  }
  clear(id: number) {
    this.events.push({ kind: "clear", id, at: encodeNumber(this.now) });
    this.tasks.delete(id);
  }
  error(phase: string, error: unknown) {
    this.errors.push({
      at: encodeNumber(this.now),
      phase,
      error: errorValue(error),
    });
  }
  advance(to: number) {
    for (let budget = 0; budget < 1000; budget++) {
      const next = [...this.tasks.entries()]
        .filter(([, task]) => task.due <= to)
        .sort(([left, a], [right, b]) => a.due - b.due || left - right)[0];
      if (!next) {
        this.now = to;
        return;
      }
      const [id, task] = next;
      this.tasks.delete(id);
      this.now = task.due;
      this.events.push({ kind: "timer", id, at: encodeNumber(this.now) });
      try {
        task.callback();
      } catch (error) {
        this.error("timer", error);
      }
    }
    throw new Error(
      "deterministic timer script exhausted its 1000-fire budget",
    );
  }
  active() {
    return [...this.tasks.entries()]
      .sort(([left], [right]) => left - right)
      .map(([id, task]) => ({ id, due: encodeNumber(task.due) }));
  }
  install() {
    const original = {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
      now: Date.now,
    };
    Object.defineProperty(globalThis, "setTimeout", {
      value: (callback: () => void, ms: number) => this.arm(callback, ms),
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, "clearTimeout", {
      value: (id: number) => this.clear(id),
      configurable: true,
      writable: true,
    });
    Date.now = () => this.now;
    return () => {
      Object.defineProperty(globalThis, "setTimeout", {
        value: original.setTimeout,
        configurable: true,
        writable: true,
      });
      Object.defineProperty(globalThis, "clearTimeout", {
        value: original.clearTimeout,
        configurable: true,
        writable: true,
      });
      Date.now = original.now;
    };
  }
}
