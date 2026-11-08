import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { replay } from "../index";
import { memoryStore } from "../mem";
import { desk } from "./fixtures/schema-machine";
import { Machine, run } from "./index";

const tickets = [
  { id: "t1", title: "Login fails" },
  { id: "t2", title: "Typo" },
  { id: "t3", title: "Export stalls" },
];

describe("Machine.make", () => {
  it("runs a schema-declared ticket desk repeatedly with three commands", async () => {
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
          yield* runtime.dispatch({ type: "UserRequestedTickets" });
          yield* runtime.idle();
          yield* runtime.dispatch({ type: "UserSelectedTicket", id: "t1" });
          yield* runtime.idle();
          yield* runtime.dispatch({ type: "UserRequestedClose", id: "t1" });
          yield* runtime.idle();
          yield* runtime.dispatch({
            type: "UserSelectedTicket",
            id: "missing",
          });
          yield* runtime.idle();
          yield* runtime.dispatch({ type: "UserRequestedClose", id: "t2" });
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
        Schema.Struct({ type: Schema.Literal("idle"), count: Schema.Number }),
        Schema.Struct({ type: Schema.Literal("active"), count: Schema.Number }),
      ]),
      msg: Schema.Struct({ type: Schema.Literal("UserIncremented") }),
      cmds: [],
      types: { ctx: {} as { readonly increment: number } },
      init: (loaded, ctx) => [
        { type: "idle", count: (loaded?.count ?? 0) + ctx.increment },
        [],
      ],
      update: {
        idle: {
          UserIncremented: (state) => [
            { type: "active", count: state.count + 1 },
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
    const loaded = { type: "active" as const, count: 5 };
    const msgs = [
      { type: "UserIncremented" as const },
      { type: "UserIncremented" as const },
    ];
    const ctx = { increment: 2 };

    expect(replay(machine, { loaded, msgs, ctx })).toEqual({
      state: { type: "active", count: 9 },
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
    expect(actual).toEqual({ type: "active", count: 9 });

    const schemaTypesOnly = Machine.make({
      model: Schema.FiniteFromString,
      msg: Schema.Struct({ type: Schema.Literal("UserIncremented") }),
      cmds: [],
      init: () => [1, []],
      update: { UserIncremented: (state) => [state + 1, []] },
    });
    const count = await Effect.runPromise(
      Effect.gen(function* () {
        const handle = yield* run(schemaTypesOnly, {});
        const runtime = yield* handle.ready;
        yield* runtime.dispatch({ type: "UserIncremented" });
        return runtime.getState();
      }).pipe(Effect.scoped),
    );
    expect(count).toBe(2);
  });
});
