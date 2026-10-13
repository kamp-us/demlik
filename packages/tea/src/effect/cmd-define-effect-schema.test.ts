/**
 * `Cmd.define` from `@demlik/tea/effect` takes plain Effect schemas (#631).
 *
 * The claims under test: a machine whose three Cmds are defined that way runs
 * on the Effect engine and settles the same Msgs every time; each def is the
 * same `CmdDef` its hand-wrapped twin is, so `defineMachine`, `run` and `drive`
 * take either with no cast; a schema whose two sides differ does not compile,
 * on `input` or on `ok`; and a schema that needs a Promise is refused when the
 * Cmd settles, with the message the hand-wrapped Cmd gets.
 *
 * The type half is compiled by `pnpm typecheck:test`.
 */

import { Cause, Context, Effect, Exit, Schema, SchemaGetter } from "effect";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  AsyncSchemaError,
  Cmd as CoreCmd,
  defineMachine,
  type Settled,
} from "../index";
import { drive } from "../testing/effect";
import { Cmd, run } from ".";

// --- three Cmds, each written twice ------------------------------------------

const Ticket = Schema.Struct({ title: Schema.String, open: Schema.Boolean });
const Urgency = Schema.Literals(["low", "mid", "high"]);
const Thread = Schema.Struct({
  author: Schema.Struct({ id: Schema.String, name: Schema.String }),
  replies: Schema.Array(Schema.Struct({ body: Schema.String })),
});
const ById = Schema.Struct({ id: Schema.String });
const Page = Schema.Struct({ id: Schema.String, limit: Schema.Finite });

/** A struct input and a struct `ok`. */
const readTicket = Cmd.define("ticket_read", {
  input: ById,
  ok: Ticket,
  err: ["unknown"],
});

/** An `ok` that is a union of three literals. */
const rateTicket = Cmd.define("ticket_rate", {
  input: ById,
  ok: Urgency,
  err: ["closed"],
});

/** An `ok` that is a struct holding a nested struct and an array. */
const readThread = Cmd.define("ticket_thread", {
  input: Page,
  ok: Thread,
  err: ["locked", "unknown"],
});

const readTicketByHand = CoreCmd.define("ticket_read", {
  input: Schema.toStandardSchemaV1(ById),
  ok: Schema.toStandardSchemaV1(Ticket),
  err: ["unknown"],
});

const rateTicketByHand = CoreCmd.define("ticket_rate", {
  input: Schema.toStandardSchemaV1(ById),
  ok: Schema.toStandardSchemaV1(Urgency),
  err: ["closed"],
});

const readThreadByHand = CoreCmd.define("ticket_thread", {
  input: Schema.toStandardSchemaV1(Page),
  ok: Schema.toStandardSchemaV1(Thread),
  err: ["locked", "unknown"],
});

// --- the machine --------------------------------------------------------------

interface DeskState {
  /** Every settled Msg, in the order it was folded. */
  readonly log: readonly string[];
}

type DeskMsg = { readonly type: "open"; readonly id: string };

type DeskCmds = readonly [
  typeof readTicket,
  typeof rateTicket,
  typeof readThread,
];

/**
 * One machine body for both spellings. The parameter is typed by the helper's
 * defs, so the hand-wrapped tuple passes only if its defs are the same types.
 */
const deskOf = ([read, rate, thread]: DeskCmds) =>
  defineMachine({
    types: { model: {} as DeskState, msg: {} as DeskMsg },
    cmds: [read, rate, thread],
    init: () => [{ log: [] }, []],
    update: {
      open: (s, m) => [
        s,
        [
          read({ id: m.id }),
          rate({ id: m.id }),
          thread({ id: m.id, limit: 2 }),
        ],
      ],
      ticket_read_ok: (s, m) => [
        note(s, `${m.cmd.id} read: ${m.value.title}, open=${m.value.open}`),
        [],
      ],
      ticket_read_err: (s, m) => [
        note(s, `${m.cmd.id} read failed: ${m.error._tag}`),
        [],
      ],
      ticket_rate_ok: (s, m) => [note(s, `${m.cmd.id} rated: ${m.value}`), []],
      ticket_rate_err: (s, m) => [
        note(s, `${m.cmd.id} rate failed: ${m.error._tag}`),
        [],
      ],
      ticket_thread_ok: (s, m) => [
        note(
          s,
          `${m.cmd.id} thread: ${m.value.author.name}, ` +
            `${m.value.replies.map((reply) => reply.body).join("|")}`,
        ),
        [],
      ],
      ticket_thread_err: (s, m) => [
        note(s, `${m.cmd.id} thread failed: ${m.error._tag}`),
        [],
      ],
    },
  });

