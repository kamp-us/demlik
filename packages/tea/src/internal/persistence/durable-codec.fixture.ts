import { isDeepStrictEqual } from "node:util";
import { expect, test } from "vitest";
import { z } from "zod";
import { defineMachine, type LoggedStore } from "../../index";
import {
  copyStorage,
  type DurableStorage,
  createStorage as defaultStorage,
  durableStore,
  onStorageWrite,
  type StorageFactory,
} from "./durable-store.fixture";

type State = { value: unknown };
type Msg =
  | { _tag: "input"; value: unknown; pending?: undefined }
  | { _tag: "set" }
  | { _tag: "inspect" };
type Cmd = { _tag: "see"; value: unknown };
type Role = "Msg" | "State" | "Cmd";
type Phase = "birth" | "step";
const positions = [
  ["Msg", "step"],
  ["State", "birth"],
  ["State", "step"],
  ["Cmd", "birth"],
  ["Cmd", "step"],
] as const;
function optionsFor(decode: (value: unknown) => unknown = (v) => v) {
  const value = z
    .unknown()
    .refine((v) => v !== "schema-refused")
    .transform(decode);
  return {
    state: z.object({ value }),
    message: z.discriminatedUnion("_tag", [
      z.object({ _tag: z.literal("input"), value }),
      z.object({ _tag: z.literal("set") }),
      z.object({ _tag: z.literal("inspect") }),
    ]),
    command: z.object({ _tag: z.literal("see"), value }),
  };
}

function programFor(
  role: Role,
  phase: Phase,
  original: unknown,
  observe: (value: unknown) => void,
  initial?: () => State,
) {
  return defineMachine({
    types: { model: {} as State, msg: {} as Msg, cmd: {} as Cmd },
    init: (): readonly [State, readonly Cmd[]] => [
      initial?.() ?? {
        value: role === "State" && phase === "birth" ? original : null,
      },
      role === "Cmd" && phase === "birth"
        ? [{ _tag: "see", value: original }]
        : [],
    ],
    update: {
      input: (s, m) => {
        observe(m.value);
        return [s, []];
      },
      set: (s) => [
        role === "State" ? { value: original } : s,
        role === "Cmd" ? [{ _tag: "see", value: original }] : [],
      ],
      inspect: (s) => {
        observe(s.value);
        return [s, []];
      },
    },
  });
}

/** The Promise-shaped doors used by both codec conformance engines. */
export type CodecDriver = (
  program: ReturnType<typeof programFor>,
  store: LoggedStore<State, Msg, Cmd>,
  see: (cmd: Cmd) => void,
) => Promise<{
  dispatch(msg: Msg): Promise<void>;
  stop(): Promise<void>;
}>;

class Example {
  value = 1;
}
type PayloadCase = {
  name: string;
  make(): unknown;
  refused?: boolean;
  decode?: (value: unknown) => unknown;
};
const pendingRow = {
  name: "own undefined key",
  make: () => ({ pending: undefined }),
};
const rows = [
  pendingRow,
  {
    name: "nested object undefined",
    make: () => ({ nested: { pending: undefined } }),
  },
  { name: "array undefined", make: () => [undefined, { nested: [undefined] }] },
  { name: "NaN", make: () => Number.NaN },
  { name: "negative zero", make: () => -0 },
  { name: "Date", make: () => new Date("2026-11-16T00:00:00.000Z") },
  { name: "Map", make: () => new Map([["one", 1]]) },
  { name: "class instance", make: () => new Example() },
  {
    name: "sparse array",
    make: () => {
      const array: unknown[] = Array(2);
      array[1] = 1;
      return array;
    },
  },
  {
    name: "getter",
    make: () => {
      let reads = 0;
      return {
        get count() {
          return ++reads;
        },
      };
    },
  },
  { name: "reordered keys", make: () => ({ second: 2, first: 1 }) },
  { name: "plain nested JSON", make: () => ({ nested: [1, { value: null }] }) },
  {
    name: "schema-normalized value",
    make: () => "hello",
    decode: (v: unknown) => (typeof v === "string" ? `decoded:${v}` : v),
  },
  { name: "unencodable bigint", make: () => 1n, refused: true },
  {
    name: "unencodable cycle",
    make: () => {
      const cycle: { self?: unknown } = {};
      cycle.self = cycle;
      return cycle;
    },
    refused: true,
  },
  { name: "schema refusal", make: () => "schema-refused", refused: true },
];

