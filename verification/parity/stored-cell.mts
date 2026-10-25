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
import { Cause, Effect, Exit, Scope } from "effect";
import { z } from "zod";
import { doStore } from "../../packages/tea/src/do/index.js";
import { run as effectRun } from "../../packages/tea/src/effect/index.js";
import {
  defineMachine,
  type FencedStore,
  StoreConflictError,
} from "../../packages/tea/src/index.js";
import { run as promiseRun } from "../../packages/tea/src/promise/index.js";
import { Gate, storageFixture } from "./durable-object.mts";
import { decode, normalize } from "./timing-clock.mts";

const value = z.unknown().refine((v) => z.json().safeParse(v).success);
const point = z.enum(["get", "put", "commit"]),
  stage = z.enum(["before", "after"]);
const action = z.discriminatedUnion("op", [
  z
    .object({
      op: z.enum(["seed", "put"]),
      key: z.string(),
      reference: z.string(),
    })
    .strict(),
  z
    .object({ op: z.literal("get"), key: z.string(), alias: z.string() })
    .strict(),
  z
    .object({ op: z.literal("list"), prefix: z.string(), alias: z.string() })
    .strict(),
  z
    .object({
      op: z.literal("clone"),
      reference: z.string(),
      alias: z.string(),
    })
    .strict(),
  z
    .object({ op: z.literal("same"), left: z.string(), right: z.string() })
    .strict(),
  z
    .object({ op: z.enum(["peek", "errorView"]), reference: z.string() })
    .strict(),
  z
    .object({
      op: z.enum(["replaceArray", "codecMutation"]),
      reference: z.string(),
      values: z.array(value),
    })
    .strict(),
  z
    .object({
      op: z.literal("insert"),
      reference: z.string(),
      key: z.string(),
      value,
    })
    .strict(),
  z.object({ op: z.literal("loadFenced"), alias: z.string() }).strict(),
  z
    .object({
      op: z.literal("saveFenced"),
      expected: z.string(),
      state: value,
      alias: z.string(),
    })
    .strict(),
  z
    .object({
      op: z.literal("newError"),
      expected: z.string(),
      actual: z.string(),
      alias: z.string(),
    })
    .strict(),
  z
    .object({ op: z.literal("codecFault"), message: z.string(), value })
    .strict(),
  z
    .object({
      op: z.literal("fault"),
      at: point,
      stage,
      key: z.string().nullable().optional(),
      message: z.string(),
      value,
    })
    .strict(),
  z
    .object({
      op: z.literal("race"),
      expected: z.string(),
      first: value,
      second: value,
      at: point,
      stage,
      alias: z.string(),
      mutation: z.array(value).optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal("parallelGet"),
      first: z.string(),
      second: z.string(),
      stage,
      order: z.enum(["forward", "reverse"]),
      alias: z.string(),
    })
    .strict(),
]);
export const storedCellScript = z.discriminatedUnion("target", [
  z
    .object({
      target: z.literal("cells"),
      cloneReads: z.boolean(),
      values: z.array(z.object({ id: z.string(), value }).strict()),
      actions: z.array(action),
    })
    .strict(),
  z
    .object({
      target: z.literal("runtime"),
      profile: z.enum(["promise", "effect"]),
      seed: value,
    })
    .strict(),
]);
type Script = z.infer<typeof storedCellScript>;
type CellScript = Extract<Script, { target: "cells" }>;
type Action = z.infer<typeof action>;
type Case = { id: string; script: Script };
class CodecIssue extends Error {
  override readonly name = "CodecIssue";
  constructor(
    message: string,
    readonly value: unknown,
  ) {
    super(message);
  }
}
function view(error: unknown): unknown {
  if (error instanceof StoreConflictError)
    return {
      kind: "conflict",
      name: error.name,
      tag: error._tag,
      message: normalize(error.message),
      expected: normalize(error.expectedVersion),
      actual: normalize(error.actualVersion),
    };
  if (error instanceof TypeError)
    return {
      kind: "type",
      name: error.name,
      message: normalize(error.message),
    };
  if (error instanceof CodecIssue)
    return {
      kind: "codec",
      message: error.message,
      value: normalize(error.value),
    };
  const storage = z
    .object({
      name: z.literal("StorageFailure"),
      at: z.string(),
      stage: z.string(),
      message: z.string(),
      value: z.unknown(),
    })
    .safeParse(error);
  if (storage.success) {
    const e = storage.data;
    return {
      kind: "storage",
      at: e.at === "commit" ? "transaction" : e.at,
      stage: e.stage,
      message: e.message,
      value: normalize(e.value),
    };
  }
  if (error instanceof Error)
    return { kind: "unexpected", message: normalize(error.message) };
  return { kind: "unexpected", value: normalize(error) };
}
function array(v: unknown): unknown[] {
  if (!Array.isArray(v)) throw new Error("fixture array required");
  return v;
}
function object(v: unknown): object {
  if (v === null || typeof v !== "object" || Array.isArray(v))
    throw new Error("fixture object required");
  return v;
}
function ref(values: Map<string, unknown>, name: string) {
  if (!values.has(name)) throw new Error(`missing fixture reference ${name}`);
  return values.get(name);
}
export async function executeStoredCell(input: unknown) {
  const script = storedCellScript.parse(input);
  if (script.target === "runtime") return runtimeCase(script);
  const fixture = storageFixture([], script.cloneReads),
    values = new Map(script.values.map((v) => [v.id, decode(v.value)])),
    errors = new Map<string, unknown>(),
    hooks: unknown[] = [],
    observedSourceCalls: string[] = [];
  const called = <T,>(name: string, body: () => T): T => {
    observedSourceCalls.push(name);
    return body();
  };
  let mutation: { reference: unknown[]; values: unknown[] } | undefined,
    fault: CodecIssue | undefined;
  const store: FencedStore<unknown> = called("doStore", () =>
    Reflect.apply(doStore, undefined, [
      fixture.storage,
      (raw: unknown) => raw,
      {
        fenced: true,
        serialize: (state: unknown) => {
          hooks.push({ op: "serialize", state: normalize(state) });
          const pending = mutation;
          mutation = undefined;
          if (pending) {
            const old = pending.reference.splice(
              0,
              pending.reference.length,
              ...pending.values,
            );
            hooks.push({ op: "codecMutation", old: normalize(old) });
          }
          const error = fault;
          fault = undefined;
          if (error) throw error;
          return state;
        },
      },
    ]),
  );
  const comparison: unknown[] = [];
  let callCursor = 0,
    hookCursor = 0;
  const save = async (expected: unknown, state: unknown, alias: string) => {
    try {
      const version = await called("FencedStore.saveFenced", () =>
        Reflect.apply(store.saveFenced, store, [state, expected]),
      );
      values.set(alias, version);
      return { ok: true, version: normalize(version) };
    } catch (error) {
      errors.set(alias, error);
      return { ok: false, error: view(error) };
    }
  };
  for (const a of script.actions) {
    let result: unknown = null;
    switch (a.op) {
      case "seed":
        fixture.seed(a.key, ref(values, a.reference));
        break;
      case "put":
        await called("DurableObjectStorage.put", () =>
          fixture.storage.put(a.key, ref(values, a.reference)),
        );
        break;
      case "get": {
        const v = await called("DurableObjectStorage.get", () =>
          fixture.storage.get(a.key),
        );
        values.set(a.alias, v);
        result = normalize(v);
        break;
      }
      case "list": {
        const rows = await called("DurableObjectStorage.list", () =>
          fixture.storage.list({ prefix: a.prefix }),
        );
        result = [...rows].map(([key, v]) => [normalize(key), normalize(v)]);
        [...rows.values()].forEach((v, index) => {
          values.set(`${a.alias}:${index}`, v);
        });
        break;
      }
      case "clone":
        values.set(a.alias, structuredClone(ref(values, a.reference)));
        break;
      case "same":
        result = ref(values, a.left) === ref(values, a.right);
        break;
      case "peek":
        result = normalize(ref(values, a.reference));
        break;
      case "replaceArray": {
        const v = array(ref(values, a.reference));
        result = normalize(v.splice(0, v.length, ...a.values.map(decode)));
        break;
      }
      case "insert": {
        const v = object(ref(values, a.reference));
        const old = Object.hasOwn(v, a.key) ? Reflect.get(v, a.key) : undefined;
        Object.defineProperty(v, a.key, {
          value: decode(a.value),
          writable: true,
          configurable: true,
          enumerable: true,
        });
        result = normalize(old);
        break;
      }
      case "loadFenced":
        try {
          const read = await called("FencedStore.loadFenced", () =>
            store.loadFenced(),
          );
          values.set(a.alias, read.version);
          result = {
            ok: true,
            raw: normalize(read.raw),
            version: normalize(read.version),
          };
        } catch (error) {
          errors.set(a.alias, error);
          result = { ok: false, error: view(error) };
        }
        break;
      case "saveFenced":
        result = await save(ref(values, a.expected), decode(a.state), a.alias);
        break;
      case "newError":
        try {
          const error = called("StoreConflictError", () =>
            Reflect.construct(StoreConflictError, [
              ref(values, a.expected),
              ref(values, a.actual),
            ]),
          );
          errors.set(a.alias, error);
          result = view(error);
        } catch (error) {
          errors.set(a.alias, error);
          result = view(error);
        }
        break;
      case "errorView":
        if (!errors.has(a.reference)) throw new Error("missing fixture error");
        result = view(errors.get(a.reference));
        break;
      case "codecMutation":
        mutation = {
          reference: array(ref(values, a.reference)),
          values: a.values.map(decode),
        };
        break;
      case "codecFault":
        fault = new CodecIssue(a.message, decode(a.value));
        break;
      case "fault":
        fixture.rules.push({
          at: a.at,
          stage: a.stage,
          key: a.key ?? undefined,
          remaining: 1,
          behavior: {
            kind: "fail",
            message: a.message,
            value: decode(a.value),
          },
        });
        break;
      case "parallelGet": {
        const gates = [new Gate("first"), new Gate("second")];
        fixture.rules.push(
          {
            at: "get",
            key: a.first,
            stage: a.stage,
            remaining: 1,
            behavior: { kind: "hold", gate: gates[0] },
          },
          {
            at: "get",
            key: a.second,
            stage: a.stage,
            remaining: 1,
            behavior: { kind: "hold", gate: gates[1] },
          },
        );
        const start = (key: string, index: number) =>
          called("DurableObjectStorage.get", () =>
            fixture.storage.get(key),
          ).then((value) => {
            values.set(`${a.alias}:${index}`, value);
            hooks.push({ op: "getCompletion", key, value: normalize(value) });
            return [key, normalize(value)];
          });
        const one = start(a.first, 0);
        await gates[0].wait(1);
        const two = start(a.second, 1);
        await gates[1].wait(1);
        const pending = [one, two],
          order = a.order === "forward" ? [0, 1] : [1, 0],
          out = [];
        for (const index of order) {
          gates[index].release();
          out.push(await pending[index]);
        }
        result = out;
        break;
      }
      case "race": {
        const gate = new Gate("writer");
        fixture.rules.push({
          at: a.at,
          stage: a.stage,
          key:
            a.at === "get"
              ? "@@state@@version"
              : a.at === "put"
                ? "@@state"
                : undefined,
          remaining: 1,
          behavior: { kind: "hold", gate },
        });
        const one = save(
          ref(values, a.expected),
          decode(a.first),
          `${a.alias}:0`,
        );
        await gate.wait(1);
        const count = fixture.requested();
        const two = save(
          ref(values, a.expected),
          decode(a.second),
          `${a.alias}:1`,
        );
        await fixture.waitTransactions(count + 1);
        if (a.mutation) {
          const v = array(ref(values, a.expected));
          v.splice(0, v.length, ...a.mutation.map(decode));
        }
        gate.release();
        result = await Promise.all([one, two]);
        break;
      }
    }
    comparison.push({
      result,
      calls: fixture.calls.slice(callCursor),
      hooks: hooks.slice(hookCursor),
      cells: fixture.state(),
    });
    callCursor = fixture.calls.length;
    hookCursor = hooks.length;
  }
  return { comparison, observedSourceCalls };
}
async function runtimeCase(script: Extract<Script, { target: "runtime" }>) {
  const fixture = storageFixture([
      { key: "@@state@@version", value: script.seed },
    ]),
    observedSourceCalls: string[] = [];
  const called = <T,>(name: string, body: () => T): T => {
    observedSourceCalls.push(name);
    return body();
  };
  type Model = { n: number };
  type Msg = { type: "inc"; by: number };
  const parse = (raw: unknown): Model | null => {
    const parsed = z.object({ n: z.number() }).safeParse(raw);
    return parsed.success ? parsed.data : null;
  };
  const store: FencedStore<Model> = called("doStore", () =>
    Reflect.apply(doStore, undefined, [
      fixture.storage,
      parse,
      { fenced: true },
    ]),
  );
  const machine = defineMachine({
    types: {
      model: z.object({ n: z.number() }).parse({ n: 0 }),
      msg: z
        .object({ type: z.literal("inc"), by: z.number() })
        .parse({ type: "inc", by: 0 }),
    },
    init: (loaded) => [loaded ?? { n: 0 }, []],
    update: { inc: (state, msg) => [{ n: state.n + msg.by }, []] },
  });
  const comparison: unknown[] = [];
  const settle = async <A, E>(effect: Effect.Effect<A, E>): Promise<A> => {
    const exit = await Effect.runPromiseExit(effect);
    if (Exit.isSuccess(exit)) return exit.value;
    throw Cause.squash(exit.cause);
  };
  for (let round = 0; round < 2; round++) {
    let state: () => Model,
      dispatch: (msg: Msg) => Promise<void>,
      stop: () => Promise<void>;
    if (script.profile === "promise") {
      const handle = called("promise.run", () =>
        promiseRun(machine, {
          ctx: undefined,
          store,
          interpret: {},
          clock: () => 0,
        }),
      );
      const runtime = await handle.ready;
      state = () => called("Runtime.getState", runtime.getState);
      dispatch = (msg) =>
        called("Runtime.dispatch", () => runtime.dispatch(msg));
      stop = () => called("Runtime.stop", () => runtime.stop());
    } else {
      const scope = await Effect.runPromise(Scope.make());
      const handle = await Effect.runPromise(
        Scope.provide(scope)(
          called("effect.run", () =>
            effectRun(machine, {
              ctx: undefined,
              store,
              interpret: {},
              clock: () => 0,
            }),
          ),
        ),
      );
      const runtime = await settle(handle.ready);
      state = () => called("Runtime.getState", runtime.getState);
      dispatch = (msg) =>
        called("Runtime.dispatch", () => settle(runtime.dispatch(msg)));
      stop = () =>
        called("Scope.close", () =>
          Effect.runPromise(Scope.close(scope, Exit.void)),
        );
    }
    const snapshot = (phase: string) =>
      comparison.push({
        phase,
        n: state().n,
        version: normalize(fixture.cells.get("@@state@@version")),
      });
    snapshot(round === 0 ? "boot" : "restart");
    if (round === 0) {
      for (const by of [1, 2]) {
        await dispatch({ type: "inc", by });
        snapshot("dispatch");
      }
    }
    await stop();
    snapshot(round === 0 ? "stop" : "restart-stop");
  }
  return { comparison, observedSourceCalls };
}

