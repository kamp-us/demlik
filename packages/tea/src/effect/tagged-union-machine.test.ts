import { Cause, Effect, Exit, Schema, Scope } from "effect";
import { expect, it } from "vitest";
import { applyCell, type Settled, type Store } from "../index";
import { memoryStore } from "../mem";
import { run as runPromise } from "../promise";
import { Cmd, Machine, run as runEffect } from "./index";

const totals = {
  rings: Schema.Number,
  missed: Schema.Number,
  entries: Schema.Number,
  denied: Schema.Number,
  lastTicket: Schema.Number,
};
const DoorState = Schema.TaggedUnion({
  closed: totals,
  open: totals,
  locked: totals,
});
const DoorMsg = Schema.TaggedUnion({
  knock: { attempt: Schema.Number },
  open: {},
  enter: { ticket: Schema.Number },
  close: {},
  lock: {},
});
const ring = Cmd.make("ring", {
  input: Schema.Struct({ attempt: Schema.Number }),
  ok: Schema.Number,
  err: ["offline"],
});
const admit = Cmd.make("admit", {
  input: Schema.Struct({ ticket: Schema.Number }),
  ok: Schema.Number,
  err: ["invalid_ticket"],
});

type State = typeof DoorState.Type;
type Input = typeof DoorMsg.Type;
type Command = ReturnType<typeof ring> | ReturnType<typeof admit>;
type Msg = Input | Settled<typeof ring | typeof admit>;

const initial: State = {
  _tag: "closed",
  rings: 0,
  missed: 0,
  entries: 0,
  denied: 0,
  lastTicket: -1,
};

const door = Machine.make({
  model: DoorState,
  msg: DoorMsg,
  cmds: [ring, admit],
  init: (loaded) => [loaded ?? initial, []],
  update: {
    closed: {
      knock: (state, msg) => [state, [ring({ attempt: msg.attempt })]],
      open: (state, _msg) => [{ ...state, _tag: "open" as const }, []],
      lock: (state, _msg) => [{ ...state, _tag: "locked" as const }, []],
      ring_ok: (state, msg) => [
        { ...state, rings: state.rings + msg.value },
        [],
      ],
      ring_err: (state, _msg) => [{ ...state, missed: state.missed + 1 }, []],
    },
    open: {
      enter: (state, msg) => [state, [admit({ ticket: msg.ticket })]],
      close: (state, _msg) => [{ ...state, _tag: "closed" as const }, []],
      admit_ok: (state, msg) => [
        { ...state, entries: state.entries + 1, lastTicket: msg.value },
        [],
      ],
      admit_err: (state, _msg) => [{ ...state, denied: state.denied + 1 }, []],
    },
    locked: {
      open: (state, _msg) => [{ ...state, _tag: "open" as const }, []],
    },
  },
});

const even = (n: number) => n % 2 === 0;
const clock = () => 0;

// Each visit exercises both outcomes before moving out of the reply's State.
const sequence: readonly Input[] = Array.from(
  { length: 40 },
  (_, visit): readonly Input[] => [
    { _tag: "knock", attempt: visit * 2 },
    { _tag: "knock", attempt: visit * 2 + 1 },
    { _tag: "open" },
    { _tag: "enter", ticket: visit * 2 },
    { _tag: "enter", ticket: visit * 2 + 1 },
    { _tag: "close" },
    { _tag: "lock" },
    { _tag: "open" },
    { _tag: "close" },
  ],
).flat();

// Fold update by hand, including the replies to its emitted commands.
function fold(inputs: readonly Input[]) {
  let state = initial;
  const observed: Msg[] = [];
  const answer = {
    ring: (cmd: ReturnType<typeof ring>) =>
      even(cmd.attempt)
        ? ring.ok(cmd, 1, clock())
        : ring.err(cmd, { _tag: "offline" }, clock()),
    admit: (cmd: ReturnType<typeof admit>) =>
      even(cmd.ticket)
        ? admit.ok(cmd, cmd.ticket, clock())
        : admit.err(cmd, { _tag: "invalid_ticket" }, clock()),
  };
  for (const input of inputs) {
    const pending: Msg[] = [input];
    for (const msg of pending) {
      const [next, cmds] = applyCell<State, Msg, Command>(door, state, msg);
      state = next;
      observed.push(msg);
      for (const cmd of cmds) {
        switch (cmd._tag) {
          case "ring":
            pending.push(answer.ring(cmd));
            break;
          case "admit":
            pending.push(answer.admit(cmd));
            break;
        }
      }
    }
  }
  return { state, observed };
}

