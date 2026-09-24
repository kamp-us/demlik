/**
 * Cross-engine conformance (#283): every machine in
 * `src/__fixtures__/engine-conformance.ts` runs on the Promise engine and on
 * the Effect engine, and the two Msg / State traces must be identical.
 *
 * The machine files are shared; only the handlers differ, and each pair below
 * answers the same way — one returning a Promise, one an Effect. The table is
 * keyed by the fixture's names, so a machine added there without a pair here
 * does not compile.
 */

import { Effect, type Scope, Stream } from "effect";
import { describe, expect, it } from "vitest";
import {
  burst,
  burstAnswer,
  type ConformanceCase,
  clock,
  conformanceMachines,
  counter,
  door,
  lookup,
  lookupAnswer,
  owned,
} from "../__fixtures__/engine-conformance";
import { type BootingRuntime, NoCellError } from "../index";
import { run as runPromise } from "../promise";
import { run as runEffect } from "./index";

type Name = keyof typeof conformanceMachines;

/** What both engines hand back for one case: a started run. */
type AnyRuntime = BootingRuntime<unknown, { type: string }, never>;

type EffectRun = Effect.Effect<AnyRuntime, never, Scope.Scope>;

interface EnginePair {
  readonly promise: () => AnyRuntime;
  readonly effect: EffectRun;
}

const fixed = () => 0;

const engines: { readonly [K in Name]: EnginePair } = {
  counter: {
    promise: () => runPromise(counter, { clock: fixed }) as AnyRuntime,
    effect: runEffect(counter, { clock: fixed }) as EffectRun,
  },
  lookup: {
    promise: () =>
      runPromise(lookup, {
        clock: fixed,
        interpret: {
          fetch_user: async (cmd, { ok, err }) => {
            const answer = lookupAnswer(cmd.id);
            return answer._tag === "found"
              ? ok(answer.value)
              : err({ _tag: "not_found" });
          },
          audit: async (cmd) => ({ type: "audited", note: cmd.note }),
        },
      }) as AnyRuntime,
    effect: runEffect(lookup, {
      clock: fixed,
      interpret: {
        fetch_user: (cmd) => {
          const answer = lookupAnswer(cmd.id);
          return answer._tag === "found"
            ? Effect.succeed(answer.value)
            : Effect.fail({ _tag: "not_found" as const });
        },
        audit: (cmd) =>
          Effect.succeed({ type: "audited" as const, note: cmd.note }),
      },
    }) as EffectRun,
  },
  clock: {
    promise: () =>
      runPromise(clock, {
        clock: fixed,
        terminal: conformanceMachines.clock.terminal,
        subscribe: {
          feed: (sub, _ctx, dispatch) => {
            for (let i = 0; i < sub.deps.count; i++)
              dispatch({ type: "fed", i });
            return () => {};
          },
        },
      }) as AnyRuntime,
    effect: runEffect(clock, {
      clock: fixed,
      terminal: conformanceMachines.clock.terminal,
      subscribe: {
        feed: (sub) =>
          Stream.range(0, sub.deps.count - 1).pipe(
            Stream.map((i) => ({ type: "fed" as const, i })),
          ),
      },
    }) as EffectRun,
  },
  burst: {
    promise: () =>
      runPromise(burst, {
        clock: fixed,
        interpret: {
          burst: async (cmd) => burstAnswer(cmd.count),
          hush: async () => [],
          last: async () => ({ type: "done" }),
        },
      }) as AnyRuntime,
    effect: runEffect(burst, {
      clock: fixed,
      interpret: {
        burst: (cmd) => Effect.succeed(burstAnswer(cmd.count)),
        hush: () => Effect.succeed([]),
        last: () => Effect.succeed({ type: "done" as const }),
      },
    }) as EffectRun,
  },
  door: {
    // Default supervision on both engines: the refusal must not halt the run.
    promise: () => runPromise(door, { clock: fixed }) as AnyRuntime,
    effect: runEffect(door, { clock: fixed }) as EffectRun,
  },
  owned: {
    promise: () =>
      runPromise(owned, { clock: fixed, onError: () => {} }) as AnyRuntime,
    effect: runEffect(owned, {
      clock: fixed,
      onError: () => {},
    }) as EffectRun,
  },
};

