import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import {
  doEventSourcedStore,
  type EventSourcedStore,
} from "../../packages/tea/src/do/event-sourced-store.js";
import { doStore } from "../../packages/tea/src/do/index.js";
import {
  type DeletableStore,
  defineMachine,
  type FencedStore,
  type Migrated,
  NoCellError,
  Refusal,
  StoreConflictError,
} from "../../packages/tea/src/index.js";
import { decode, normalize } from "./timing-clock.mts";

const data = z.unknown().refine((value) => z.json().safeParse(value).success);
const text = z.union([
  z.string(),
  z.object({ $utf16: z.array(z.number().int().min(0).max(65535)) }).strict(),
]);
const number = z.union([
  z.number(),
  z
    .object({ $number: z.enum(["NaN", "Infinity", "-Infinity", "-0"]) })
    .strict(),
]);
const optionalNumber = number.nullable().optional(),
  optionalText = text.nullable().optional();
const point = z.enum(["get", "put", "delete", "list", "transaction", "commit"]),
  stage = z.enum(["before", "after"]);
const mode = z.enum(["default", "schema", "drop"]);
const record = z.object({ id: z.string(), value: data }).strict();
const common = [
  z.object({ op: z.literal("seed"), key: text, value: data }).strict(),
  z.object({ op: z.literal("cells") }).strict(),
  z
    .object({
      op: z.literal("fault"),
      at: point,
      key: optionalText,
      stage,
      message: z.string(),
      value: data,
    })
    .strict(),
  z
    .object({
      op: z.literal("codecFault"),
      at: z.enum(["serialize", "encodeState", "encodeEvent", "ready"]),
      message: z.string(),
      value: data,
    })
    .strict(),
] as const;
const snapshotAction = z.discriminatedUnion("op", [
  ...common,
  z.object({ op: z.enum(["load", "delete", "loadFenced"]) }).strict(),
  z.object({ op: z.literal("save"), model: z.string() }).strict(),
  z.object({ op: z.literal("migrate"), value: data }).strict(),
  z
    .object({
      op: z.literal("saveFenced"),
      model: z.string(),
      expected: number,
    })
    .strict(),
  z
    .object({
      op: z.literal("heldSave"),
      model: z.string(),
      other: z.string(),
      expected: number,
      at: point,
      key: optionalText,
      stage,
    })
    .strict(),
]);
const eventAction = z.discriminatedUnion("op", [
  ...common,
  z
    .object({ op: z.enum(["load", "migrateLoaded", "snapshotNow", "restart"]) })
    .strict(),
  z.object({ op: z.literal("save"), model: z.string() }).strict(),
  z.object({ op: z.literal("append"), message: z.string() }).strict(),
  z.object({ op: z.literal("migrate"), value: data }).strict(),
  z
    .object({
      op: z.literal("read"),
      from: optionalNumber,
      to: optionalNumber,
      limit: z.number().int().min(0).optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal("mutate"),
      model: z.string(),
      field: z.enum(["n", "value"]),
      value: data,
    })
    .strict(),
  z
    .object({
      op: z.literal("mutateMessage"),
      message: z.string(),
      field: z.enum(["by", "value"]),
      value: data,
    })
    .strict(),
  z
    .object({ op: z.literal("parallel"), messages: z.array(z.string()) })
    .strict(),
  z
    .object({
      op: z.literal("delayed"),
      message: z.string(),
      model: z.string(),
      field: z.enum(["n", "value"]),
      value: data,
    })
    .strict(),
  z
    .object({
      op: z.literal("forget"),
      message: z.string(),
      model: z.string(),
      wait: text,
    })
    .strict(),
  z
    .object({
      op: z.literal("heldAppend"),
      message: z.string(),
      model: z.string(),
      replacement: z.string(),
      at: point,
      key: optionalText,
      stage,
    })
    .strict(),
  z
    .object({
      op: z.literal("heldSnapshot"),
      model: z.string(),
      replacement: z.string(),
      at: point,
      key: optionalText,
      stage,
    })
    .strict(),
]);
const seeds = z.array(z.object({ key: text, value: data }).strict());
export const durableObjectScript = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("snapshot"),
      config: z
        .object({
          key: optionalText,
          fenced: z.boolean(),
          parse: mode,
          serialize: z.enum(["default", "watch", "undefined"]),
        })
        .strict(),
      models: z.array(record),
      cells: seeds,
      actions: z.array(snapshotAction),
    })
    .strict(),
  z
    .object({
      mode: z.literal("events"),
      config: z
        .object({
          every: optionalNumber,
          snapshot: optionalText,
          meta: optionalText,
          prefix: optionalText,
          parse: mode,
          parse_event: mode,
          active_init: z.boolean(),
        })
        .strict(),
      models: z.array(record),
      messages: z.array(record),
      cells: seeds,
      actions: z.array(eventAction),
    })
    .strict(),
]);
type Script = z.infer<typeof durableObjectScript>;
type Point = z.infer<typeof point>;
type Stage = z.infer<typeof stage>;
type Model = Record<string, unknown>;
type Msg = Model & { type: string };
function txt(value: z.infer<typeof text>): string {
  return typeof value === "string"
    ? value
    : String.fromCharCode(...value.$utf16);
}
function num(value: z.infer<typeof number>): number {
  if (typeof value === "number") return value;
  switch (value.$number) {
    case "NaN":
      return Number.NaN;
    case "Infinity":
      return Number.POSITIVE_INFINITY;
    case "-Infinity":
      return Number.NEGATIVE_INFINITY;
    case "-0":
      return -0;
  }
}
function optionalNum(
  value: z.infer<typeof optionalNumber>,
): number | undefined {
  return value == null ? undefined : num(value);
}
function object(value: unknown): value is Model {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function hasType(value: unknown): value is Msg {
  return object(value) && typeof value.type === "string";
}
class FixtureIssue extends Error {
  override readonly name = "FixtureIssue";
  constructor(
    readonly at: string,
    message: string,
    readonly value: unknown,
  ) {
    super(message);
  }
}
class StorageFailure extends Error {
  override readonly name = "StorageFailure";
  constructor(
    readonly at: Point,
    readonly stage: Stage,
    message: string,
    readonly value: unknown,
  ) {
    super(message);
  }
}
export class Gate {
  count = 0;
  changes: Array<() => void> = [];
  readonly released: Promise<void>;
  release: () => void = () => {};
  constructor(readonly name: string) {
    this.released = new Promise((resolve) => {
      this.release = resolve;
    });
  }
  async arrive() {
    this.count += 1;
    for (const change of this.changes.splice(0)) change();
    await this.released;
  }
  async wait(count: number) {
    while (this.count < count)
      await new Promise<void>((resolve) => this.changes.push(resolve));
  }
}
type Rule = {
  at: Point;
  key?: string;
  stage: Stage;
  remaining: number;
  behavior:
    | { kind: "fail"; message: string; value: unknown }
    | { kind: "hold"; gate: Gate };
};
export function storageFixture(initial: Script["cells"], cloneReads = false) {
  const cells = new Map(
      initial.map((row) => [txt(row.key), decode(row.value)]),
    ),
    calls: unknown[] = [],
    rules: Rule[] = [],
    watchers: Array<() => void> = [];
  let transactionTail = Promise.resolve(),
    requested = 0;
  const changed = () => {
    for (const watcher of watchers.splice(0)) watcher();
  };
  const state = () =>
    [...cells]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, value]) => [normalize(key), normalize(value)]);
  const take = (at: Point, key?: string) => {
    const index = rules.findIndex(
      (rule) => rule.at === at && (rule.key === undefined || rule.key === key),
    );
    if (index < 0) return undefined;
    const rule = rules[index];
    rule.remaining -= 1;
    if (!rule.remaining) rules.splice(index, 1);
    return rule;
  };
  const boundary = async (rule: Rule) => {
    const fields = {
      at: rule.at,
      stage: rule.stage,
      key: rule.key === undefined ? null : normalize(rule.key),
    };
    switch (rule.behavior.kind) {
      case "fail":
        calls.push({
          ...fields,
          op: "fail",
          message: rule.behavior.message,
          value: normalize(rule.behavior.value),
        });
        throw new StorageFailure(
          rule.at,
          rule.stage,
          rule.behavior.message,
          rule.behavior.value,
        );
      case "hold":
        calls.push({ ...fields, op: "held", gate: rule.behavior.gate.name });
        await rule.behavior.gate.arrive();
        calls.push({
          ...fields,
          op: "released",
          gate: rule.behavior.gate.name,
        });
    }
  };
  const makeBase = (staged?: Map<string, { value: unknown } | null>) => ({
    async get(key: string) {
      calls.push({ op: "get", key: normalize(key) });
      const pending = staged?.get(key);
      const value = staged?.has(key) ? pending?.value : cells.get(key);
      return cloneReads ? structuredClone(value) : value;
    },
    async put(key: string, value: unknown) {
      calls.push({ op: "put", key: normalize(key), value: normalize(value) });
      if (staged) staged.set(key, { value });
      else {
        cells.set(key, value);
        changed();
      }
    },
    async delete(keys: string[]) {
      calls.push({ op: "delete", keys: keys.map(normalize) });
      for (const key of keys) {
        if (staged) staged.set(key, null);
        else cells.delete(key);
      }
    },
    async list(options: { prefix: string }) {
      calls.push({ op: "list", prefix: normalize(options.prefix) });
      return new Map(
        [...cells]
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .filter(([key]) => key.startsWith(options.prefix))
          .map(([key, value]) => [
            key,
            cloneReads ? structuredClone(value) : value,
          ]),
      );
    },
    async transaction<T>(
      effect: (transaction: ReturnType<typeof controlled>) => Promise<T>,
    ): Promise<T> {
      const previous = transactionTail;
      let release: () => void = () => {};
      transactionTail = new Promise((resolve) => {
        release = resolve;
      });
      await previous;
      calls.push({ op: "transactionBegin" });
      const writes = new Map<string, { value: unknown } | null>();
      try {
        const result = await effect(controlled(makeBase(writes)));
        for (const [key, pending] of writes) {
          if (pending) cells.set(key, pending.value);
          else cells.delete(key);
        }
        calls.push({ op: "transactionCommit" });
        changed();
        return result;
      } catch (error) {
        calls.push({ op: "transactionRollback" });
        throw error;
      } finally {
        release();
      }
    },
  });
  type Base = {
    get(key: string): Promise<unknown>;
    put(key: string, value: unknown): Promise<void>;
    delete(keys: string[]): Promise<void>;
    list(options: { prefix: string }): Promise<Map<string, unknown>>;
    transaction<T>(effect: (transaction: Controlled) => Promise<T>): Promise<T>;
  };
  type Controlled = Omit<Base, "transaction"> & {
    transaction<T>(effect: (transaction: Controlled) => Promise<T>): Promise<T>;
  };
  function controlled(base: Base): Controlled {
    return {
      async get(key) {
        const rule = take("get", key);
        if (rule?.stage === "before") await boundary(rule);
        const value = await base.get(key);
        if (rule?.stage === "after") await boundary(rule);
        return value;
      },
      async put(key, value) {
        const rule = take("put", key);
        if (rule?.stage === "before") await boundary(rule);
        await base.put(key, value);
        if (rule?.stage === "after") await boundary(rule);
      },
      async delete(keys) {
        const rule = take("delete");
        if (rule?.stage === "before") await boundary(rule);
        await base.delete(keys);
        if (rule?.stage === "after") await boundary(rule);
      },
      async list(options) {
        const rule = take("list", options.prefix);
        if (rule?.stage === "before") await boundary(rule);
        const value = await base.list(options);
        if (rule?.stage === "after") await boundary(rule);
        return value;
      },
      async transaction(effect) {
        const rule = take("transaction");
        requested += 1;
        changed();
        calls.push({ op: "transactionRequested" });
        if (rule?.stage === "before") await boundary(rule);
        const { value, commit } = await base.transaction(
          async (transaction) => {
            const value = await effect(transaction);
            const commit = take("commit");
            if (commit?.stage === "before") await boundary(commit);
            return { value, commit };
          },
        );
        if (commit?.stage === "after") await boundary(commit);
        if (rule?.stage === "after") await boundary(rule);
        return value;
      },
    };
  }
  return {
    cells,
    calls,
    rules,
    state,
    storage: controlled(makeBase()),
    requested: () => requested,
    async waitTransactions(count: number) {
      while (requested < count)
        await new Promise<void>((resolve) => watchers.push(resolve));
    },
    seed(key: string, value: unknown) {
      cells.set(key, value);
      changed();
    },
    async wait(key: string) {
      while (typeof cells.get(key) !== "string")
        await new Promise<void>((resolve) => watchers.push(resolve));
    },
  };
}
type Failure = { comparison: unknown; diagnostic: unknown };
function failure(error: unknown): Failure {
  let comparison: unknown;
  if (error instanceof StorageFailure)
    comparison = {
      kind: "storage",
      at: error.at === "commit" ? "transaction" : error.at,
      stage: error.stage,
      message: error.message,
      value: normalize(error.value),
    };
  else if (error instanceof FixtureIssue)
    comparison = {
      kind: "codec",
      at: error.at,
      message: error.message,
      value: normalize(error.value),
    };
  else if (error instanceof SyntaxError)
    return {
      comparison: { kind: "syntax" },
      diagnostic: {
        kind: "syntax",
        name: error.name,
        message: normalize(error.message),
      },
    };
  else if (error instanceof TypeError)
    comparison = { kind: "type", message: normalize(error.message) };
  else if (error instanceof StoreConflictError)
    comparison = {
      kind: "conflict",
      expected: normalize(error.expectedVersion),
      actual: normalize(error.actualVersion),
      message: normalize(error.message),
    };
  else if (error instanceof NoCellError)
    comparison = {
      kind: "noCell",
      msgType: error.msgType,
      stateName: error.stateName,
      acceptedTypes: error.acceptedTypes,
      message: error.message,
    };
  else if (error instanceof Error)
    comparison = {
      kind: "error",
      name: error.name,
      message: normalize(error.message),
    };
  else comparison = { kind: "throw", value: normalize(error) };
  return { comparison, diagnostic: comparison };
}
export async function executeDurableObject(input: unknown) {
  const script = durableObjectScript.parse(input),
    fixture = storageFixture(script.cells),
    hooks: unknown[] = [],
    diagnostics: unknown[] = [],
    calls: string[] = [],
    rows: unknown[] = [],
    faults = new Map<string, FixtureIssue>();
  const observe = <T,>(name: string, call: () => T): T => {
    calls.push(name);
    return call();
  };
  const check = (at: string) => {
    const issue = faults.get(at);
    if (issue) {
      faults.delete(at);
      throw issue;
    }
  };
  const codec = (at: string, value: unknown) => {
    hooks.push({ op: at, value: normalize(value) });
    check(at);
    return value;
  };
  const watch = <T,>(value: T, at: string): T => {
    if (object(value))
      Object.defineProperty(value, "toJSON", {
        enumerable: false,
        value: () => {
          codec(at, value);
          return { ...value };
        },
      });
    return value;
  };
  const models = new Map(
    script.models.map((row) => [
      row.id,
      script.mode === "events"
        ? watch(decode(row.value), "encodeState")
        : decode(row.value),
    ]),
  );
  const nested = (
    result: { ok: true; value: unknown } | { ok: false; error: Failure },
  ) => {
    if (result.ok) return { ok: true, value: result.value };
    diagnostics.push(result.error.diagnostic);
    return { ok: false, error: result.error.comparison };
  };
  const settle = async (
    work: Promise<unknown>,
  ): Promise<{ ok: true; value: unknown } | { ok: false; error: Failure }> => {
    try {
      return { ok: true, value: (await work) ?? null } as const;
    } catch (error) {
      return { ok: false, error: failure(error) } as const;
    }
  };
  const row = (result: Awaited<ReturnType<typeof settle>>) => {
    const value = nested(result);
    rows.push({
      result: value,
      calls: fixture.calls.splice(0),
      callbacks: hooks.splice(0),
      cells: fixture.state(),
    });
  };
  const commonAction = (item: z.infer<(typeof common)[number]>) => {
    switch (item.op) {
      case "cells":
        return fixture.state();
      case "seed":
        fixture.seed(txt(item.key), decode(item.value));
        return null;
      case "fault":
        fixture.rules.push({
          at: item.at,
          key: item.key == null ? undefined : txt(item.key),
          stage: item.stage,
          remaining: 1,
          behavior: {
            kind: "fail",
            message: item.message,
            value: decode(item.value),
          },
        });
        return null;
      case "codecFault":
        faults.set(
          item.at,
          new FixtureIssue(item.at, item.message, decode(item.value)),
        );
        return null;
    }
  };
  const isCommon = (item: {
    op: string;
  }): item is z.infer<(typeof common)[number]> =>
    ["cells", "seed", "fault", "codecFault"].includes(item.op);
  if (script.mode === "snapshot") {
    const parse = (raw: unknown): Migrated<unknown> => {
      hooks.push({ op: "migrate", value: normalize(raw) });
      if (raw === null || script.config.parse === "drop") return null;
      if (
        script.config.parse === "schema" &&
        !(object(raw) && raw.type === "state" && typeof raw.n === "number")
      )
        return new Refusal("expected state record");
      return raw;
    };
    const options = {
      key: script.config.key == null ? undefined : txt(script.config.key),
      ...(script.config.fenced ? { fenced: true } : {}),
      ...(script.config.serialize !== "default"
        ? {
            serialize: (raw: unknown) => {
              codec("serialize", raw);
              return script.config.serialize === "undefined" ? undefined : raw;
            },
          }
        : {}),
    };
    // The local port deliberately implements only the storage operations this adapter calls.
    const store: DeletableStore<unknown> & Partial<FencedStore<unknown>> =
      observe("doStore", () =>
        Reflect.apply(doStore, undefined, [fixture.storage, parse, options]),
      );
    const perform = async (
      item: Exclude<
        z.infer<typeof snapshotAction>,
        z.infer<(typeof common)[number]>
      >,
    ) => {
      switch (item.op) {
        case "load":
          return normalize(await observe("Store.load", () => store.load()));
        case "save":
          await observe("Store.save", () => store.save(models.get(item.model)));
          return null;
        case "migrate": {
          const value = observe("Store.migrate", () =>
            store.migrate(decode(item.value)),
          );
          return value === null
            ? { kind: "fresh" }
            : value instanceof Refusal
              ? { kind: "refused", reason: value.reason }
              : { kind: "state", value: normalize(value) };
        }
        case "delete":
          await observe("DeletableStore.delete", () => store.delete());
          return null;
        case "loadFenced":
          assert(store.loadFenced);
          return normalize(
            await observe("FencedStore.loadFenced", () => store.loadFenced?.()),
          );
        case "saveFenced":
          assert(store.saveFenced);
          return normalize(
            await observe("FencedStore.saveFenced", () =>
              store.saveFenced?.(models.get(item.model), num(item.expected)),
            ),
          );
        case "heldSave":
          throw new Error("compound action belongs to its host boundary");
      }
    };
    for (const item of script.actions) {
      if (isCommon(item)) row({ ok: true, value: commonAction(item) });
      else if (item.op === "heldSave") {
        const gate = new Gate("save");
        fixture.rules.push({
          at: item.at,
          key: item.key == null ? undefined : txt(item.key),
          stage: item.stage,
          remaining: 1,
          behavior: { kind: "hold", gate },
        });
        const first = settle(
          perform(
            script.config.fenced
              ? { op: "saveFenced", model: item.model, expected: item.expected }
              : { op: "save", model: item.model },
          ),
        );
        await gate.wait(1);
        const held = fixture.state();
        const second = settle(
          perform(
            script.config.fenced
              ? { op: "saveFenced", model: item.other, expected: item.expected }
              : { op: "save", model: item.other },
          ),
        );
        if (script.config.fenced) {
          const requested = fixture.requested(),
            whileHeld = fixture.state();
          gate.release();
          row({
            ok: true,
            value: {
              held,
              whileHeld,
              requested,
              first: nested(await first),
              second: nested(await second),
            },
          });
        } else {
          const secondResult = await second,
            whileHeld = fixture.state();
          gate.release();
          row({
            ok: true,
            value: {
              held,
              whileHeld,
              first: nested(await first),
              second: nested(secondResult),
            },
          });
        }
      } else row(await settle(perform(item)));
    }
  } else {
    const messages = new Map(
      script.messages.map((row) => [
        row.id,
        watch(decode(row.value), "encodeEvent"),
      ]),
    );
    const fresh = (n: number, value: unknown) =>
      watch({ type: "state", n, value }, "encodeState");
    const update = (
      name: "set" | "add" | "clear",
      state: Model,
      msg: Msg,
    ): readonly [Model, readonly never[]] => {
      hooks.push({
        op: "update",
        state: normalize(state),
        message: normalize(msg),
      });
      const n = typeof state.n === "number" ? state.n : 0;
      switch (name) {
        case "set":
          return [fresh(n + 1, structuredClone(msg.value)), []];
        case "clear":
          return [fresh(n + 1, null), []];
        case "add":
          return [
            fresh(
              n + (typeof msg.by === "number" ? msg.by : 1),
              Object.hasOwn(state, "value")
                ? structuredClone(state.value)
                : null,
            ),
            [],
          ];
      }
    };
    const machine = () =>
      defineMachine({
        init: (loaded: Model | null): readonly [Model, readonly never[]] => {
          hooks.push({ op: "init", loaded: normalize(loaded) });
          if (loaded === null) return [fresh(0, null), []];
          return [
            script.config.active_init
              ? watch(
                  {
                    ...loaded,
                    n: (typeof loaded.n === "number" ? loaded.n : 0) + 100,
                  },
                  "encodeState",
                )
              : loaded,
            [],
          ];
        },
        update: {
          set: (state: Model, msg: Msg) => update("set", state, msg),
          add: (state: Model, msg: Msg) => update("add", state, msg),
          clear: (state: Model, msg: Msg) => update("clear", state, msg),
        },
        subs: [
          {
            type: "noop",
            deps: (state: Model) => {
              hooks.push({ op: "subs", state: normalize(state) });
              return null;
            },
          },
        ],
      });
    const options = () => ({
      snapshotEvery: optionalNum(script.config.every),
      keys: {
        snapshot:
          script.config.snapshot == null
            ? undefined
            : txt(script.config.snapshot),
        meta: script.config.meta == null ? undefined : txt(script.config.meta),
        eventPrefix:
          script.config.prefix == null ? undefined : txt(script.config.prefix),
      },
      ...(script.config.parse !== "default"
        ? {
            parse: (raw: unknown) => {
              hooks.push({ op: "parse", value: normalize(raw) });
              return script.config.parse === "schema" &&
                object(raw) &&
                raw.type === "state" &&
                typeof raw.n === "number"
                ? raw
                : null;
            },
          }
        : {}),
      ...(script.config.parse_event !== "default"
        ? {
            parseEvent: (raw: unknown) => {
              hooks.push({ op: "parseEvent", value: normalize(raw) });
              return script.config.parse_event === "schema" &&
                hasType(raw) &&
                ["set", "add", "clear"].includes(raw.type)
                ? raw
                : null;
            },
          }
        : {}),
      onReady: (state: Model) => {
        hooks.push({ op: "ready", state: normalize(state) });
        check("ready");
      },
    });
    const make = (): EventSourcedStore<Model, Msg> =>
      observe("doEventSourcedStore", () =>
        Reflect.apply(doEventSourcedStore, undefined, [
          fixture.storage,
          machine(),
          {},
          options(),
        ]),
      );
    let store: EventSourcedStore<Model, Msg>;
    try {
      store = make();
    } catch (error) {
      row({ ok: false, error: failure(error) });
      return { comparison: rows, diagnostics, observedSourceCalls: calls };
    }
    let loaded: unknown;
    const append = (id: string): Promise<void> =>
      observe("EventSourcedStore.append", () =>
        Reflect.apply(store.append, store, [messages.get(id)]),
      );
    const save = (id: string): Promise<void> =>
      observe("Store.save", () =>
        Reflect.apply(store.store.save, store.store, [models.get(id)]),
      );
    for (const item of script.actions) {
      let result: Awaited<ReturnType<typeof settle>>;
      try {
        if (isCommon(item)) {
          row({ ok: true, value: commonAction(item) });
          continue;
        }
        switch (item.op) {
          case "load":
            loaded = await observe("Store.load", () => store.store.load());
            result = { ok: true, value: normalize(loaded) };
            break;
          case "migrateLoaded": {
            const value = observe("Store.migrate", () =>
              store.store.migrate(loaded),
            );
            result = {
              ok: true,
              value:
                value === null
                  ? { kind: "fresh" }
                  : {
                      kind: "state",
                      value: normalize(value),
                      same: value === loaded,
                    },
            };
            break;
          }
          case "migrate": {
            const value = observe("Store.migrate", () =>
              store.store.migrate(decode(item.value)),
            );
            result = {
              ok: true,
              value:
                value === null
                  ? { kind: "fresh" }
                  : { kind: "state", value: normalize(value) },
            };
            break;
          }
          case "save":
            result = await settle(save(item.model));
            break;
          case "append":
            result = await settle(append(item.message));
            break;
          case "snapshotNow":
            result = await settle(
              observe("EventSourcedStore.snapshotNow", () =>
                store.snapshotNow(),
              ),
            );
            break;
          case "read": {
            const iterator = observe("EventSourcedStore.readEvents", () =>
                store.readEvents({
                  fromSeq: optionalNum(item.from),
                  toSeq: optionalNum(item.to),
                }),
              )[Symbol.asyncIterator](),
              values: unknown[] = [];
            result = { ok: true, value: values };
            while (item.limit === undefined || values.length < item.limit) {
              try {
                const next = await observe("EventLog.next", () =>
                  iterator.next(),
                );
                if (next.done) break;
                values.push({
                  seq: normalize(next.value.seq),
                  event: normalize(next.value.event),
                });
              } catch (error) {
                const caught = failure(error);
                result = {
                  ok: false,
                  error: {
                    ...caught,
                    comparison: { partial: values, cause: caught.comparison },
                  },
                };
                break;
              }
            }
            break;
          }
          case "restart":
            store = make();
            loaded = undefined;
            result = { ok: true, value: null };
            break;
          case "mutate": {
            const value = models.get(item.model);
            assert(object(value));
            Reflect.set(value, item.field, decode(item.value));
            result = { ok: true, value: null };
            break;
          }
          case "mutateMessage": {
            const value = messages.get(item.message);
            assert(object(value));
            Reflect.set(value, item.field, decode(item.value));
            result = { ok: true, value: null };
            break;
          }
          case "parallel":
            result = {
              ok: true,
              value: (
                await Promise.all(item.messages.map((id) => settle(append(id))))
              ).map((value) => (value.ok ? { ok: true } : nested(value))),
            };
            break;
          case "delayed": {
            const receipt = append(item.message),
              manual = observe("EventSourcedStore.snapshotNow", () =>
                store.snapshotNow(),
              ),
              prefix = fixture.calls.splice(0);
            save(item.model);
            const value = models.get(item.model);
            assert(object(value));
            Reflect.set(value, item.field, decode(item.value));
            await receipt;
            result = { ok: true, value: { prefix, manual: await manual } };
            break;
          }
          case "forget": {
            await save(item.model);
            append(item.message);
            await fixture.wait(txt(item.wait));
            result = {
              ok: true,
              value: normalize(
                await observe("Store.load", () => store.store.load()),
              ),
            };
            break;
          }
          case "heldAppend": {
            await save(item.model);
            const gate = new Gate("append");
            fixture.rules.push({
              at: item.at,
              key: item.key == null ? undefined : txt(item.key),
              stage: item.stage,
              remaining: 1,
              behavior: { kind: "hold", gate },
            });
            const receipt = append(item.message);
            await gate.wait(1);
            const held = fixture.state();
            save(item.replacement);
            gate.release();
            await receipt;
            result = { ok: true, value: { held } };
            break;
          }
          case "heldSnapshot": {
            await save(item.model);
            const gate = new Gate("snapshot");
            fixture.rules.push({
              at: item.at,
              key: item.key == null ? undefined : txt(item.key),
              stage: item.stage,
              remaining: 1,
              behavior: { kind: "hold", gate },
            });
            const receipt = observe("EventSourcedStore.snapshotNow", () =>
              store.snapshotNow(),
            );
            await gate.wait(1);
            const held = fixture.state();
            save(item.replacement);
            gate.release();
            result = { ok: true, value: { held, written: await receipt } };
            break;
          }
        }
      } catch (error) {
        result = { ok: false, error: failure(error) };
      }
      row(result);
    }
  }
  return { comparison: rows, diagnostics, observedSourceCalls: calls };
}

