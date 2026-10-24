import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { restore } from "../../packages/tea/src/internal/engine/restore.ts";
import { memoryStore } from "../../packages/tea/src/mem/index.ts";
import { fileStore } from "../../packages/tea/src/node/index.ts";
import { structuralHash, subIdOf } from "../../packages/tea/src/pure/core.ts";
import {
  type DeletableStore,
  isFencedStore,
  type Migrated,
  Refusal,
  refuse,
  type Schema,
  StoreConflictError,
  StoreRefusedError,
  schemaMigrate,
} from "../../packages/tea/src/runtime-types.ts";

export const storageDiagnostics: unknown[] = [];
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
const raw = z.custom<Json>();
function encodeNumber(value: number): Json {
  if (Number.isNaN(value)) return { $number: "NaN" };
  if (value === Infinity) return { $number: "Infinity" };
  if (value === -Infinity) return { $number: "-Infinity" };
  if (Object.is(value, -0)) return { $number: "-0" };
  return value;
}
const number = z.union([
  z.number(),
  z
    .object({ $number: z.enum(["NaN", "Infinity", "-Infinity", "-0"]) })
    .transform(
      ({ $number }) =>
        ({ NaN, Infinity, "-Infinity": -Infinity, "-0": -0 })[$number],
    ),
]);
function text(value: string): Json {
  const units: number[] = [];
  let lone = false;
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    units.push(unit);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff)
        units.push(value.charCodeAt(++index));
      else lone = true;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) lone = true;
  }
  return lone ? { $utf16: units } : value;
}
function normalize(value: unknown): Json {
  if (value === undefined) return { $undefined: true };
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return encodeNumber(value);
  if (typeof value === "string") return text(value);
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === "object") {
    const entries = Object.entries(value);
    return entries.some(([key]) => typeof text(key) !== "string")
      ? {
          $object: entries.map(([key, value]) => [text(key), normalize(value)]),
        }
      : Object.fromEntries(
          entries.map(([key, value]) => [key, normalize(value)]),
        );
  }
  throw new Error(`unsupported fixture value ${typeof value}`);
}
function faultValue(value: unknown): unknown {
  if (value instanceof StoreRefusedError) return refusedValue(value);
  if (value instanceof Error)
    return { name: value.name, message: value.message };
  return value;
}
function refusedValue(
  error: StoreRefusedError,
  cause: (value: unknown) => unknown = faultValue,
) {
  return {
    name: error.name,
    _tag: error._tag,
    message: error.message,
    reason: error.reason,
    ...("cause" in error ? { cause: cause(error.cause) } : {}),
  };
}
function conflictValue(error: StoreConflictError) {
  return {
    name: error.name,
    _tag: error._tag,
    message: error.message,
    expectedVersion: encodeNumber(error.expectedVersion),
    actualVersion: encodeNumber(error.actualVersion),
  };
}
const parseMode = z.enum(["identity", "strict", "refuse"]).default("identity");
const memoryAction = z.discriminatedUnion("op", [
  z.object({ op: z.literal("load"), as: z.string().optional() }),
  z.object({ op: z.literal("loadFenced"), as: z.string().optional() }),
  z.object({ op: z.literal("save"), reference: z.string() }),
  z.object({
    op: z.literal("saveFenced"),
    reference: z.string(),
    expected: number,
  }),
  z.object({
    op: z.literal("migrate"),
    reference: z.string().optional(),
    as: z.string().optional(),
  }),
  z.object({
    op: z.literal("mutate"),
    reference: z.string(),
    path: z.array(z.union([z.string(), z.number()])),
    value: raw,
    push: z.boolean().default(false),
  }),
  z.object({ op: z.literal("same"), left: z.string(), right: z.string() }),
  z.object({ op: z.literal("snapshot"), reference: z.string() }),
  z.object({ op: z.literal("delete") }),
]);
const memoryInput = z.object({
  objects: z.record(z.string(), raw).default({}),
  initial: z.string().optional(),
  fenced: z.boolean().default(false),
  parse: parseMode,
  actions: z.array(memoryAction),
});
async function memory(input: z.output<typeof memoryInput>) {
  const objects: Record<string, unknown> = input.objects;
  const parse =
    input.parse === "identity"
      ? undefined
      : input.parse === "refuse"
        ? () => refuse("unsupported saved state")
        : schemaMigrate(z.object({ count: z.number() }));
  const store = memoryStore<unknown>(
    input.initial ? objects[input.initial] : null,
    parse,
    input.fenced ? { fenced: true } : {},
  );
  const observations: unknown[] = [];
  for (const action of input.actions) {
    switch (action.op) {
      case "load": {
        const value = await store.load();
        if (action.as) objects[action.as] = value;
        observations.push({ op: action.op, raw: value });
        break;
      }
      case "loadFenced": {
        if (!isFencedStore(store)) throw new Error("store is not fenced");
        const { raw, version } = await store.loadFenced();
        if (action.as) objects[action.as] = raw;
        observations.push({
          op: action.op,
          raw,
          version: encodeNumber(version),
        });
        break;
      }
      case "save":
        await store.save(objects[action.reference]);
        observations.push({ op: action.op });
        break;
      case "saveFenced": {
        if (!isFencedStore(store)) throw new Error("store is not fenced");
        try {
          observations.push({
            op: action.op,
            version: encodeNumber(
              await store.saveFenced(
                objects[action.reference],
                action.expected,
              ),
            ),
          });
        } catch (error) {
          if (!(error instanceof StoreConflictError)) throw error;
          observations.push({ op: action.op, error: conflictValue(error) });
        }
        break;
      }
      case "migrate": {
        const value = store.migrate(
          action.reference ? objects[action.reference] : null,
        );
        if (value instanceof Refusal)
          observations.push({ op: action.op, refusal: value });
        else {
          if (action.as) objects[action.as] = value;
          observations.push({ op: action.op, raw: value });
        }
        break;
      }
      case "delete":
        await store.delete();
        observations.push({ op: action.op });
        break;
      case "same":
        observations.push({
          op: action.op,
          same: Object.is(objects[action.left], objects[action.right]),
        });
        break;
      case "snapshot":
        observations.push({
          op: action.op,
          raw: structuredClone(objects[action.reference] ?? null),
        });
        break;
      case "mutate": {
        if (!action.push && action.path.length === 0)
          throw new Error("set mutation needs a property path");
        let target = objects[action.reference];
        const keys = action.push ? action.path : action.path.slice(0, -1);
        for (const key of keys) {
          if (typeof target !== "object" || target === null)
            throw new Error("mutation path is missing");
          target = Reflect.get(target, key);
        }
        if (action.push) {
          if (!Array.isArray(target))
            throw new Error("push target is not an array");
          target.push(action.value);
        } else {
          if (typeof target !== "object" || target === null)
            throw new Error("mutation target is missing");
          Reflect.set(target, action.path.at(-1) ?? "", action.value);
        }
        observations.push({ op: action.op });
        break;
      }
    }
  }
  return { fenced: isFencedStore(store), observations };
}

