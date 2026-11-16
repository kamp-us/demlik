import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { replay } from "../index";
import { memoryStore } from "../mem";
import {
  CounterModel,
  CounterMsg,
  counter,
  NotebookModel,
  NotebookMsg,
  notebook,
  PreferencesModel,
  PreferencesMsg,
  preferences,
} from "./fixtures/schema-host";
import { DeskModel, DeskMsg, desk } from "./fixtures/schema-machine";
import { Machine, run } from "./index";

const tickets = [
  { id: "t1", title: "Login fails" },
  { id: "t2", title: "Typo" },
  { id: "t3", title: "Export stalls" },
];

function restoreAndDispatch<S, M extends { _tag: string }>(
  machine: ReturnType<typeof Machine.make<S, M, never>>,
  saved: unknown,
  messages: readonly unknown[],
) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const model = Schema.decodeUnknownSync(Schema.toType(machine.model))(
        saved,
      );
      const decodeMsg = Schema.decodeUnknownSync(Schema.toType(machine.msg));
      const handle = yield* run(machine, { store: memoryStore(model) });
      const runtime = yield* handle.ready;
      for (const raw of messages) yield* runtime.dispatch(decodeMsg(raw));
      return runtime.getState();
    }).pipe(Effect.scoped),
  );
}

