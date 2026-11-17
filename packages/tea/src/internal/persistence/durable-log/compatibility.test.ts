import { readFileSync } from "node:fs";
import ts from "typescript";
import { expect, test } from "vitest";
import { z } from "zod";
import { StoreConflictError } from "../../../index";
import { memoryEventSourcedStore } from "../../../mem";
import { schemaMigrate } from "../../../runtime-types";
import * as effects from "./durable-effects";

const state = z.object({ n: z.number() });
const message = z.object({ _tag: z.literal("go"), n: z.number() });
const command = z.object({ _tag: z.literal("work"), n: z.number() });
const work = { state, cmds: z.array(command), timers: z.array(z.never()) };
const fixture = z
  .object({
    head: z.string().regex(/^[0-9a-f]{40}$/),
    operations: z.array(
      z.discriminatedUnion("op", [
        z.object({
          op: z.literal("commit"),
          step: z.discriminatedUnion("_tag", [
            z.object({ _tag: z.literal("birth"), at: z.number(), ...work }),
            z.object({
              _tag: z.literal("applied"),
              sourceId: z.string(),
              ...work,
            }),
            z.object({
              _tag: z.literal("receipt"),
              sourceId: z.string(),
              disposition: z.enum(["ignored", "rejected"]),
              failure: z
                .object({
                  kind: z.enum(["reduce", "no_cell"]),
                  message: z.string(),
                })
                .optional(),
            }),
          ]),
        }),
        z.object({
          op: z.literal("append"),
          message: z.object({
            _tag: z.literal("message"),
            id: z.string(),
            at: z.number(),
            msg: message,
          }),
        }),
        z.object({ op: z.literal("confirm"), id: z.number() }),
        z.object({ op: z.literal("checkpoint") }),
      ]),
    ),
    entries: z.array(z.tuple([z.string(), z.string()])),
    read: z.unknown(),
    origin: z.object({ format: z.string(), memory: z.string() }),
  })
  .parse(
    JSON.parse(
      readFileSync(
        new URL("./bytes-origin-main.json", import.meta.url),
        "utf8",
      ),
    ),
  );

// Execute the pinned, unchanged writer, with its real shared dependencies.
function originModule<T>(
  source: string,
  imports: Readonly<Record<string, unknown>>,
): T {
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  });
  const module = { exports: {} };
  const require = (id: string): unknown => {
    if (!Object.hasOwn(imports, id))
      throw new Error(`Unresolved baseline dependency: ${id}`);
    return imports[id];
  };
  new Function("exports", "require", "module", outputText)(
    module.exports,
    require,
    module,
  );
  return module.exports as T;
}
const format = originModule<object>(fixture.origin.format, {
  "./durable-effects": effects,
});
export const originMain = originModule<{
  readonly memoryEventSourcedStore: typeof memoryEventSourcedStore;
}>(fixture.origin.memory, {
  "../index": { StoreConflictError },
  "../internal/persistence/durable-log/format": format,
  "../runtime-types": { schemaMigrate },
}).memoryEventSourcedStore;
const options = { state, message, command, snapshotEvery: 3 };

async function replay(make: typeof memoryEventSourcedStore) {
  const disk = new Map<string, string>();
  const store = make(disk, options);
  type Operation = (typeof fixture.operations)[number];
  const calls = {
    commit: (op) => store.commitStep(op.step),
    append: (op) => store.appendMessage(op.message),
    confirm: (op) => store.confirmEffect(op.id),
    checkpoint: () => store.checkpoint(),
  } satisfies {
    [K in Operation["op"]]: (
      op: Extract<Operation, { op: K }>,
    ) => Promise<unknown>;
  };
  for (const op of fixture.operations) await calls[op.op](op as never);
  return disk;
}

test("the pinned origin/main writer reproduces the golden bytes and read", async () => {
  const disk = await replay(originMain);
  expect([...disk]).toEqual(fixture.entries);
  expect(await originMain(disk, options).readLog()).toEqual(fixture.read);
});

test("old bytes are readable and new bytes match exactly and are readable by origin/main", async () => {
  expect(
    await memoryEventSourcedStore(new Map(fixture.entries), options).readLog(),
  ).toEqual(fixture.read);
  const disk = await replay(memoryEventSourcedStore);
  expect([...disk]).toEqual(fixture.entries);
  expect(await originMain(disk, options).readLog()).toEqual(fixture.read);
});

for (const [name, make] of [
  ["origin/main", originMain],
  ["pure rules", memoryEventSourcedStore],
] as const) {
  test(`${name}: an uncloneable decoded response refuses before writing`, async () => {
    const disk = new Map<string, string>();
    const store = make(disk, {
      ...options,
      state: {
        safeParse: (_raw: unknown) => ({
          success: true as const,
          data: (): number => 0,
        }),
      },
    });
    await expect(
      store.commitStep({
        _tag: "birth",
        at: 0,
        state: () => 1,
        cmds: [],
        timers: [],
      }),
    ).rejects.toMatchObject({ name: "DataCloneError" });
    expect(disk.size).toBe(0);
  });
}