const schemaInput = z.object({
  raw: raw.optional(),
  schema: z.enum(["counter", "throw"]).default("counter"),
  upcast: z
    .enum(["identity", "legacy", "throw", "error", "invalid"])
    .default("identity"),
});
type Upgrade = z.output<typeof schemaInput>["upcast"];
function upgrade(mode: Upgrade, value: unknown) {
  if (mode === "throw") throw new Error("upcast failed");
  if (mode === "error") throw "upcast failed";
  if (mode === "invalid") return { invalid: true };
  if (mode === "legacy")
    return {
      label: "legacy",
      ...z.record(z.string(), z.unknown()).catch({}).parse(value),
    };
  return value;
}
function parseCounter(value: unknown) {
  return z
    .object({ count: z.number(), label: z.string().trim() })
    .safeParse(value);
}
function schema(input: z.output<typeof schemaInput>) {
  let parseCalls = 0;
  let upcastCalls = 0;
  const shape: Schema<unknown> = {
    safeParse(value) {
      parseCalls++;
      if (input.schema === "throw") throw new Error("schema failed");
      return parseCounter(value);
    },
  };
  const migrate =
    input.upcast === "identity"
      ? schemaMigrate(shape)
      : schemaMigrate(shape, (value) => {
          upcastCalls++;
          return upgrade(input.upcast, value);
        });
  let output: unknown;
  try {
    const value = migrate(input.raw);
    output = {
      migrated:
        value === null
          ? { kind: "fresh" }
          : value instanceof Refusal
            ? { kind: "refused", refusal: value }
            : { kind: "state", value },
    };
  } catch (error) {
    output = { threw: faultValue(error) };
  }
  return {
    ...z.object({}).passthrough().parse(output),
    parseCalls,
    upcastCalls,
  };
}
type Fault =
  | { kind: "error"; message: string }
  | { kind: "value"; value: Json }
  | { kind: "refused"; reason: string; cause?: Fault };