type Trace = readonly (readonly [string, unknown])[];

/** Boot, dispatch the script, wait for the terminal State if any, and record. */
async function drive(name: Name, rt: AnyRuntime): Promise<Trace> {
  const trace: (readonly [string, unknown])[] = [];
  rt.onBoot((state) => trace.push(["boot", state]));
  rt.observe((msg, state) => trace.push([JSON.stringify(msg), state]));
  const booted = await rt.ready;
  const spec = conformanceMachines[name] as {
    readonly script: readonly { type: string }[];
    readonly terminal?: (state: never) => boolean;
  };
  for (const msg of spec.script) {
    // A refusal is part of the trace, so both engines must refuse the same Msg.
    await booted.dispatch(msg).catch((err: unknown) => {
      if (!(err instanceof NoCellError)) throw err;
      trace.push(["refused", JSON.stringify(msg)]);
    });
  }
  if (spec.terminal !== undefined) await booted.done();
  return trace;
}

async function onPromise(name: Name): Promise<Trace> {
  const rt = engines[name].promise();
  try {
    return await drive(name, rt);
  } finally {
    await rt.stop();
  }
}

function onEffect(name: Name): Promise<Trace> {
  return Effect.runPromise(
    Effect.scoped(
      Effect.flatMap(engines[name].effect, (rt) =>
        Effect.promise(() => drive(name, rt)),
      ),
    ),
  );
}

describe("both engines run every shared machine to the same trace", () => {
  it.each(Object.keys(conformanceMachines) as Name[])("%s", async (name) => {
    const promise = await onPromise(name);
    const effect = await onEffect(name);
    expect(effect).toEqual(promise);
    // A trace of boot alone would match trivially; each script transitions.
    expect(promise.length).toBeGreaterThan(1);
    const spec: ConformanceCase<never, unknown> = conformanceMachines[name];
    const refused = promise.filter(([step]) => step === "refused").length;
    expect(refused).toBe(spec.refusals ?? 0);
  });

  it("the lookup trace covers ok, a declared err, a malformed ok and a follow-up", async () => {
    const trace = await onEffect("lookup");
    expect(trace.at(-1)?.[1]).toEqual({
      names: ["Ada"],
      errors: ["not_found", "malformed_result"],
      audits: ["look u1", "look u2", "look u3"],
    });
  });

  it("the door trace refuses the Msg with no cell and applies the ones after it", async () => {
    const trace = await onEffect("door");
    expect(trace).toEqual([
      ["boot", { type: "closed" }],
      ["refused", JSON.stringify({ type: "close" })],
      [JSON.stringify({ type: "open" }), { type: "open" }],
      [JSON.stringify({ type: "close" }), { type: "closed" }],
    ]);
  });

  it("a returned list folds in order as follow-ups, on each engine (#324)", async () => {
    const expected = [
      ["boot", { log: [] }],
      [JSON.stringify({ type: "fire" }), { log: [] }],
      [JSON.stringify({ type: "got", i: 0 }), { log: ["got 0"] }],
      [JSON.stringify({ type: "got", i: 1 }), { log: ["got 0", "got 1"] }],
      [
        JSON.stringify({ type: "got", i: 2 }),
        { log: ["got 0", "got 1", "got 2"] },
      ],
      [
        JSON.stringify({ type: "done" }),
        { log: ["got 0", "got 1", "got 2", "done"] },
      ],
    ];
    expect(await onPromise("burst")).toEqual(expected);
    expect(await onEffect("burst")).toEqual(expected);
  });

  it("the owned trace drops the Msg addressed to another instance", async () => {
    const trace = await onEffect("owned");
    expect(trace.at(-1)?.[1]).toEqual({ owner: "a", pokes: 2 });
  });
});