interface Driven {
  onBoot(observer: (state: State) => void): unknown;
  observe(observer: (msg: Msg) => void): unknown;
  readonly ready: Promise<{
    dispatch(msg: Input): Promise<void>;
    idle(): Promise<void>;
    getState(): State;
  }>;
  stop(): Promise<void>;
}

async function settle<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) return exit.value;
  throw Cause.squash(exit.cause);
}

const start: Record<
  "Promise" | "Effect",
  (store: Store<State>) => Promise<Driven>
> = {
  Promise: async (store) =>
    runPromise(door, {
      store,
      clock,
      interpret: {
        ring: async (cmd, { ok, err }) =>
          even(cmd.attempt) ? ok(1) : err({ _tag: "offline" }),
        admit: async (cmd, { ok, err }) =>
          even(cmd.ticket) ? ok(cmd.ticket) : err({ _tag: "invalid_ticket" }),
      },
    }),
  Effect: async (store) => {
    const scope = await Effect.runPromise(Scope.make());
    const handle = await settle(
      Scope.provide(scope)(
        runEffect(door, {
          store,
          clock,
          interpret: {
            ring: (cmd) =>
              even(cmd.attempt)
                ? Effect.succeed(1)
                : Effect.fail({ _tag: "offline" as const }),
            admit: (cmd) =>
              even(cmd.ticket)
                ? Effect.succeed(cmd.ticket)
                : Effect.fail({ _tag: "invalid_ticket" as const }),
          },
        }),
      ),
    );
    return {
      onBoot: (observer) => handle.onBoot(observer),
      observe: (observer) => handle.observe(observer),
      ready: settle(handle.ready).then((runtime) => ({
        dispatch: (msg) => settle(runtime.dispatch(msg)),
        idle: () => settle(runtime.idle()),
        getState: () => runtime.getState(),
      })),
      stop: async () => {
        try {
          await settle(handle.stop());
        } finally {
          await Effect.runPromise(Scope.close(scope, Exit.void));
        }
      },
    };
  },
};

async function drive(
  handle: Driven,
  inputs: readonly Input[],
  observed: Msg[],
  loaded: State,
) {
  const boots: State[] = [];
  handle.onBoot((state) => boots.push(state));
  handle.observe((msg) => observed.push(msg));
  try {
    const runtime = await handle.ready;
    expect(boots).toEqual([loaded]);
    for (const msg of inputs) {
      await runtime.dispatch(msg);
      await runtime.idle();
    }
    return runtime.getState();
  } finally {
    await handle.stop();
  }
}

it("runs a tagged-union door on both engines, restoring halfway with tagged command replies", async () => {
  const halfway = sequence.length / 2;
  const expected = fold(sequence);
  const checkpoint = fold(sequence.slice(0, halfway)).state;
  expect(sequence).toHaveLength(360);
  expect(expected.state).toEqual({
    _tag: "closed",
    rings: 40,
    missed: 40,
    entries: 40,
    denied: 40,
    lastTicket: 78,
  });

  const results: State[] = [];
  const traces: Msg[][] = [];
  for (const engine of ["Promise", "Effect"] as const) {
    const store = memoryStore<State>();
    const observed: Msg[] = [];
    const first = await drive(
      await start[engine](store),
      sequence.slice(0, halfway),
      observed,
      initial,
    );
    const saved = Schema.decodeUnknownSync(Schema.toType(door.model))(
      await store.load(),
    );
    expect(saved).toEqual(first);
    expect(saved).toEqual(checkpoint);
    const final = await drive(
      await start[engine](store),
      sequence.slice(halfway),
      observed,
      saved,
    );
    expect(await store.load()).toEqual(final);
    expect(final).toEqual(expected.state);
    expect(observed).toEqual(expected.observed);
    expect(observed).toHaveLength(520);
    for (const msg of observed) {
      expect(typeof msg._tag).toBe("string");
      expect(msg).not.toHaveProperty("type");
    }
    for (const _tag of ["ring_ok", "ring_err", "admit_ok", "admit_err"]) {
      expect(observed.filter((msg) => msg._tag === _tag)).toHaveLength(40);
    }
    results.push(final);
    traces.push(observed);
  }
  expect(results[0]).toEqual(results[1]);
  expect(traces[0]).toEqual(traces[1]);
});