const fault: z.ZodType<Fault> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("error"), message: z.string() }),
    z.object({ kind: z.literal("value"), value: raw }),
    z.object({
      kind: z.literal("refused"),
      reason: z.string(),
      cause: fault.optional(),
    }),
  ]),
);
function faultInstance(value: Fault): unknown {
  switch (value.kind) {
    case "error":
      return new Error(value.message);
    case "value":
      return value.value;
    case "refused":
      return new StoreRefusedError(
        value.reason,
        value.cause ? { cause: faultInstance(value.cause) } : undefined,
      );
  }
}
const restoreInput = z.object({
  raw: raw.default(null),
  loadFault: fault.optional(),
  migrate: z
    .enum(["identity", "schema", "refuse", "throw", "plainRefusal"])
    .default("identity"),
  migrateFault: fault.optional(),
  upcast: schemaInput.shape.upcast,
});
async function restoreCase(input: z.output<typeof restoreInput>) {
  let loadCalls = 0;
  let migrateCalls = 0;
  let saveCalls = 0;
  let cell = input.raw;
  const store = {
    async load() {
      loadCalls++;
      if (input.loadFault) throw faultInstance(input.loadFault);
      return cell;
    },
    async save(state: Json) {
      saveCalls++;
      cell = state;
    },
    migrate(value: unknown): Migrated<unknown> {
      migrateCalls++;
      switch (input.migrate) {
        case "identity":
          return value;
        case "refuse":
          return refuse("not a saved State");
        case "plainRefusal":
          return { _tag: "refusal", reason: "ordinary model data" };
        case "throw":
          throw faultInstance(
            input.migrateFault ?? {
              kind: "error",
              message: "migration failed",
            },
          );
        case "schema":
          return schemaMigrate({ safeParse: parseCounter }, (raw) =>
            upgrade(input.upcast, raw),
          )(value);
      }
    },
  };
  let output: unknown;
  try {
    output = { restored: await restore(store) };
  } catch (error) {
    if (!(error instanceof StoreRefusedError)) throw error;
    output = { error: refusedValue(error) };
  }
  return {
    ...z.object({}).passthrough().parse(output),
    loadCalls,
    migrateCalls,
    saveCalls,
    rawAfter: cell,
  };
}

