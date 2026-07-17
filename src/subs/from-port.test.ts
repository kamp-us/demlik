import { describe, expect, it } from "vitest";
import {
  defineMachine,
  definePort,
  type NoCtx,
  type Port,
  type Reducer,
  type Runtime,
  run,
  type Sub,
  subId,
} from "../index";
import { fromPort } from "./from-port";

// Lifecycle contract under a real runtime (issue #286) — the cross-runtime
// case: a publisher runtime emits to a typed Port, a consumer machine's Sub
// attaches to it via `fromPort` when the Sub enters `subscriptions(state)`,
// emitted values fold into the consumer's State (null-dropped per msgFn),
// and reconciling the Sub out unsubscribes from the Port.

type PubState = { readonly count: number };
type PubMsg = { readonly type: "noop" };
const pubUpdate: Reducer<PubState, PubMsg, never> = {
  noop: (s) => [s, []],
};
function publisherMachine() {
  return defineMachine<PubState, PubMsg, never, never, NoCtx>({
    init: () => [{ count: 0 }, []],
    update: pubUpdate,
  });
}

type Ctx = { readonly pub: Runtime<PubState, PubMsg> };
type LevelSub = Sub<"level">;
type State = { readonly armed: boolean; readonly levels: readonly number[] };
type Msg =
  | { readonly type: "level"; readonly value: number }
  | { readonly type: "disarm" };

const update: Reducer<State, Msg, never> = {
  level: (s, m) => [{ ...s, levels: [...s.levels, m.value] }, []],
  disarm: (s) => [{ ...s, armed: false }, []],
};

function consumerMachine(port: Port<number>) {
  return defineMachine<State, Msg, never, LevelSub, Ctx>({
    init: () => [{ armed: true, levels: [] }, []],
    update,
    subscriptions: (s) =>
      s.armed ? [{ id: subId("level"), type: "level" }] : [],
    subscribe: {
      level: fromPort<LevelSub, Msg, Ctx, number, PubState, PubMsg>(
        (ctx) => ctx.pub,
        port,
        (value) => (value < 0 ? null : { type: "level", value }),
      ),
    },
  });
}

describe("fromPort — subscribe → deliver → cleanup across two real runtimes", () => {
  it("attaches to the publisher's Port at boot and folds emitted values into State", async () => {
    const port = definePort<number>("subs-test:level:deliver");
    const pub = await run(publisherMachine(), {}).ready;
    const consumer = await run(consumerMachine(port), { ctx: { pub } }).ready;

    pub.emitPort(port, 7);
    pub.emitPort(port, 42);
    await consumer.idle();
    expect(consumer.getState().levels).toEqual([7, 42]);

    await consumer.stop();
    await pub.stop();
  });

  it("msgFn → null drops the emission but keeps the Port subscription live", async () => {
    const port = definePort<number>("subs-test:level:null-drop");
    const pub = await run(publisherMachine(), {}).ready;
    const consumer = await run(consumerMachine(port), { ctx: { pub } }).ready;

    pub.emitPort(port, -1);
    await consumer.idle();
    expect(consumer.getState().levels).toEqual([]);

    pub.emitPort(port, 3);
    await consumer.idle();
    expect(consumer.getState().levels).toEqual([3]);

    await consumer.stop();
    await pub.stop();
  });

  it("reconciling the Sub out unsubscribes — later emissions never reach the consumer", async () => {
    const port = definePort<number>("subs-test:level:cleanup");
    const pub = await run(publisherMachine(), {}).ready;
    const consumer = await run(consumerMachine(port), { ctx: { pub } }).ready;

    pub.emitPort(port, 1);
    await consumer.idle();
    expect(consumer.getState().levels).toEqual([1]);

    await consumer.dispatch({ type: "disarm" });
    pub.emitPort(port, 99);
    await consumer.idle();
    expect(consumer.getState().levels).toEqual([1]); // cleanup unsubscribed

    await consumer.stop();
    await pub.stop();
  });
});