type Case = { id: string; script: Script };
export function durableObjectCases(): Case[] {
  const cases: Case[] = [],
    models = [
      { id: "a", value: { type: "state", n: 1, value: "a" } },
      { id: "b", value: { type: "state", n: 9, value: "b" } },
      {
        id: "odd",
        value: {
          type: "state",
          n: 2,
          value: {
            $object: [
              ["__proto__", 4],
              [{ $utf16: [0xd800] }, { $undefined: true }],
              ["z", { $number: "-0" }],
            ],
          },
        },
      },
    ],
    messages = [
      { id: "add1", value: { type: "add", by: 1 } },
      { id: "add2", value: { type: "add", by: 2 } },
      { id: "set", value: { type: "set", value: { payload: [1, null, "x"] } } },
      { id: "clear", value: { type: "clear" } },
      { id: "retired", value: { type: "retired", value: 7 } },
      { id: "nil", value: null },
      { id: "array", value: [1, 2] },
      { id: "inf", value: { type: "add", by: { $number: "Infinity" } } },
      { id: "nan", value: { type: "set", value: { $number: "NaN" } } },
    ];
  const add = (id: string, script: unknown) =>
    cases.push({ id: `do.${id}`, script: durableObjectScript.parse(script) });
  const snapshot = (
    actions: unknown[],
    overrides = {},
    cells: unknown[] = [],
  ) => ({
    mode: "snapshot",
    config: {
      key: null,
      fenced: false,
      parse: "default",
      serialize: "default",
      ...overrides,
    },
    models,
    cells,
    actions,
  });
  const events = (
    actions: unknown[],
    overrides = {},
    cells: unknown[] = [],
  ) => ({
    mode: "events",
    config: {
      every: 2,
      snapshot: null,
      meta: null,
      prefix: null,
      parse: "default",
      parse_event: "default",
      active_init: false,
      ...overrides,
    },
    models,
    messages,
    cells,
    actions,
  });
  const save = (model = "a") => ({ op: "save", model }),
    append = (message = "add1") => ({ op: "append", message });
  const load = { op: "load" },
    cells = { op: "cells" },
    manual = { op: "snapshotNow" },
    restart = { op: "restart" },
    migrateLoaded = { op: "migrateLoaded" },
    read = { op: "read" };
  const fault = (
    at: z.infer<typeof point>,
    key: unknown,
    stage: Stage,
    value: unknown = { code: 7 },
  ) => ({ op: "fault", at, key, stage, message: "storage refused", value });
  const cell = (key: unknown, value: unknown) => ({ key, value }),
    evt = (seq: number, value: unknown) =>
      cell(`@@es/evt/${String(seq).padStart(16, "0")}`, JSON.stringify(value));
  add(
    "snapshot.default-roundtrip",
    snapshot([
      load,
      save(),
      load,
      { op: "migrate", value: { type: "state", n: 1, value: "a" } },
      { op: "delete" },
      load,
    ]),
  );
  add(
    "snapshot.custom-serializer",
    snapshot(
      [
        save("odd"),
        load,
        { op: "migrate", value: { old: true } },
        { op: "delete" },
        load,
      ],
      { serialize: "watch", parse: "schema" },
    ),
  );
  add(
    "snapshot.undefined-carrier",
    snapshot([save(), cells, load, { op: "delete" }, cells], {
      serialize: "undefined",
    }),
  );
  for (const key of ["", "__proto__", { $utf16: [0xd800, 47, 120] }])
    add(
      `snapshot.key-${JSON.stringify(key)}`,
      snapshot([save("odd"), load, { op: "delete" }, cells], {
        key,
        serialize: "watch",
      }),
    );
  for (const parse of ["default", "schema", "drop"] as const)
    add(
      `snapshot.migrate-${parse}`,
      snapshot(
        [
          ...[
            null,
            { $undefined: true },
            4,
            [],
            { type: "old" },
            { type: "state", n: 3 },
          ].map((value) => ({ op: "migrate", value })),
          save(),
          load,
        ],
        { parse },
      ),
    );
  const rawCells: Array<[string, unknown]> = [
    ["absent-value", { $undefined: true }],
    ["raw-null", null],
    ["json-null", "null"],
    ["raw-number", 17.25],
    ["raw-bool", true],
    ["raw-array", [42]],
    ["empty-array", []],
    ["object", { value: 1 }],
    ["bad-to-string", { toString: null }],
    ["bad-json", "{broken}"],
    ["literal-value", { $utf16: [34, 0xd800, 34] }],
    ["literal-key", { $utf16: [123, 34, 0xd800, 34, 58, 49, 125] }],
    ["bad-escaped", { $utf16: [34, 92, 0xd800, 34] }],
    ["bad-outside", { $utf16: [0xd800] }],
    ["escaped-backslash", { $utf16: [34, 92, 92, 0xd800, 34] }],
  ];
  for (const [name, raw] of rawCells)
    add(
      `snapshot.raw-${name}`,
      snapshot([load, cells], {}, [cell("@@state", raw)]),
    );
  for (const when of stage.options)
    for (const at of ["get", "put", "delete"] as const)
      add(
        `snapshot.failure-${at}-${when}`,
        snapshot(
          [
            save(),
            fault(at, at === "delete" ? null : "@@state", when, {
              $undefined: true,
            }),
            at === "get" ? load : at === "put" ? save("b") : { op: "delete" },
            cells,
            load,
          ],
          { serialize: "watch" },
        ),
      );
  add(
    "snapshot.serializer-failure",
    snapshot(
      [
        {
          op: "codecFault",
          at: "serialize",
          message: "serializer rejected model",
          value: { _tag: "bad_model", detail: null },
        },
        save(),
        cells,
        save("b"),
        load,
      ],
      { serialize: "watch" },
    ),
  );
  for (const when of stage.options)
    add(
      `snapshot.held-${when}`,
      snapshot(
        [
          {
            op: "heldSave",
            model: "a",
            other: "b",
            expected: 0,
            at: "put",
            key: "@@state",
            stage: when,
          },
          load,
        ],
        { serialize: "watch" },
      ),
    );
  add(
    "fenced.numeric-cas",
    snapshot(
      [
        { op: "loadFenced" },
        { op: "saveFenced", model: "a", expected: 0 },
        { op: "loadFenced" },
        { op: "saveFenced", model: "b", expected: 0 },
        { op: "saveFenced", model: "b", expected: 1 },
        { op: "delete" },
        { op: "loadFenced" },
      ],
      { fenced: true, serialize: "watch" },
    ),
  );
  for (const version of [
    null,
    0,
    { $number: "-0" },
    { $number: "NaN" },
    { $number: "Infinity" },
    1e100,
  ])
    add(
      `fenced.number-${JSON.stringify(version)}`,
      snapshot(
        [
          { op: "loadFenced" },
          { op: "saveFenced", model: "a", expected: version ?? 0 },
          { op: "loadFenced" },
          cells,
        ],
        { fenced: true },
        [cell("@@state@@version", version)],
      ),
    );
  const fencePoints: Array<[z.infer<typeof point>, string | null]> = [
    ["get", "@@state@@version"],
    ["get", "@@state"],
    ["put", "@@state"],
    ["put", "@@state@@version"],
    ["transaction", null],
    ["commit", null],
    ["delete", null],
  ];
  for (const [at, key] of fencePoints)
    for (const when of stage.options)
      add(
        `fenced.failure-${at}-${key}-${when}`,
        snapshot(
          [
            ...(at === "delete"
              ? [{ op: "saveFenced", model: "a", expected: 0 }]
              : []),
            fault(at, key, when, { $number: "NaN" }),
            at === "get"
              ? { op: "loadFenced" }
              : at === "delete"
                ? { op: "delete" }
                : { op: "saveFenced", model: "a", expected: 0 },
            cells,
            { op: "loadFenced" },
            { op: "saveFenced", model: "b", expected: 0 },
            cells,
          ],
          { fenced: true, serialize: "watch" },
        ),
      );
  for (const [at, key] of [
    ["get", "@@state@@version"],
    ["put", "@@state"],
    ["put", "@@state@@version"],
  ] as const)
    for (const when of stage.options)
      add(
        `fenced.held-${at}-${key}-${when}`,
        snapshot(
          [
            {
              op: "heldSave",
              model: "a",
              other: "b",
              expected: 0,
              at,
              key,
              stage: when,
            },
            { op: "loadFenced" },
            cells,
          ],
          { fenced: true, serialize: "watch" },
        ),
      );
  add(
    "events.empty-and-ready-once",
    events([
      load,
      migrateLoaded,
      load,
      migrateLoaded,
      manual,
      read,
      { op: "read", limit: 0 },
      restart,
      load,
    ]),
  );
  add(
    "events.count-snapshot-tail",
    events([
      load,
      save(),
      append(),
      save("b"),
      append("add2"),
      append("set"),
      read,
      load,
      migrateLoaded,
      manual,
      read,
      restart,
      load,
      migrateLoaded,
    ]),
  );
  add(
    "events.manual-rebases-count",
    events(
      [
        load,
        save(),
        append(),
        manual,
        append("add2"),
        cells,
        append("set"),
        cells,
        manual,
        manual,
        read,
        restart,
        load,
      ],
      { every: 2 },
    ),
  );
  add(
    "events.cold-parallel-overwrite",
    events([{ op: "parallel", messages: ["add1", "add2"] }, cells, read, load]),
  );
  add(
    "events.cached-parallel-overwrite",
    events(
      [
        load,
        save(),
        { op: "parallel", messages: ["add1", "add2"] },
        read,
        load,
      ],
      { every: 100 },
    ),
  );
  add(
    "events.non-message-appends-dropped",
    events([load, save(), append("nil"), append("array"), read, load]),
  );
  add(
    "events.delayed-save-retention",
    events(
      [
        load,
        save(),
        { op: "delayed", message: "add1", model: "b", field: "n", value: 10 },
        cells,
        manual,
        restart,
        load,
      ],
      { every: 1 },
    ),
  );
  add(
    "events.ignore-receipt-and-recover",
    events(
      [
        load,
        { op: "forget", message: "add1", model: "a", wait: "@@es/snapshot" },
        read,
        manual,
      ],
      { every: 1 },
    ),
  );
  add(
    "events.model-reference-before-checkpoint",
    events(
      [
        load,
        save(),
        { op: "mutate", model: "a", field: "value", value: { edited: true } },
        append(),
        cells,
        restart,
        load,
      ],
      { every: 1 },
    ),
  );
  add(
    "events.nonfinite-json-restores",
    events(
      [
        load,
        save("odd"),
        append("nan"),
        append("inf"),
        cells,
        read,
        restart,
        load,
        append(),
        cells,
        load,
      ],
      { every: 2 },
    ),
  );
  for (const parse of mode.options)
    for (const parse_event of mode.options)
      add(
        `events.parsers-${parse}-${parse_event}`,
        events(
          [
            load,
            migrateLoaded,
            read,
            { op: "migrate", value: { type: "old" } },
            restart,
            load,
          ],
          { parse, parse_event },
          [
            cell(
              "@@es/snapshot",
              '{"seq":1,"state":{"type":"state","n":10,"value":"snapshot"}}',
            ),
            cell("@@es/meta", '{"lastSeq":3}'),
            evt(1, { type: "add", by: 1 }),
            evt(2, { type: "add", by: 2 }),
            evt(3, { type: "clear" }),
          ],
        ),
      );
  add(
    "events.snapshot-fold-skips-active-init",
    events([load, migrateLoaded, read, load], { active_init: true }, [
      cell(
        "@@es/snapshot",
        '{"seq":2,"state":{"type":"state","n":3,"value":null}}',
      ),
      cell("@@es/meta", '{"lastSeq":3}'),
      evt(1, { type: "add", by: 1 }),
      evt(2, { type: "add", by: 2 }),
      evt(3, { type: "add", by: 3 }),
    ]),
  );
  add(
    "events.default-unknown-event-refuses",
    events([load, read], {}, [evt(1, { type: "retired" })]),
  );
  add(
    "events.partial-reader",
    events(
      [
        { op: "read", limit: 0 },
        { op: "read", limit: 1 },
        read,
        { op: "read", to: 2 },
        load,
      ],
      {},
      [
        evt(1, { type: "add", by: 1 }),
        evt(2, null),
        cell("@@es/evt/0000000000000003", "{broken}"),
      ],
    ),
  );
  for (const range of [
    {},
    { from: 2 },
    { to: 2 },
    { from: 2, to: 3 },
    { from: 4, to: 1 },
    { from: { $number: "NaN" }, to: { $number: "NaN" } },
    { from: { $number: "-Infinity" }, to: { $number: "Infinity" } },
    { from: { $number: "-0" }, to: 0 },
  ])
    add(
      `events.range-${JSON.stringify(range)}`,
      events([{ op: "read", ...range }, cells], {}, [
        evt(1, { type: "add", by: 1 }),
        evt(2, { type: "set", value: "two" }),
        evt(3, { type: "clear" }),
      ]),
    );
  add(
    "events.key-number-coercion",
    events(
      [read, { op: "read", from: 0, to: 2 }],
      {},
      ["", "-0", "+1", " 2 ", "0x10", "NaN", "Infinity", "bad"].map((suffix) =>
        cell(`@@es/evt/${suffix}`, '{"type":"add","by":1}'),
      ),
    ),
  );
  for (const [name, raw] of rawCells.slice(0, 10))
    for (const key of ["@@es/snapshot", "@@es/meta"])
      add(
        `events.raw-${key}-${name}`,
        events([load, cells], {}, [cell(key, raw)]),
      );
  for (const meta of [
    '{"lastSeq":null}',
    '{"lastSeq":"1"}',
    '{"lastSeq":1e400}',
    "[]",
  ])
    add(
      `events.meta-${meta}`,
      events(
        [append(), cells, read, restart, append("add2"), cells, load],
        { every: 1 },
        [cell("@@es/meta", meta)],
      ),
    );
  for (const snapshotCell of [
    '{"seq":null,"state":{"type":"state","n":4}}',
    '{"seq":"1","state":{"type":"state","n":4}}',
    '{"seq":1e400,"state":{"type":"state","n":4}}',
    '{"seq":1,"state":[]}',
    '{"seq":1}',
    '{"seq":1,"state":null}',
  ])
    add(
      `events.snapshot-envelope-${snapshotCell}`,
      events([load, migrateLoaded, read, manual], {}, [
        cell("@@es/snapshot", snapshotCell),
        cell("@@es/meta", '{"lastSeq":2}'),
        evt(1, { type: "add", by: 1 }),
        evt(2, { type: "add", by: 2 }),
      ]),
    );
  for (const every of [
    0,
    { $number: "-0" },
    -1,
    1.5,
    { $number: "NaN" },
    { $number: "Infinity" },
    { $number: "-Infinity" },
    1e100,
    null,
  ])
    add(
      `events.every-${JSON.stringify(every)}`,
      events([load, save(), append(), manual, read], { every }),
    );
  const keys = {
    snapshot: { $utf16: [0xd800, 47, 115] },
    meta: "__proto__",
    prefix: { $utf16: [0xdfff, 47] },
  };
  add(
    "events.custom-utf16-keys",
    events(
      [load, save("odd"), append("set"), manual, read, restart, load],
      keys,
    ),
  );
  add(
    "events.alias-cell-keys",
    events([load, save(), append(), manual, read, restart, load], {
      snapshot: "",
      meta: "",
      prefix: "",
    }),
  );
  for (const when of stage.options)
    for (const key of ["@@es/snapshot", "@@es/meta"])
      add(
        `events.load-failure-${key}-${when}`,
        events([
          fault("get", key, when, null),
          load,
          cells,
          load,
          migrateLoaded,
        ]),
      );
  for (const when of stage.options)
    for (const key of [
      "@@es/evt/0000000000000001",
      "@@es/meta",
      "@@es/snapshot",
    ])
      add(
        `events.append-failure-${key}-${when}`,
        events(
          [
            load,
            save(),
            fault("put", key, when, { _tag: "not_saved" }),
            append(),
            cells,
            manual,
            append("add2"),
            cells,
            restart,
            load,
          ],
          { every: 1 },
        ),
      );
  for (const when of stage.options)
    add(
      `events.reader-failure-${when}`,
      events(
        [
          fault("list", "@@es/evt/", when, { $undefined: true }),
          read,
          load,
          read,
        ],
        {},
        [evt(1, { type: "add", by: 2 })],
      ),
    );
  for (const at of ["ready", "encodeEvent", "encodeState"] as const)
    add(
      `events.codec-failure-${at}`,
      events(
        [
          {
            op: "codecFault",
            at,
            message: `failed ${at}`,
            value: { _tag: "codec_failed", at },
          },
          ...(at === "ready"
            ? [load, load, migrateLoaded]
            : [load, save(), append(), cells, manual, append("add2"), load]),
        ],
        { every: 1 },
      ),
    );
  for (const when of stage.options)
    for (const key of [
      "@@es/evt/0000000000000001",
      "@@es/meta",
      "@@es/snapshot",
    ])
      add(
        `events.held-append-${key}-${when}`,
        events(
          [
            load,
            {
              op: "heldAppend",
              message: "add1",
              model: "a",
              replacement: "b",
              at: "put",
              key,
              stage: when,
            },
            cells,
            restart,
            load,
          ],
          { every: 1 },
        ),
      );
  for (const when of stage.options)
    add(
      `events.held-manual-${when}`,
      events(
        [
          load,
          save(),
          append(),
          {
            op: "heldSnapshot",
            model: "b",
            replacement: "a",
            at: "put",
            key: "@@es/snapshot",
            stage: when,
          },
          cells,
          restart,
          load,
        ],
        { every: 100 },
      ),
    );
  let seed = 0x01a16c9d;
  const draw = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  };
  for (let sample = 0; sample < 12; sample += 1) {
    const actions: unknown[] = [load];
    for (let step = 0; step < 10; step += 1) {
      actions.push(
        save(draw() & 1 ? "a" : "b"),
        append(["add1", "add2", "set", "clear"][draw() % 4]),
      );
      if (draw() % 3 === 0) actions.push(manual);
      if (draw() % 4 === 0) actions.push(restart, load);
    }
    actions.push(read, restart, load, migrateLoaded);
    add(
      `events.sequence-${sample}`,
      events(actions, { every: 1 + (draw() % 5) }),
    );
  }
  cases.push(...durableRawVersionCases());
  assert.equal(
    new Set(cases.map((item) => item.id)).size,
    cases.length,
    "case IDs must be unique",
  );
  return cases;
}
export function durableRawVersionCases(): Case[] {
  return ["1", true].map((version, index) => ({
    id: `do.snapshot.raw-version-${index}`,
    script: durableObjectScript.parse({
      mode: "snapshot",
      config: {
        key: null,
        fenced: true,
        parse: "default",
        serialize: "default",
      },
      models: [],
      cells: [{ key: "@@state@@version", value: version }],
      actions: [{ op: "loadFenced" }, { op: "cells" }],
    }),
  }));
}
function command(
  executable: string,
  args: string[],
  input?: string,
  cwd = process.cwd(),
  env = process.env,
) {
  const result = spawnSync(executable, args, {
    input,
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
    timeout: 300000,
  });
  if (result.error) throw result.error;
  assert.equal(
    result.status,
    0,
    `${executable} failed: ${result.stderr.slice(-12000)}`,
  );
  return result.stdout;
}
function binary(cwd = process.cwd(), target = process.env.CARGO_TARGET_DIR) {
  return join(
    target ? resolve(cwd, target) : join(cwd, "target"),
    "debug/durable_object_driver",
  );
}
function build(cwd = process.cwd(), target?: string) {
  command(
    process.env.CARGO ?? "cargo",
    [
      "build",
      "--locked",
      "-p",
      "demlik-parity",
      "--bin",
      "durable_object_driver",
    ],
    undefined,
    cwd,
    {
      ...process.env,
      CARGO_NET_OFFLINE: "true",
      CARGO_PROFILE_DEV_DEBUG: "0",
      CARGO_PROFILE_TEST_DEBUG: "0",
      CARGO_INCREMENTAL: "0",
      CARGO_BUILD_JOBS: "1",
      ...(target ? { CARGO_TARGET_DIR: target } : {}),
    },
  );
}
const response = z
  .object({
    comparison: z.array(z.unknown()),
    diagnostics: z.array(z.unknown()),
    observedRustCalls: z.array(z.string()).nonempty(),
  })
  .strict();