const fileAction = z.discriminatedUnion("op", [
  z.object({
    op: z.enum([
      "load",
      "loadFenced",
      "restore",
      "delete",
      "readFiles",
      "stateDirectory",
      "parentFile",
      "deadLock",
    ]),
  }),
  z.object({ op: z.literal("save"), json: z.string().optional() }),
  z.object({ op: z.literal("migrate"), json: z.string().optional() }),
  z.object({
    op: z.literal("saveFenced"),
    json: z.string().optional(),
    expected: number,
  }),
  z.object({ op: z.literal("writeRaw"), value: z.string() }),
  z.object({ op: z.literal("writeFence"), value: z.string() }),
]);
const fileInput = z.object({
  path: z.string().optional(),
  fenced: z.boolean().default(false),
  raw: z.string().optional(),
  bytes: z.array(z.number().int().min(0).max(255)).optional(),
  fence: z.string().optional(),
  parse: parseMode,
  actions: z.array(fileAction),
});
function fileError(error: unknown, root: string): unknown {
  storageDiagnostics.push({
    source: "fileStore",
    error:
      error instanceof Error
        ? {
            ...error,
            name: error.name,
            message: error.message,
            stack: error.stack,
          }
        : error,
  });
  if (error instanceof StoreConflictError) return conflictValue(error);
  if (error instanceof SyntaxError)
    return { name: error.name, kind: "invalid_json" };
  if (error instanceof TypeError && "code" in error)
    return { name: error.name, code: error.code, message: error.message };
  if (error instanceof Error && "code" in error)
    return { name: error.name, code: error.code };
  if (error instanceof Error)
    return {
      name: error.name,
      message: error.message.replaceAll(root, "<dir>"),
    };
  return error;
}
async function file(input: z.output<typeof fileInput>) {
  const temporary = input.path
    ? undefined
    : await mkdtemp(join(tmpdir(), "demlik-storage-parity-"));
  const path = input.path ?? join(temporary ?? "", "state.json");
  const root = dirname(path);
  const setup = async (name: string, value: string | Uint8Array) => {
    await mkdir(root, { recursive: true });
    await writeFile(name, value);
  };
  try {
    if (input.raw !== undefined) await setup(path, input.raw);
    if (input.bytes) await setup(path, Uint8Array.from(input.bytes));
    if (input.fence !== undefined) await setup(`${path}.fence`, input.fence);
    const parse =
      input.parse === "identity"
        ? (value: unknown) => value
        : input.parse === "strict"
          ? schemaMigrate(z.object({ count: z.number() }))
          : () => refuse("not a saved State");
    const store: DeletableStore<unknown> = fileStore(
      path,
      parse,
      input.fenced ? { fenced: true } : {},
    );
    const observations: unknown[] = [];
    async function contents(name: string) {
      try {
        return await readFile(name);
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          ["ENOENT", "ENOTDIR", "EISDIR"].includes(String(error.code))
        )
          return null;
        throw error;
      }
    }
    async function files() {
      const state = await contents(path);
      const fence = await contents(`${path}.fence`);
      const lock = await contents(`${path}.fence.lock`);
      const names = await readdir(root).catch(() => []);
      return {
        stateText: state?.toString("utf8") ?? null,
        stateBytes: state ? [...state] : null,
        fenceText: fence?.toString("utf8") ?? null,
        lockPresent: lock !== null,
        files: names
          .map((name) => name.replaceAll(`.${process.pid}.`, ".<pid>."))
          .sort(),
      };
    }
    for (const action of input.actions) {
      try {
        switch (action.op) {
          case "load":
            observations.push({
              op: action.op,
              raw: normalize(await store.load()),
            });
            break;
          case "loadFenced": {
            if (!isFencedStore(store)) throw new Error("store is not fenced");
            const value = await store.loadFenced();
            observations.push({
              op: action.op,
              raw: normalize(value.raw),
              version: encodeNumber(value.version),
            });
            break;
          }
          case "save":
            await store.save(
              "json" in action && action.json !== undefined
                ? JSON.parse(action.json)
                : undefined,
            );
            observations.push({ op: action.op });
            break;
          case "migrate": {
            const value = store.migrate(
              action.json !== undefined ? JSON.parse(action.json) : undefined,
            );
            observations.push(
              value === null
                ? { op: action.op, kind: "fresh" }
                : value instanceof Refusal
                  ? { op: action.op, kind: "refused", refusal: value }
                  : { op: action.op, kind: "state", value: normalize(value) },
            );
            break;
          }
          case "saveFenced": {
            if (!isFencedStore(store) || !("expected" in action))
              throw new Error("store is not fenced");
            const version = await store.saveFenced(
              action.json !== undefined ? JSON.parse(action.json) : undefined,
              action.expected,
            );
            observations.push({
              op: action.op,
              version: encodeNumber(version),
            });
            break;
          }
          case "restore": {
            try {
              const value = await restore(store);
              observations.push({
                op: action.op,
                raw: value === null ? null : normalize(value),
              });
            } catch (error) {
              if (!(error instanceof StoreRefusedError)) throw error;
              const value = refusedValue(error, (cause) =>
                fileError(cause, root),
              );
              if (
                error.cause instanceof SyntaxError ||
                (error.cause instanceof Error && "code" in error.cause)
              ) {
                const reason = "the saved state could not be read (<cause>)";
                value.reason = reason;
                value.message = new StoreRefusedError(reason).message;
              }
              observations.push({ op: action.op, error: value });
            }
            break;
          }
          case "delete":
            await store.delete();
            observations.push({ op: action.op });
            break;
          case "readFiles":
            observations.push({ op: action.op, files: await files() });
            break;
          case "writeRaw":
            if ("value" in action) await setup(path, action.value);
            observations.push({ op: action.op });
            break;
          case "writeFence":
            if ("value" in action) await setup(`${path}.fence`, action.value);
            observations.push({ op: action.op });
            break;
          case "stateDirectory":
            await mkdir(path, { recursive: true });
            observations.push({ op: action.op });
            break;
          case "parentFile":
            await mkdir(dirname(root), { recursive: true });
            await writeFile(root, "parent remains");
            observations.push({ op: action.op });
            break;
          case "deadLock": {
            const child = spawn(process.execPath, ["-e", ""], {
              stdio: "ignore",
            });
            const pid = child.pid;
            await new Promise<void>((resolve, reject) => {
              child.once("error", reject);
              child.once("exit", () => resolve());
            });
            if (!pid) throw new Error("child has no PID");
            await setup(`${path}.fence.lock`, String(pid));
            observations.push({ op: action.op });
            break;
          }
        }
      } catch (error) {
        observations.push({ error: fileError(error, root) });
      }
    }
    return { fenced: isFencedStore(store), observations };
  } finally {
    if (temporary) await rm(temporary, { recursive: true, force: true });
  }
}
export const storageOperations: Record<string, (input: unknown) => unknown> = {
  "tea.storage.memory": (input) => memory(memoryInput.parse(input)),
  "tea.storage.schema": (input) => schema(schemaInput.parse(input)),
  "tea.storage.restore": (input) => restoreCase(restoreInput.parse(input)),
  "tea.storage.file": (input) => file(fileInput.parse(input)),
  "tea.storage.data": (input) => {
    const value = JSON.parse(z.object({ json: z.string() }).parse(input).json);
    return {
      value: normalize(value),
      json: JSON.stringify(value),
      hash: structuralHash(value),
      subId: subIdOf("pulse", value),
    };
  },
  "tea.storage.helpers": (input) => {
    const value = z
      .object({
        reason: z.string(),
        cause: raw.optional(),
        expected: number,
        actual: number,
      })
      .parse(input);
    return {
      refusal: refuse(value.reason),
      refused: refusedValue(
        new StoreRefusedError(
          value.reason,
          "cause" in value ? { cause: value.cause } : undefined,
        ),
      ),
      conflict: conflictValue(
        new StoreConflictError(value.expected, value.actual),
      ),
    };
  },
};