const note = (s: DeskState, line: string): DeskState => ({
  log: [...s.log, line],
});

const desk = deskOf([readTicket, rateTicket, readThread]);
const deskByHand = deskOf([
  readTicketByHand,
  rateTicketByHand,
  readThreadByHand,
]);

// --- Effect handlers over a service -------------------------------------------

/** What the desk knows about a ticket. `unknown` is what a broken backend sends. */
interface TicketRow {
  readonly ticket: unknown;
  readonly urgency: unknown;
  readonly thread: unknown;
  readonly locked?: boolean;
}

class Backend extends Context.Service<
  Backend,
  { readonly row: (id: string) => Effect.Effect<TicketRow | undefined> }
>()("Backend") {}

const rows: Readonly<Record<string, TicketRow>> = {
  t1: {
    ticket: { title: "Login fails", open: true },
    urgency: "high",
    thread: {
      author: { id: "u1", name: "Ada" },
      replies: [{ body: "seen" }, { body: "fixed" }],
    },
  },
  t2: {
    ticket: { title: "Typo", open: false },
    urgency: "low",
    thread: { author: { id: "u2", name: "Grace" }, replies: [] },
    locked: true,
  },
  // Every answer here is one its `ok` schema rejects.
  t3: {
    ticket: { title: 42, open: true },
    urgency: "urgent",
    thread: { author: { id: "u3" }, replies: [{ body: 7 }] },
  },
};

const interpret = {
  ticket_read: (cmd: { readonly id: string }) =>
    Effect.gen(function* () {
      const row = yield* (yield* Backend).row(cmd.id);
      if (row === undefined) {
        return yield* Effect.fail({ _tag: "unknown" as const });
      }
      return row.ticket as typeof Ticket.Type;
    }),
  ticket_rate: (cmd: { readonly id: string }) =>
    Effect.gen(function* () {
      const row = yield* (yield* Backend).row(cmd.id);
      if (row === undefined) {
        return yield* Effect.fail({ _tag: "closed" as const });
      }
      return row.urgency as typeof Urgency.Type;
    }),
  ticket_thread: (cmd: { readonly id: string }) =>
    Effect.gen(function* () {
      const row = yield* (yield* Backend).row(cmd.id);
      if (row === undefined) {
        return yield* Effect.fail({ _tag: "unknown" as const });
      }
      if (row.locked === true) {
        return yield* Effect.fail({ _tag: "locked" as const });
      }
      return row.thread as typeof Thread.Type;
    }),
};

const backend = Effect.provideService(Backend, {
  row: (id) => Effect.succeed(rows[id]),
});

/** Open four tickets on the Effect engine and read the log they leave. */
const openAll = (machine: typeof desk) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const handle = yield* run(machine, { interpret });
      const runtime = yield* handle.ready;
      for (const id of ["t1", "t2", "t3", "t4"]) {
        yield* runtime.dispatch({ type: "open", id });
      }
      yield* runtime.idle();
      return runtime.getState().log;
    }).pipe(Effect.scoped, backend),
  );

const expectedLog = [
  "t1 read: Login fails, open=true",
  "t1 rated: high",
  "t1 thread: Ada, seen|fixed",
  "t2 read: Typo, open=false",
  "t2 rated: low",
  "t2 thread failed: locked",
  "t3 read failed: malformed_result",
  "t3 rate failed: malformed_result",
  "t3 thread failed: malformed_result",
  "t4 read failed: unknown",
  "t4 rate failed: closed",
  "t4 thread failed: unknown",
];

describe("a machine whose Cmds are defined from plain Effect schemas (runtime)", () => {
  it("settles every Cmd on the Effect engine, a rejected value as `malformed_result`", async () => {
    expect(await openAll(desk)).toEqual(expectedLog);
  });

  it("settles the same Msgs on a second run", async () => {
    const first = await openAll(desk);
    const second = await openAll(desk);
    expect(second).toEqual(first);
    expect(second).toEqual(expectedLog);
  });

  it("settles the same Msgs as the hand-wrapped twin", async () => {
    expect(await openAll(deskByHand)).toEqual(await openAll(desk));
  });

  it("names the rejected field in `malformed_result`, as the hand-wrapped twin does", () => {
    const settle = (machine: typeof desk) =>
      Effect.runPromise(
        drive(machine, { log: [] }, { type: "open", id: "t3" }, interpret, {
          clock: () => 0,
        }).pipe(backend),
      ).then((result) =>
        result.trace.flatMap((entry) =>
          entry.kind === "msg" && entry.msg.type === "ticket_thread_err"
            ? [entry.msg.error]
            : [],
        ),
      );
    return Promise.all([settle(desk), settle(deskByHand)]).then(
      ([mine, byHand]) => {
        expect(mine).toHaveLength(1);
        expect(mine[0]).toMatchObject({ _tag: "malformed_result" });
        expect(mine).toEqual(byHand);
      },
    );
  });

  it("carries the core's other helpers", () => {
    expect(Cmd.none).toBe(CoreCmd.none);
    expect(Cmd.batch).toBe(CoreCmd.batch);
    expect(Cmd.when).toBe(CoreCmd.when);
    expect(Cmd.whenDefined).toBe(CoreCmd.whenDefined);
  });
});