const state = (owner: string) => ({ owner });
function cellsCase(
  id: string,
  values: CellScript["values"],
  actions: Action[],
  cloneReads = false,
): Case {
  return {
    id,
    script: storedCellScript.parse({
      target: "cells",
      cloneReads,
      values,
      actions,
    }),
  };
}
export function storedCellCases(): Case[] {
  const cases: Case[] = [];
  const versions: unknown[] = [
    { $undefined: true },
    null,
    false,
    true,
    0,
    { $number: "-0" },
    { $number: "NaN" },
    { $number: "Infinity" },
    { $number: "-Infinity" },
    3.25,
    "",
    "1",
    { $utf16: [0xd800] },
    [],
    [2],
    [null],
    {},
    { n: 1 },
    { toString: null },
    [{ toString: null }],
  ];
  versions.forEach((version, index) => {
    for (const cloneReads of [false, true])
      cases.push(
        cellsCase(
          `cell.raw-${index}.${cloneReads ? "copied" : "retained"}`,
          [{ id: "seed", value: version }],
          [
            { op: "seed", key: "@@state@@version", reference: "seed" },
            { op: "loadFenced", alias: "read" },
            { op: "same", left: "seed", right: "read" },
            {
              op: "saveFenced",
              expected: "read",
              state: state("first"),
              alias: "first",
            },
            {
              op: "saveFenced",
              expected: "read",
              state: state("stale"),
              alias: "second",
            },
            { op: "loadFenced", alias: "after" },
          ],
          cloneReads,
        ),
      );
  });
  for (const cloneReads of [false, true])
    for (const v of [[1], { n: 1 }])
      cases.push(
        cellsCase(
          `cell.port-identity-${Array.isArray(v) ? "array" : "object"}-${cloneReads ? "copied" : "retained"}`,
          [{ id: "seed", value: v }],
          [
            { op: "put", key: "external", reference: "seed" },
            { op: "get", key: "external", alias: "read" },
            { op: "list", prefix: "e", alias: "rows" },
            { op: "same", left: "seed", right: "read" },
            { op: "same", left: "seed", right: "rows:0" },
            { op: "clone", reference: "read", alias: "copy" },
            { op: "same", left: "read", right: "copy" },
            Array.isArray(v)
              ? { op: "replaceArray", reference: "seed", values: [3] }
              : { op: "insert", reference: "seed", key: "n", value: 3 },
            { op: "peek", reference: "read" },
            { op: "peek", reference: "rows:0" },
          ],
          cloneReads,
        ),
      );
  for (const cloneReads of [false, true])
    for (const phase of ["before", "after"] as const)
      for (const order of ["forward", "reverse"] as const)
        cases.push(
          cellsCase(
            `cell.independent-held-${phase}-${order}-${cloneReads ? "copied" : "retained"}`,
            [
              { id: "first", value: [1] },
              { id: "second", value: [2] },
            ],
            [
              { op: "seed", key: "first", reference: "first" },
              { op: "seed", key: "second", reference: "second" },
              {
                op: "parallelGet",
                first: "first",
                second: "second",
                stage: phase,
                order,
                alias: "read",
              },
              { op: "same", left: "first", right: "read:0" },
              { op: "same", left: "second", right: "read:1" },
              { op: "replaceArray", reference: "first", values: [9] },
              { op: "peek", reference: "read:0" },
            ],
            cloneReads,
          ),
        );
  cases.push(
    cellsCase(
      "cell.error-frozen-array-fields",
      [
        { id: "expected", value: [1] },
        { id: "actual", value: [2] },
      ],
      [
        {
          op: "newError",
          expected: "expected",
          actual: "actual",
          alias: "error",
        },
        { op: "replaceArray", reference: "expected", values: [3] },
        { op: "replaceArray", reference: "actual", values: [4] },
        { op: "errorView", reference: "error" },
      ],
    ),
  );
  cases.push(
    cellsCase(
      "cell.error-retained-object-fields",
      [
        { id: "expected", value: { n: 1 } },
        { id: "actual", value: { n: 2 } },
      ],
      [
        {
          op: "newError",
          expected: "expected",
          actual: "actual",
          alias: "error",
        },
        { op: "insert", reference: "expected", key: "n", value: 3 },
        { op: "insert", reference: "actual", key: "n", value: 4 },
        { op: "errorView", reference: "error" },
      ],
    ),
  );
  for (const [id, expected, actual] of [
    ["utf16", { $utf16: [0xd800] }, 0],
    ["nan", { $number: "NaN" }, { $number: "NaN" }],
    ["failed-first", { toString: null }, 0],
    ["failed-second", 0, { toString: null }],
    ["failed-nested", [{ toString: null }], 0],
  ] satisfies Array<[string, unknown, unknown]>)
    cases.push(
      cellsCase(
        `cell.error-${id}`,
        [
          { id: "expected", value: expected },
          { id: "actual", value: actual },
        ],
        [
          {
            op: "newError",
            expected: "expected",
            actual: "actual",
            alias: "error",
          },
          { op: "errorView", reference: "error" },
        ],
      ),
    );
  cases.push(
    cellsCase(
      "cell.signed-zero-equality",
      [
        { id: "positive", value: 0 },
        { id: "negative", value: { $number: "-0" } },
      ],
      [
        { op: "same", left: "positive", right: "negative" },
        { op: "seed", key: "@@state@@version", reference: "positive" },
        {
          op: "saveFenced",
          expected: "negative",
          state: state("zero"),
          alias: "saved",
        },
      ],
    ),
  );
  cases.push(
    cellsCase(
      "cell.source-order-next-before-codec",
      [{ id: "seed", value: [1] }],
      [
        { op: "seed", key: "@@state@@version", reference: "seed" },
        { op: "loadFenced", alias: "read" },
        { op: "codecMutation", reference: "seed", values: [9] },
        {
          op: "saveFenced",
          expected: "read",
          state: state("saved"),
          alias: "saved",
        },
        { op: "peek", reference: "read" },
        { op: "loadFenced", alias: "after" },
      ],
    ),
  );
  cases.push(
    cellsCase(
      "cell.source-order-coercion-before-codec",
      [{ id: "seed", value: { toString: null } }],
      [
        { op: "seed", key: "@@state@@version", reference: "seed" },
        { op: "loadFenced", alias: "read" },
        {
          op: "codecFault",
          message: "codec must not run",
          value: { owner: "codec" },
        },
        {
          op: "saveFenced",
          expected: "read",
          state: state("refused"),
          alias: "error",
        },
        { op: "errorView", reference: "error" },
      ],
    ),
  );
  cases.push(
    cellsCase(
      "cell.codec-failure-keeps-raw-cell",
      [{ id: "seed", value: [1] }],
      [
        { op: "seed", key: "@@state@@version", reference: "seed" },
        { op: "loadFenced", alias: "read" },
        {
          op: "codecFault",
          message: "cannot encode",
          value: { owner: "codec" },
        },
        {
          op: "saveFenced",
          expected: "read",
          state: state("refused"),
          alias: "error",
        },
        { op: "same", left: "seed", right: "read" },
        {
          op: "saveFenced",
          expected: "read",
          state: state("retried"),
          alias: "saved",
        },
      ],
    ),
  );
  for (const at of ["get", "put", "commit"] as const)
    for (const phase of ["before", "after"] as const) {
      const key =
        at === "get" ? "@@state@@version" : at === "put" ? "@@state" : null;
      cases.push(
        cellsCase(
          `cell.raw-failure-${at}-${phase}`,
          [{ id: "seed", value: [2] }],
          [
            { op: "seed", key: "@@state@@version", reference: "seed" },
            { op: "loadFenced", alias: "read" },
            {
              op: "fault",
              at,
              stage: phase,
              key,
              message: "storage refused",
              value: { owner: "storage" },
            },
            {
              op: "saveFenced",
              expected: "read",
              state: state("first"),
              alias: "error",
            },
            { op: "errorView", reference: "error" },
            {
              op: "saveFenced",
              expected: "read",
              state: state("retry"),
              alias: "retried",
            },
          ],
        ),
      );
      for (const [name, version] of [
        ["string", "1"],
        ["array", [2]],
        ["object", { n: 1 }],
      ] satisfies Array<[string, unknown]>)
        cases.push(
          cellsCase(
            `cell.raw-race-${name}-${at}-${phase}`,
            [{ id: "seed", value: version }],
            [
              { op: "seed", key: "@@state@@version", reference: "seed" },
              { op: "loadFenced", alias: "read" },
              {
                op: "race",
                expected: "read",
                first: state("first"),
                second: state("second"),
                at,
                stage: phase,
                alias: "race",
              },
              ...(name === "array"
                ? [
                    {
                      op: "replaceArray" as const,
                      reference: "read",
                      values: [9],
                    },
                  ]
                : []),
              { op: "errorView", reference: "race:1" },
              { op: "loadFenced", alias: "after" },
            ],
          ),
        );
    }
  for (const phase of ["before", "after"] as const)
    cases.push(
      cellsCase(
        `cell.held-mutation-${phase}`,
        [{ id: "seed", value: [2] }],
        [
          { op: "seed", key: "@@state@@version", reference: "seed" },
          { op: "loadFenced", alias: "read" },
          {
            op: "race",
            expected: "read",
            first: state("first"),
            second: state("second"),
            at: "get",
            stage: phase,
            alias: "race",
            mutation: [7],
          },
          { op: "errorView", reference: "race:1" },
        ],
      ),
    );
  for (const profile of ["promise", "effect"] as const)
    for (const [id, seed] of [
      ["string", "v"],
      ["bool", true],
      ["array", [2]],
      ["object", {}],
    ] satisfies Array<[string, unknown]>)
      cases.push({
        id: `cell.runtime-lease-${profile}-${id}`,
        script: storedCellScript.parse({ target: "runtime", profile, seed }),
      });
  assert.equal(new Set(cases.map((v) => v.id)).size, cases.length);
  return cases;
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
const digest = (path: string) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");
function binary(cwd = process.cwd(), target = process.env.CARGO_TARGET_DIR) {
  return join(
    target ? resolve(cwd, target) : join(cwd, "target"),
    "debug/examples/stored_cell_driver",
  );
}
function build(cwd = process.cwd(), target?: string) {
  command(
    process.env.CARGO ?? "cargo",
    [
      "build",
      "--locked",
      "-p",
      "demlik-tea",
      "--example",
      "stored_cell_driver",
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
const nativeResponse = z.union([
  z
    .object({
      comparison: z.array(z.unknown()),
      observedRustCalls: z.array(z.string()).nonempty(),
    })
    .strict(),
  z.object({ error: z.string() }).strict(),
]);
function native(cases: Case[], executable: string) {
  return command(
    executable,
    [],
    `${cases.map((c) => JSON.stringify(c.script)).join("\n")}\n`,
  )
    .trim()
    .split("\n")
    .map((line) => nativeResponse.parse(JSON.parse(line)));
}
const mutations = [
  {
    id: "cells-accept-nan-as-equal",
    scope: "production",
    file: "crates/tea/src/storage/cell.rs",
    needle: "(Self::Number(left), Self::Number(right)) => left == right,",
    replacement:
      "(Self::Number(left), Self::Number(right)) => left == right || (left.is_nan() && right.is_nan()),",
  },
  {
    id: "cells-compare-arrays-structurally",
    scope: "production",
    file: "crates/tea/src/storage/cell.rs",
    needle:
      "(Self::Array(left), Self::Array(right)) => Arc::ptr_eq(&left.0, &right.0),",
    replacement:
      "(Self::Array(left), Self::Array(right)) => crate::structural_hash(&PlainData::Array(left.snapshot())) == crate::structural_hash(&PlainData::Array(right.snapshot())),",
  },
  {
    id: "conflict-copies-retained-fields",
    scope: "production",
    file: "crates/tea/src/storage.rs",
    needle:
      "            expected_version,\n            actual_version,\n            message:",
    replacement:
      "            expected_version: StoredCell::from(expected_version.snapshot()),\n            actual_version: StoredCell::from(actual_version.snapshot()),\n            message:",
  },
  {
    id: "lease-resets-version-before-save",
    scope: "production",
    file: "crates/tea/src/runtime/persistence.rs",
    needle: "let expected = self.version.borrow().clone();",
    replacement: "let expected = StoredCell::Number(0.0);",
  },
  {
    id: "test-get-omits-source-suspension",
    scope: "fixture-await-boundary",
    file: "crates/tea/tests/support/controlled_storage.rs",
    needle: "tokio::task::yield_now().await;",
    replacement: "std::future::ready(()).await;",
  },
];
function controls(
  cases: Case[],
  source: Awaited<ReturnType<typeof executeStoredCell>>[],
  baselineBinary: string,
) {
  const out = [];
  const baseline = digest(baselineBinary);
  for (const mutation of mutations) {
    const temporary = mkdtempSync(join(tmpdir(), "demlik-cell-control-"));
    try {
      for (const file of ["Cargo.toml", "Cargo.lock"])
        cpSync(file, join(temporary, file));
      cpSync("crates", join(temporary, "crates"), {
        recursive: true,
        filter: (path) => !path.split(sep).includes("target"),
      });
      if (existsSync(".cargo"))
        cpSync(".cargo", join(temporary, ".cargo"), { recursive: true });
      const file = join(temporary, mutation.file),
        before = readFileSync(file, "utf8"),
        sourceBeforeSha256 = digest(mutation.file);
      assert.equal(before.split(mutation.needle).length, 2, mutation.id);
      writeFileSync(
        file,
        before.replace(mutation.needle, mutation.replacement),
      );
      process.stderr.write(`Compiling stored-cell control ${mutation.id}\n`);
      build(temporary, join(temporary, "target"));
      const executable = binary(temporary, join(temporary, "target")),
        results = native(cases, executable);
      const detectedIds = cases.flatMap((c, i) => {
        try {
          assert("comparison" in results[i]);
          assert.deepEqual(results[i].comparison, source[i].comparison);
          return [];
        } catch {
          return [c.id];
        }
      });
      assert(detectedIds.length, mutation.id);
      assert.equal(digest(mutation.file), sourceBeforeSha256);
      assert.equal(digest(baselineBinary), baseline);
      out.push({
        id: mutation.id,
        scope: mutation.scope,
        isolation: "disposable-source-copy",
        sourceBeforeSha256,
        mutantSourceSha256: digest(file),
        nativeBinarySha256: digest(executable),
        activeSourceUnchanged: true,
        detectedIds,
      });
      mkdirSync("target/parity", { recursive: true });
      writeFileSync(
        "target/parity/stored-cell-controls-progress.json",
        JSON.stringify(out, null, 2),
      );
      process.stderr.write(
        `Detected ${mutation.id}: ${detectedIds.length} cases\n`,
      );
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }
  return out;
}
export async function verifyStoredCell(
  reportPath = "target/parity/stored-cell.json",
  binaryOverride?: string,
  mutationCheck = false,
) {
  assert.equal(process.version, "v22.21.1");
  assert.equal(process.versions.v8, "12.4.254.21-node.33");
  if (!binaryOverride) build();
  const executable = binaryOverride ?? binary(),
    cases = storedCellCases(),
    source: Awaited<ReturnType<typeof executeStoredCell>>[] = [];
  for (const c of cases) source.push(await executeStoredCell(c.script));
  const results = native(cases, executable);
  assert.equal(results.length, cases.length);
  const mismatches = cases.flatMap((c, i) => {
    try {
      assert("comparison" in results[i]);
      assert.deepEqual(results[i].comparison, source[i].comparison);
      return [];
    } catch (error) {
      return [{ id: c.id, error: String(error) }];
    }
  });
  const cargo = process.env.CARGO ?? "cargo",
    rustc =
      process.env.RUSTC ??
      (isAbsolute(cargo) ? join(dirname(cargo), "rustc") : "rustc");
  const report = {
    status: mismatches.length ? "failed" : "passed",
    passed: cases.length - mismatches.length,
    failures: mismatches,
    qualifications: [
      "Only acyclic PlainData payloads with shared root array/object identity are represented.",
      "Controlled LocalSet/port scripts do not establish arbitrary Ready/join/select/custom-executor scheduling.",
    ],
    adapterAwait: {
      controllerProfile:
        "The owned action-script controller and writers are local tasks on the same LocalSet. No production executor or persistence scheduling is changed.",
      sourceController: {
        file: "verification/parity/stored-cell.mts",
        line:
          readFileSync("verification/parity/stored-cell.mts", "utf8")
            .split("\n")
            .findIndex((line) =>
              line.includes("for (const a of script.actions)"),
            ) + 1,
      },
      sourceWriter: {
        file: "packages/tea/src/do/index.ts",
        line:
          readFileSync("packages/tea/src/do/index.ts", "utf8")
            .split("\n")
            .findIndex((line) => line.includes("async saveFenced(")) + 1,
      },
      nativeController: {
        file: "crates/tea/examples/stored_cell_driver.rs",
        line:
          readFileSync("crates/tea/examples/stored_cell_driver.rs", "utf8")
            .split("\n")
            .findIndex((line) =>
              line.includes("Ok(script) => tokio::task::spawn_local"),
            ) + 1,
        sha256: digest("crates/tea/examples/stored_cell_driver.rs"),
      },
      source: {
        file: "verification/parity/durable-object.mts",
        line:
          readFileSync("verification/parity/durable-object.mts", "utf8")
            .split("\n")
            .findIndex((line) =>
              line.includes("const value = await base.get(key);"),
            ) + 1,
        sha256: digest("verification/parity/durable-object.mts"),
      },
      native: {
        file: "crates/tea/tests/support/controlled_storage.rs",
        line:
          readFileSync("crates/tea/tests/support/controlled_storage.rs", "utf8")
            .split("\n")
            .findIndex((line) =>
              line.includes("tokio::task::yield_now().await;"),
            ) + 1,
        sha256: digest("crates/tea/tests/support/controlled_storage.rs"),
      },
      firstMeasuredReport: {
        path: "target/parity/stored-cell-first-audit.json",
        sha256: existsSync("target/parity/stored-cell-first-audit.json")
          ? digest("target/parity/stored-cell-first-audit.json")
          : null,
      },
    },
    comparison:
      "one stored-cell carrier through generic DO storage, raw primitive/reference fencing and conflict construction; actual two-profile runtime lease/restart traces",
    qualification:
      "acyclic PlainData payloads with shared root array/object identity; controlled LocalSet/port scripts do not establish arbitrary Ready/join/select/custom-executor scheduling or a generic cyclic JS heap",
    runtime: {
      node: process.version,
      v8: process.versions.v8,
      rustc: command(rustc, ["--version"]).trim(),
    },
    sourceSha256: {
      snapshot: digest("packages/tea/src/do/index.ts"),
      conflict: digest("packages/tea/src/runtime-types.ts"),
    },
    binary: { path: executable, sha256: digest(executable) },
    compared: cases.length,
    actions: cases.reduce(
      (n, c) => n + (c.script.target === "cells" ? c.script.actions.length : 6),
      0,
    ),
    runtimeCases: cases.filter((c) => c.script.target === "runtime").length,
    mismatches,
    controls:
      mutationCheck && !mismatches.length
        ? controls(cases, source, executable)
        : [],
    cases: cases.map((c, i) => ({
      ...c,
      input: c.script,
      equal: !mismatches.some((m) => m.id === c.id),
      observedRustCalls:
        "observedRustCalls" in results[i] ? results[i].observedRustCalls : [],
      observedRustFunctions:
        "observedRustCalls" in results[i]
          ? [...new Set(results[i].observedRustCalls)].sort()
          : [],
      source: source[i],
      native: results[i],
      functions:
        "observedRustCalls" in results[i]
          ? [...new Set(results[i].observedRustCalls)].sort()
          : [],
    })),
  };
  mkdirSync(dirname(resolve(reportPath)), { recursive: true });
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
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
  });
  const report = await verifyStoredCell(
    values.report,
    values["native-binary"],
    values["mutation-check"],
  );
  console.log(
    JSON.stringify({
      compared: report.compared,
      actions: report.actions,
      runtimeCases: report.runtimeCases,
      mismatches: report.mismatches.length,
      controls: report.controls.map((c) => ({
        id: c.id,
        detected: c.detectedIds.length,
      })),
      report: values.report ?? "target/parity/stored-cell.json",
    }),
  );
  if (report.mismatches.length) process.exitCode = 1;
}