function native(cases: Case[], executable: string) {
  return command(
    executable,
    [],
    `${cases.map((item) => JSON.stringify(item.script)).join("\n")}\n`,
  )
    .trim()
    .split("\n")
    .map((line) => response.parse(JSON.parse(line)));
}
const digest = (file: string) =>
  createHash("sha256").update(readFileSync(file)).digest("hex");
const eventWrite = `core.put(event_key(&core.event_prefix, seq), encoded_json(msg))
                .await?;`;
const metaWrite = `core.put(
                core.meta_key.clone(),
                encoded_json(PlainData::Object(indexmap::IndexMap::from([(
                    "lastSeq".into(),
                    PlainData::Number(seq),
                )]))),
            )
            .await?;`;
const mutations = [
  {
    id: "event-store-commits-meta-before-event",
    needle: `${eventWrite}\n            ${metaWrite}`,
    replacement: `${metaWrite}\n            ${eventWrite}`,
  },
  {
    id: "event-store-advances-snapshot-before-ack",
    needle:
      "self.put(self.snapshot_key.clone(), encoded_json(cell))\n            .await?;\n        self.snapshot_seq.set(seq);",
    replacement:
      "self.snapshot_seq.set(seq);\n        self.put(self.snapshot_key.clone(), encoded_json(cell))\n            .await?;",
  },
  {
    id: "event-store-reinitializes-recovered-snapshot",
    needle: "Some(state) => fold_msgs(&self.core.machine, state, events),",
    replacement:
      "Some(state) => { let initial = (self.core.machine.init)(Some(state), &self.core.input); fold_msgs(&self.core.machine, initial.state, events) },",
  },
  {
    id: "event-reader-excludes-inclusive-lower-bound",
    needle: "seq < self.range.from_seq",
    replacement: "seq <= self.range.from_seq",
  },
];
function controls(cases: Case[], expected: unknown[], progressPath: string) {
  const completed = [];
  for (const mutation of mutations) {
    const temporary = mkdtempSync(join(tmpdir(), "demlik-do-control-")),
      file = "crates/tea/src/durable_object/event_sourced.rs",
      before = digest(file);
    try {
      for (const manifest of ["Cargo.toml", "Cargo.lock"])
        cpSync(manifest, join(temporary, manifest));
      cpSync("crates", join(temporary, "crates"), {
        recursive: true,
        filter: (path) =>
          !path
            .split(sep)
            .some((part) => ["target", "node_modules", ".git"].includes(part)),
      });
      if (existsSync(".cargo"))
        cpSync(".cargo", join(temporary, ".cargo"), { recursive: true });
      const mutant = join(temporary, file),
        source = readFileSync(mutant, "utf8");
      assert.equal(digest(mutant), before);
      assert.equal(source.split(mutation.needle).length, 2, mutation.id);
      writeFileSync(
        mutant,
        source.replace(mutation.needle, mutation.replacement),
      );
      const target = join(temporary, "target");
      process.stderr.write(`Compiling DO control ${mutation.id}\n`);
      build(temporary, target);
      const executable = binary(temporary, target),
        results = native(cases, executable);
      assert.equal(results.length, cases.length);
      const detectedIds = cases
        .filter((_, index) => {
          try {
            assert.deepEqual(results[index].comparison, expected[index]);
            return false;
          } catch {
            return true;
          }
        })
        .map((item) => item.id);
      assert(detectedIds.length, mutation.id);
      assert.equal(digest(file), before);
      completed.push({
        id: mutation.id,
        isolation: "disposable-source-copy",
        sourceBeforeSha256: before,
        mutantSourceSha256: digest(mutant),
        nativeBinarySha256: digest(executable),
        activeSourceUnchanged: true,
        detectedIds,
      });
      mkdirSync(dirname(progressPath), { recursive: true });
      writeFileSync(progressPath, `${JSON.stringify(completed, null, 2)}\n`);
      process.stderr.write(
        `Detected ${mutation.id}: ${detectedIds.length} cases\n`,
      );
    } finally {
      rmSync(temporary, { recursive: true, force: true });
      assert.equal(digest(file), before);
    }
  }
  return completed;
}
export async function verifyDurableObject(
  reportPath = "target/parity/durable-object.json",
  binaryOverride?: string,
  mutationCheck = false,
) {
  assert.equal(process.version, "v22.21.1");
  assert.equal(process.versions.v8, "12.4.254.21-node.33");
  if (!binaryOverride) build();
  const executable = binaryOverride ?? binary(),
    cases = durableObjectCases(),
    source: Awaited<ReturnType<typeof executeDurableObject>>[] = [];
  for (const item of cases)
    source.push(await executeDurableObject(item.script));
  const results = native(cases, executable);
  assert.equal(results.length, cases.length);
  const mismatches = cases.flatMap((item, index) => {
    try {
      assert.deepEqual(results[index].comparison, source[index].comparison);
      return [];
    } catch (error) {
      return [{ id: item.id, error: String(error) }];
    }
  });
  const resultAt = (id: string, position: number) => {
    const index = cases.findIndex((item) => item.id === id);
    assert(index >= 0);
    return z
      .object({
        result: z.object({ ok: z.boolean(), value: z.unknown().optional() }),
      })
      .parse(source[index].comparison[position]).result;
  };
  assert.deepEqual(resultAt("do.events.cold-parallel-overwrite", 1).value, [
    ["@@es/evt/0000000000000001", '{"type":"add","by":2}'],
    ["@@es/meta", '{"lastSeq":1}'],
  ]);
  assert.deepEqual(
    resultAt("do.events.snapshot-fold-skips-active-init", 0).value,
    { type: "state", n: 6, value: null },
  );
  assert.equal(resultAt("do.events.reader-failure-after", 1).ok, false);
  assert.equal(resultAt("do.events.codec-failure-ready", 1).ok, false);
  assert.deepEqual(resultAt("do.events.codec-failure-ready", 3).value, {
    kind: "state",
    value: { type: "state", n: 0, value: null },
    same: true,
  });
  assert.equal(resultAt("do.snapshot.serializer-failure", 1).ok, false);
  assert.deepEqual(resultAt("do.snapshot.serializer-failure", 2).value, []);
  const cargo = process.env.CARGO ?? "cargo",
    rustc =
      process.env.RUSTC ??
      (isAbsolute(cargo) ? join(dirname(cargo), "rustc") : "rustc");
  const report = {
    comparison:
      "actual snapshot/event-store actions, storage ordering and bytes, failures, callbacks, retained models, lazy event ranges and recovery; raw platform syntax diagnostics retained separately",
    qualification:
      "native fixture explicitly submits borrowed futures at its host seam; controlled LocalSet traces do not establish arbitrary Ready-future/join/select/custom-executor ordering. These paired Store actions are not additional Promise-vs-Effect runtime cases.",
    openGaps: [],
    qualifications: [
      "Raw cells use bounded acyclic PlainData payloads and actual shared root array/object identity.",
      "Controlled host traces do not establish arbitrary Ready/join/select/custom-executor scheduling.",
    ],
    runtime: {
      node: process.version,
      v8: process.versions.v8,
      rustc: command(rustc, ["--version"]).trim(),
    },
    sourceSha256: {
      snapshot: digest("packages/tea/src/do/index.ts"),
      events: digest("packages/tea/src/do/event-sourced-store.ts"),
    },
    binary: { path: executable, sha256: digest(executable) },
    compared: cases.length,
    passed: cases.length - mismatches.length,
    actions: cases.reduce((sum, item) => sum + item.script.actions.length, 0),
    mismatches,
    failures: mismatches,
    controls:
      mutationCheck && !mismatches.length
        ? controls(
            cases,
            source.map((value) => value.comparison),
            join(dirname(reportPath), "durable-object-controls-progress.json"),
          )
        : [],
    cases: cases.map((item, index) => ({
      ...item,
      ...results[index],
      equal: !mismatches.some((failure) => failure.id === item.id),
      source: source[index],
      functions: [...new Set(results[index].observedRustCalls)].sort(),
    })),
  };
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  assert.equal(mismatches.length, 0, JSON.stringify(mismatches.slice(0, 3)));
  return report;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const { values } = parseArgs({
    options: {
      report: { type: "string" },
      "native-binary": { type: "string" },
      "mutation-check": { type: "boolean", default: false },
    },
    strict: true,
  });
  const report = await verifyDurableObject(
    values.report,
    values["native-binary"],
    values["mutation-check"],
  );
  console.log(
    JSON.stringify({
      compared: report.compared,
      actions: report.actions,
      mismatches: report.mismatches.length,
      openGaps: report.openGaps,
      controls: report.controls.map((control) => ({
        id: control.id,
        detected: control.detectedIds.length,
      })),
      report: values.report ?? "target/parity/durable-object.json",
    }),
  );
}