async function exercise(
  driver: CodecDriver,
  role: Role,
  phase: Phase,
  row: PayloadCase,
  initial?: () => State,
  createStorage: StorageFactory = defaultStorage,
) {
  const original = row.make();
  const seen: unknown[] = [];
  const disk = createStorage();
  let crash: DurableStorage | undefined;
  let before = copyStorage(disk);
  let writes = 0;
  let writesBefore = 0;
  onStorageWrite(disk, (bytes) => {
    writes += 1;
    const record = JSON.parse(bytes).record;
    if (role === "Msg" && record?._tag === "message") crash = copyStorage(disk);
  });
  const options = optionsFor(row.decode);
  const store = durableStore(disk, options);
  const boundary = () => {
    before = copyStorage(disk);
    writesBefore = writes;
  };
  const checked: typeof store = {
    ...store,
    appendMessage: (message) => {
      if (role === "Msg") boundary();
      return store.appendMessage(message);
    },
    commitStep: (step) => {
      if (role !== "Msg" && (step._tag === "birth") === (phase === "birth"))
        boundary();
      return store.commitStep(step);
    },
  };
  const program = programFor(
    role,
    phase,
    original,
    (v) => seen.push(v),
    initial,
  );
  let live: Awaited<ReturnType<CodecDriver>> | undefined;
  try {
    live = await driver(program, checked, (cmd) => {
      seen.push(cmd.value);
      crash = copyStorage(disk);
    });
    if (phase === "step")
      await live.dispatch(
        role === "Msg" ? { _tag: "input", value: original } : { _tag: "set" },
      );
  } catch (error) {
    if (!row.refused) throw error;
    expect(writes).toBe(writesBefore);
    expect(disk).toStrictEqual(before);
    await live?.stop();
    return;
  }
  if (row.refused) throw new Error("Codec/schema refusal was accepted");
  if (role === "State") {
    crash = copyStorage(disk);
    await live.dispatch({ _tag: "inspect" });
  }
  await live.stop();
  if (!crash) throw new Error("Missing persisted observation boundary");
  const wake = await driver(
    program,
    durableStore(copyStorage(crash), options),
    (cmd) => seen.push(cmd.value),
  );
  if (role === "State") await wake.dispatch({ _tag: "inspect" });
  await wake.stop();
  const decoded = JSON.parse(
    JSON.stringify(initial ? initial() : { value: row.make() }),
  ).value;
  const expected = row.decode ? row.decode(decoded) : decoded;
  expect(seen).toHaveLength(2);
  expect(isDeepStrictEqual(seen[0], expected)).toBe(true);
  expect(isDeepStrictEqual(seen[1], expected)).toBe(true);
  expect(isDeepStrictEqual(seen[0], seen[1])).toBe(true);
}

/** Run the same stored-byte value policy through both engine adapters. */
export function codecContract(
  engine: string,
  driver: CodecDriver,
  createStorage: StorageFactory = defaultStorage,
): void {
  const cases = rows.flatMap((row) =>
    positions.map(([role, phase]) => ({ ...row, role, phase })),
  );
  test.each(
    cases,
  )(`${engine}: $role $phase decodes $name live and on wake`, async (row) => {
    await exercise(driver, row.role, row.phase, row, undefined, createStorage);
  });
  test(`${engine}: Msg pending undefined uses the admitted value live and after wake`, async () => {
    const seen: unknown[] = [];
    const disk = createStorage();
    let crash = copyStorage(disk);
    const options = optionsFor();
    const store = durableStore(disk, options);
    const program = programFor("Msg", "step", null, () => {});
    const observing = defineMachine({
      ...program,
      update: {
        ...program.update,
        input: (s, m) => {
          seen.push(m);
          return [s, []];
        },
      },
    });
    const live = await driver(
      observing,
      {
        ...store,
        appendMessage: async (message) => {
          const result = await store.appendMessage(message);
          crash = copyStorage(disk);
          return result;
        },
      },
      () => {},
    );
    const original: Msg = { _tag: "input", value: null, pending: undefined };
    await live.dispatch(original);
    await live.stop();
    const wake = await driver(
      observing,
      durableStore(copyStorage(crash), options),
      () => {},
    );
    await wake.stop();
    const expected = JSON.parse(JSON.stringify(original));
    expect(seen).toHaveLength(2);
    expect(isDeepStrictEqual(seen[0], expected)).toBe(true);
    expect(isDeepStrictEqual(seen[1], expected)).toBe(true);
  });
  test(`${engine}: State accessor is 1 live and after wake instead of 2 live and 1 on wake`, async () => {
    await exercise(
      driver,
      "State",
      "birth",
      pendingRow,
      () => {
        let reads = 0;
        return {
          get value() {
            return ++reads <= 2 ? 1 : 2;
          },
        };
      },
      createStorage,
    );
  });
}
