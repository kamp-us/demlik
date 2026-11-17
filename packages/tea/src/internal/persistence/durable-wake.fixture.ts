// THE RULE (S2-brief.md, Rules C and D), as one check:
//   At every point of a run on a log store, what the program sees live equals
//   what it sees after a wake from the same storage, and both equal the model.
//
// MUST PASS: every assertion below, 200 runs per engine, under 20s per engine.
// MUST FAIL (prove each once by breaking the code, then restore):
//   F1. an ignored or rejected step writes State again      -> A1 fails
//   F2. manual checkpoint writes a decoded State back       -> A1 fails
//   F3. the engine keeps the reducer's own State object     -> A2 fails
//   F4. a listener is told about an ignored message         -> A4 fails
//   F5. a repeated id folds twice                           -> A2 fails
import { isDeepStrictEqual } from "node:util";
import fc from "fast-check";
import { expect, test } from "vitest";
import { z } from "zod";
import { defineMachine, type LoggedStore } from "../../index";
import {
  copyStorage,
  createStorage as defaultStorage,
  durableStore,
  type StorageFactory,
} from "./durable-store.fixture";

type State = { value: unknown; count: number };
type Msg = { _tag: "set"; value: unknown; to?: string } | { _tag: "boom" };
type Cmd = { _tag: "see"; n: number; value: unknown };

const program = defineMachine({
  types: { model: {} as State, msg: {} as Msg, cmd: {} as Cmd },
  // A `set` addressed to someone else is dropped by the identity filter: the
  // "ignored" step.
  identity: {
    ofState: () => "owner",
    ofMsg: (m: Msg) => ("to" in m ? m.to : undefined),
  },
  init: (): readonly [State, readonly Cmd[]] => [{ value: null, count: 0 }, []],
  update: {
    set: (s, m) => [
      { value: m.value, count: s.count + 1 },
      [{ _tag: "see", n: s.count + 1, value: m.value }],
    ],
    // The "rejected" step.
    boom: () => {
      throw new Error("boom");
    },
  },
});

/** The Promise-shaped doors both engines are driven through. */
export type WakeDriver = (
  machine: typeof program,
  store: LoggedStore<State, Msg, Cmd>,
  see: (cmd: Cmd) => void,
) => Promise<{
  dispatch(msg: Msg, opts: { id: string }): Promise<void>;
  getState(): State;
  subscribe(listener: () => void): () => void;
  stop(): Promise<void>;
}>;

// Decoders a schema may carry. The last one is not idempotent on purpose:
// decoding a stored State twice is then visible.
const decoders = {
  identity: (v: unknown) => v,
  trim: (v: unknown) => (typeof v === "string" ? v.trim() : v),
  notIdempotent: (v: unknown) =>
    typeof v === "string" ? `d:${v}` : typeof v === "number" ? v + 1 : v,
} satisfies Record<string, (v: unknown) => unknown>;
type DecoderName = keyof typeof decoders;

export function optionsFor(decoder: DecoderName, snapshotEvery: number) {
  const value = z.unknown().transform(decoders[decoder]);
  return {
    state: z.object({ value, count: z.number() }),
    message: z.discriminatedUnion("_tag", [
      z.object({
        _tag: z.literal("set"),
        value: z.unknown(),
        to: z.string().optional(),
      }),
      z.object({ _tag: z.literal("boom") }),
    ]),
    command: z.object({ _tag: z.literal("see"), n: z.number(), value }),
    snapshotEvery,
  };
}

const json = (v: unknown): unknown =>
  JSON.parse(JSON.stringify({ v })).v ?? null;

type Op =
  | { op: "set"; value: unknown } // applied
  | { op: "ignored"; value: unknown }
  | { op: "rejected" }
  | { op: "repeat" } // the previous message again, same id
  | { op: "checkpoint" }
  | { op: "wake" }; // stop, then boot again from the same storage

const special = fc.constantFrom<() => unknown>(
  () => ({ pending: undefined }),
  () => [undefined, { nested: [undefined] }],
  () => Number.NaN,
  () => -0,
  () => new Date("2026-11-16T00:00:00.000Z"),
  () => {
    const sparse: unknown[] = Array(2);
    sparse[1] = 1;
    return sparse;
  },
  () => " padded ",
  () => 41,
);
const value = fc.oneof(
  fc.jsonValue().map((v) => () => v as unknown),
  special,
);
export const op: fc.Arbitrary<
  Op | { op: "set" | "ignored"; make: () => unknown }