describe("the def is the hand-wrapped twin's def (types)", () => {
  it("is the same `CmdDef`, Cmd by Cmd", () => {
    expectTypeOf(readTicket).toEqualTypeOf(readTicketByHand);
    expectTypeOf(rateTicket).toEqualTypeOf(rateTicketByHand);
    expectTypeOf(readThread).toEqualTypeOf(readThreadByHand);
  });

  it("has the same `okType` and `errType`", () => {
    expectTypeOf(readThread.okType).toEqualTypeOf<"ticket_thread_ok">();
    expectTypeOf(readThread.errType).toEqualTypeOf<"ticket_thread_err">();
    expect(readThread.okType).toBe(readThreadByHand.okType);
    expect(readThread.errType).toBe(readThreadByHand.errType);
    expect(readThread.errTags).toEqual(readThreadByHand.errTags);
  });

  it("settles with the same `_ok` and `_err` Msgs", () => {
    expectTypeOf<Settled<typeof readTicket>>().toEqualTypeOf<
      Settled<typeof readTicketByHand>
    >();
    expectTypeOf<Settled<typeof rateTicket>>().toEqualTypeOf<
      Settled<typeof rateTicketByHand>
    >();
    expectTypeOf<Settled<typeof readThread>>().toEqualTypeOf<
      Settled<typeof readThreadByHand>
    >();
  });

  it("types the input and `ok` by the schema", () => {
    expectTypeOf(readThread)
      .parameter(0)
      .toEqualTypeOf<{ readonly id: string; readonly limit: number }>();
    type RateOk = Extract<
      Settled<typeof rateTicket>,
      { type: "ticket_rate_ok" }
    >;
    expectTypeOf<RateOk["value"]>().toEqualTypeOf<"low" | "mid" | "high">();
  });

  it("builds one machine type from either spelling", () => {
    expectTypeOf(deskByHand).toEqualTypeOf(desk);
  });
});

describe("a schema whose two sides differ does not compile", () => {
  const Id = Schema.String.pipe(Schema.brand("TicketId"));
  const Count = Schema.Struct({ count: Schema.FiniteFromString });

  it("refuses a transformation on `ok`", () => {
    Cmd.define("count", {
      input: ById,
      // @ts-expect-error a string comes in and a number goes on
      ok: Schema.FiniteFromString,
      err: [],
    });
  });

  it("refuses a transformation inside a struct `ok`", () => {
    Cmd.define("count", {
      input: ById,
      // @ts-expect-error `count` is a string on one side and a number on the other
      ok: Count,
      err: [],
    });
  });

  it("refuses a transformation on `input`", () => {
    Cmd.define("count", {
      // @ts-expect-error `count` is a string on one side and a number on the other
      input: Count,
      ok: Ticket,
      err: [],
    });
  });

  it("refuses a brand on `ok`", () => {
    Cmd.define("mint_id", {
      input: ById,
      // @ts-expect-error a plain string comes in and a branded one goes on
      ok: Id,
      err: [],
    });
  });

  it("refuses a brand on `input`", () => {
    Cmd.define("by_branded_id", {
      // @ts-expect-error `id` is a plain string on one side and branded on the other
      input: Schema.Struct({ id: Id }),
      ok: Ticket,
      err: [],
    });
  });

  it("takes `Schema.toType` of either, which keeps the checks", async () => {
    const mintId = Cmd.define("mint_id", {
      input: Schema.toType(Schema.Struct({ id: Id })),
      ok: Schema.toType(Count),
      err: [],
    });
    expectTypeOf(mintId).parameter(0).toEqualTypeOf<{
      readonly id: typeof Id.Type;
    }>();

    const counter = defineMachine({
      types: {
        model: {} as { readonly seen: readonly string[] },
        msg: {} as { readonly type: "go"; readonly id: typeof Id.Type },
      },
      cmds: [mintId],
      init: () => [{ seen: [] }, []],
      update: {
        go: (s, m) => [s, [mintId({ id: m.id })]],
        mint_id_ok: (s, m) => [
          { seen: [...s.seen, `ok ${m.value.count}`] },
          [],
        ],
        mint_id_err: (s, m) => [{ seen: [...s.seen, m.error._tag] }, []],
      },
    });
    const settle = (count: unknown) =>
      Effect.runPromise(
        drive(
          counter,
          { seen: [] },
          { type: "go", id: Id.make("t1") },
          { mint_id: () => Effect.succeed({ count: count as number }) },
        ),
      ).then((result) => result.state.seen);

    // The handler answers the number its type asks for, and it is accepted.
    expect(await settle(3)).toEqual(["ok 3"]);
    // The decoded side's own check still runs: `Finite` refuses a string.
    expect(await settle("3")).toEqual(["malformed_result"]);
  });

  it("the hand wrapper compiles the same transformation and fails every settle", async () => {
    const count = CoreCmd.define("count", {
      input: Schema.toStandardSchemaV1(ById),
      ok: Schema.toStandardSchemaV1(Schema.FiniteFromString),
      err: [],
    });
    const counter = defineMachine({
      types: {
        model: {} as { readonly seen: readonly string[] },
        msg: {} as { readonly type: "go" },
      },
      cmds: [count],
      init: () => [{ seen: [] }, []],
      update: {
        go: (s) => [s, [count({ id: "t1" })]],
        count_ok: (s, m) => [{ seen: [...s.seen, `ok ${m.value}`] }, []],
        count_err: (s, m) => [{ seen: [...s.seen, m.error._tag] }, []],
      },
    });
    const result = await Effect.runPromise(
      drive(
        counter,
        { seen: [] },
        { type: "go" },
        { count: () => Effect.succeed(3) },
      ),
    );
    expect(result.state.seen).toEqual(["malformed_result"]);
  });
});