describe("Machine.make", () => {
  it.each([
    {
      name: "counter",
      machine: counter,
      model: CounterModel,
      msg: CounterMsg,
      invalidModel: { count: "two" },
      invalidMsg: { _tag: "UserIncremented", amount: "one" },
      execute: () =>
        restoreAndDispatch(counter, { count: 2 }, [
          { _tag: "UserIncremented", amount: 1 },
          { _tag: "UserIncremented", amount: 3 },
        ]),
      expected: { count: 6 },
    },
    {
      name: "preferences",
      machine: preferences,
      model: PreferencesModel,
      msg: PreferencesMsg,
      invalidModel: { selected: 42 },
      invalidMsg: { _tag: "UserSelectedTheme", theme: false },
      execute: () =>
        restoreAndDispatch(preferences, { selected: null }, [
          { _tag: "UserSelectedTheme", theme: "light" },
          { _tag: "UserSelectedTheme", theme: "dark" },
        ]),
      expected: { selected: "dark" },
    },
    {
      name: "notebook",
      machine: notebook,
      model: NotebookModel,
      msg: NotebookMsg,
      invalidModel: { notes: [42] },
      invalidMsg: { _tag: "UserAddedNote", text: null },
      execute: () =>
        restoreAndDispatch(notebook, { notes: ["first"] }, [
          { _tag: "UserAddedNote", text: "second" },
          { _tag: "UserAddedNote", text: "third" },
        ]),
      expected: { notes: ["first", "second", "third"] },
    },
  ])("hosts $name through its returned schemas", async (scenario) => {
    expect(scenario.machine.model).toBe(scenario.model);
    expect(scenario.machine.msg).toBe(scenario.msg);
    const decodeModel = Schema.decodeUnknownSync(
      Schema.toType(scenario.machine.model),
    );
    const decodeMsg = Schema.decodeUnknownSync(
      Schema.toType(scenario.machine.msg),
    );
    expect(() => decodeModel(scenario.invalidModel)).toThrow();
    expect(() => decodeMsg(scenario.invalidMsg)).toThrow();
    for (let attempt = 0; attempt < 3; attempt++) {
      expect(await scenario.execute()).toEqual(scenario.expected);
    }
  });

  it("runs a schema-declared ticket desk repeatedly with three commands", async () => {
    expect(desk.model).toBe(DeskModel);
    expect(desk.msg).toBe(DeskMsg);
    expect(() =>
      Schema.decodeUnknownSync(Schema.toType(desk.msg))({
        _tag: "LoadTickets_ok",
        value: tickets,
      }),
    ).toThrow();
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const handle = yield* run(desk, {
            interpret: {
              LoadTickets: () => Effect.succeed(tickets),
              ReadTicket: (cmd) => {
                const ticket = tickets.find((row) => row.id === cmd.id);
                return ticket === undefined
                  ? Effect.fail({ _tag: "unknown" as const })
                  : Effect.succeed(ticket);
              },
              CloseTicket: (cmd) =>
                cmd.id === "t2"
                  ? Effect.fail({ _tag: "locked" as const })
                  : Effect.succeed({ id: cmd.id }),
            },
          });
          const runtime = yield* handle.ready;
          yield* runtime.dispatch({ _tag: "UserRequestedTickets" });
          yield* runtime.idle();
          yield* runtime.dispatch({ _tag: "UserSelectedTicket", id: "t1" });
          yield* runtime.idle();
          yield* runtime.dispatch({ _tag: "UserRequestedClose", id: "t1" });
          yield* runtime.idle();
          yield* runtime.dispatch({
            _tag: "UserSelectedTicket",
            id: "missing",
          });
          yield* runtime.idle();
          yield* runtime.dispatch({ _tag: "UserRequestedClose", id: "t2" });
          yield* runtime.idle();
          return runtime.getState();
        }).pipe(Effect.scoped),
      );

      expect(result).toEqual({
        tickets: [tickets[1], tickets[2]],
        selected: null,
        log: [
          "loaded 3",
          "read t1: Login fails",
          "closed t1",
          "read missing: unknown",
          "close t2: locked",
        ],
      });
    }
  });

  it("keeps restored init and transitions usable by run and replay without decoding", async () => {
    const machine = Machine.make({
      model: Schema.Union([
        Schema.Struct({ _tag: Schema.Literal("idle"), count: Schema.Number }),
        Schema.Struct({ _tag: Schema.Literal("active"), count: Schema.Number }),
      ]),
      msg: Schema.Struct({ _tag: Schema.Literal("UserIncremented") }),
      cmds: [],
      types: { ctx: {} as { readonly increment: number } },
      init: (loaded, ctx) => [
        { _tag: "idle", count: (loaded?.count ?? 0) + ctx.increment },
        [],
      ],
      update: {
        idle: {
          UserIncremented: (state) => [
            { _tag: "active", count: state.count + 1 },
            [],
          ],
        },
        active: {
          UserIncremented: (state) => [
            { ...state, count: state.count + 1 },
            [],
          ],
        },
      },
    });
    const loaded = { _tag: "active" as const, count: 5 };
    const msgs = [
      { _tag: "UserIncremented" as const },
      { _tag: "UserIncremented" as const },
    ];
    const ctx = { increment: 2 };

    expect(replay(machine, { loaded, msgs, ctx })).toEqual({
      state: { _tag: "active", count: 9 },
      cmds: [],
      subs: [],
    });

    const actual = await Effect.runPromise(
      Effect.gen(function* () {
        const handle = yield* run(machine, { ctx, store: memoryStore(loaded) });
        const runtime = yield* handle.ready;
        for (const msg of msgs) yield* runtime.dispatch(msg);
        return runtime.getState();
      }).pipe(Effect.scoped),
    );
    expect(actual).toEqual({ _tag: "active", count: 9 });

    const decodeCalls = { model: 0, msg: 0 };
    const schemaTypesOnly = Machine.make({
      model: Schema.FiniteFromString.check(
        Schema.makeFilter(() => {
          decodeCalls.model++;
          return true;
        }),
      ),
      msg: Schema.Struct({ _tag: Schema.Literal("UserIncremented") }).check(
        Schema.makeFilter(() => {
          decodeCalls.msg++;
          return true;
        }),
      ),
      cmds: [],
      init: () => [1, []],
      update: { UserIncremented: (state) => [state + 1, []] },
    });
    expect(decodeCalls).toEqual({ model: 0, msg: 0 });
    const count = await Effect.runPromise(
      Effect.gen(function* () {
        const handle = yield* run(schemaTypesOnly, {});
        const runtime = yield* handle.ready;
        expect(decodeCalls).toEqual({ model: 0, msg: 0 });
        yield* runtime.dispatch({ _tag: "UserIncremented" });
        return runtime.getState();
      }).pipe(Effect.scoped),
    );
    expect(count).toBe(2);
    expect(decodeCalls).toEqual({ model: 0, msg: 0 });
    Schema.decodeUnknownSync(Schema.toType(schemaTypesOnly.model))(2);
    Schema.decodeUnknownSync(Schema.toType(schemaTypesOnly.msg))({
      _tag: "UserIncremented",
    });
    expect(decodeCalls).toEqual({ model: 1, msg: 1 });
  });
});