> = fc.oneof(
  {
    weight: 5,
    arbitrary: value.map((make) => ({ op: "set" as const, make })),
  },
  {
    weight: 2,
    arbitrary: value.map((make) => ({ op: "ignored" as const, make })),
  },
  { weight: 2, arbitrary: fc.constant({ op: "rejected" as const }) },
  { weight: 2, arbitrary: fc.constant({ op: "repeat" as const }) },
  { weight: 2, arbitrary: fc.constant({ op: "checkpoint" as const }) },
  { weight: 2, arbitrary: fc.constant({ op: "wake" as const }) },
);

export function liveEqualsWake(
  engine: string,
  driver: WakeDriver,
  createStorage: StorageFactory = defaultStorage,
  histories = 200,
): void {
  test(`${engine}: at every point, live equals a wake from the same storage, and both equal the model`, async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<DecoderName>("identity", "trim", "notIdempotent"),
        fc.constantFrom(1, 2, 100),
        fc.array(op, { minLength: 1, maxLength: 30 }),
        async (decoder, snapshotEvery, ops) => {
          const options = optionsFor(decoder, snapshotEvery);
          const decode = decoders[decoder];
          const disk = createStorage();
          // What each handler was given, by the step that owed it.
          const seenLive = new Map<number, unknown>();
          let model: State = { value: null, count: 0 };
          let last: { msg: Msg; id: string } | undefined;
          let heard = 0;
          let heardState: State | undefined;

          const boot = async () => {
            const rt = await driver(
              program,
              durableStore(disk, options),
              (cmd) => {
                const before = seenLive.get(cmd.n);
                // A redelivery after a wake carries the same value (Rule C).
                if (seenLive.has(cmd.n))
                  expect(isDeepStrictEqual(cmd.value, before)).toBe(true);
                seenLive.set(cmd.n, cmd.value);
              },
            );
            heard = 0;
            heardState = undefined;
            rt.subscribe(() => {
              heard += 1;
              heardState = rt.getState();
            });
            return rt;
          };
          let live = await boot();

          for (const [i, step] of ops.entries()) {
            const heardBefore = heard;
            const send = (msg: Msg, id: string) =>
              live.dispatch(msg, { id }).catch(() => {});
            if (step.op === "set" && "make" in step) {
              const msg: Msg = { _tag: "set", value: step.make() };
              last = { msg, id: `m${i}` };
              await send(msg, last.id);
              model = {
                value: decode(json(msg.value)),
                count: model.count + 1,
              };
            } else if (step.op === "ignored" && "make" in step) {
              const msg: Msg = {
                _tag: "set",
                value: step.make(),
                to: "someone-else",
              };
              last = { msg, id: `m${i}` };
              await send(msg, last.id);
            } else if (step.op === "rejected") {
              last = { msg: { _tag: "boom" }, id: `m${i}` };
              await send(last.msg, last.id);
            } else if (step.op === "repeat") {
              if (last) await send(last.msg, last.id);
            } else if (step.op === "checkpoint") {
              await durableStore(disk, options).checkpoint();
            } else if (step.op === "wake") {
              await live.stop();
              live = await boot();
            }

            // A2. Live State equals the model: decoded exactly once.
            expect(isDeepStrictEqual(live.getState(), model)).toBe(true);

            // A1. A wake from a copy of the storage sees the same State, and
            //     any work it is handed carries the value the live run saw.
            const shadow = await driver(
              program,
              durableStore(copyStorage(disk), options),
              (cmd) => {
                if (seenLive.has(cmd.n))
                  expect(
                    isDeepStrictEqual(cmd.value, seenLive.get(cmd.n)),
                  ).toBe(true);
              },
            );
            expect(isDeepStrictEqual(shadow.getState(), live.getState())).toBe(
              true,
            );
            await shadow.stop();

            // A3. Each handler was given the decoded stored Cmd.
            if (step.op === "set")
              expect(
                isDeepStrictEqual(seenLive.get(model.count), model.value),
              ).toBe(true);

            // A4. Only an applied step tells a listener; what it reads is the
            //     live State.
            if (step.op === "set") {
              expect(heard).toBe(heardBefore + 1);
              expect(isDeepStrictEqual(heardState, model)).toBe(true);
            } else if (step.op !== "wake" && step.op !== "rejected") {
              expect(heard).toBe(heardBefore);
            }
          }
          await live.stop();
        },
      ),
      { numRuns: histories },
    );
  });
}