describe("a schema that needs a service does not compile", () => {
  it("refuses it on `ok`", () => {
    const NeedsBackend = Schema.String.pipe(
      Schema.decode({
        decode: SchemaGetter.checkEffect(() =>
          Effect.map(Effect.service(Backend), () => true),
        ),
        encode: SchemaGetter.passthrough(),
      }),
    );
    Cmd.define("needs_backend", {
      input: ById,
      // @ts-expect-error decoding needs `Backend`, and nothing here provides it
      ok: NeedsBackend,
      err: [],
    });
  });
});

describe("a schema whose validation needs a Promise is refused when the Cmd settles", () => {
  const Slow = Schema.Struct({ title: Schema.String }).pipe(
    Schema.decode({
      decode: SchemaGetter.checkEffect(() =>
        Effect.promise(() => Promise.resolve(true)),
      ),
      encode: SchemaGetter.passthrough(),
    }),
  );

  const slow = Cmd.define("slow_read", { input: ById, ok: Slow, err: [] });
  const slowByHand = CoreCmd.define("slow_read", {
    input: Schema.toStandardSchemaV1(ById),
    ok: Schema.toStandardSchemaV1(Slow),
    err: [],
  });

  const defect = async (def: typeof slow) => {
    const machine = defineMachine({
      types: {
        model: {} as { readonly title: string | null },
        msg: {} as { readonly type: "go" },
      },
      cmds: [def],
      init: () => [{ title: null }, []],
      update: {
        go: (s) => [s, [def({ id: "t1" })]],
        slow_read_ok: (_s, m) => [{ title: m.value.title }, []],
        slow_read_err: (s) => [s, []],
      },
    });
    const exit = await Effect.runPromiseExit(
      drive(
        machine,
        { title: null },
        { type: "go" },
        { slow_read: () => Effect.succeed({ title: "Login fails" }) },
      ),
    );
    if (Exit.isSuccess(exit)) throw new Error("the drive settled");
    return Cause.squash(exit.cause);
  };

  it("ends the drive with tea's `AsyncSchemaError`", async () => {
    const error = await defect(slow);
    expect(error).toBeInstanceOf(AsyncSchemaError);
    expect((error as AsyncSchemaError).message).toBe(
      '@demlik/tea: the "slow_read" Cmd\'s ok schema validated ' +
        "asynchronously. tea checks schemas synchronously, so a schema whose " +
        "`~standard.validate` returns a Promise cannot be used here.",
    );
  });

  it("with the message the hand-wrapped Cmd gets", async () => {
    const mine = await defect(slow);
    const byHand = await defect(slowByHand);
    expect(byHand).toBeInstanceOf(AsyncSchemaError);
    expect((mine as Error).message).toBe((byHand as Error).message);
  });
});
