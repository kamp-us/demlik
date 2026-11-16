import { appendFileSync } from "node:fs";
import { Effect, Stream } from "effect";
import { z } from "zod";
import { defineMachine, type Sub } from "../../index";
import { fileStore } from "../../node";
import { run as runPromise } from "../../promise";
import { run as runEffect } from "../index";

const [engine, life, stateFile, writesFile] = z
  .tuple([
    z.enum(["promise", "effect"]),
    z.coerce.number().int().positive(),
    z.string().min(1),
    z.string().min(1),
  ])
  .parse(process.argv.slice(2));
const model = z.object({
  _tag: z.enum(["pending", "working"]),
  life: z.number().int().nonnegative(),
  pulses: z.number().int().nonnegative(),
});
type Model = z.infer<typeof model>;
type Msg = { readonly _tag: "pulse" };
type Command = { readonly _tag: "write"; readonly life: number };
type Fast = Sub<"fast", { readonly life: number }>;
const machine = defineMachine({
  types: {
    model: {} as Model,
    msg: {} as Msg,
    cmd: {} as Command,
    sub: {} as Fast,
    ctx: {} as { readonly life: number },
  },
  init: (loaded, ctx) => {
    if (loaded === null || loaded.life !== ctx.life - 1) {
      throw new Error("fixture did not restore its preceding life");
    }
    return [
      { _tag: "working", life: ctx.life, pulses: 0 },
      [{ _tag: "write", life: ctx.life }],
    ];
  },
  update: {
    pulse: (state) => [
      { ...state, _tag: "working", pulses: state.pulses + 1 },
      state._tag === "pending" ? [{ _tag: "write", life: state.life }] : [],
    ],
  },
  subs: [{ _tag: "fast", deps: (state) => ({ life: state.life }) }],
});
const store = fileStore(stateFile, (raw) => model.parse(raw));
const write = (cmd: Command) => appendFileSync(writesFile, `${cmd.life}\n`);
let sawPulse!: () => void;
const pulse = new Promise<void>((resolve) => {
  sawPulse = resolve;
});
const observe = (_msg: Msg, state: Model) => {
  if (state.pulses > 0) sawPulse();
};

// The IPC channel keeps this process alive until its parent kills it.
process.on("message", () => {});
if (engine === "promise") {
  const booting = runPromise(machine, {
    ctx: { life },
    store,
    interpret: { write: async (cmd) => write(cmd) },
    subscribe: {
      fast: (_sub, _ctx, dispatch) => {
        dispatch({ _tag: "pulse" });
        return () => {};
      },
    },
  });
  booting.observe(observe);
  const rt = await booting.ready;
  await pulse;
  await rt.idle();
  process.send?.({ _tag: "settled", state: rt.getState() });
} else {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const booting = yield* runEffect(machine, {
          ctx: { life },
          store,
          interpret: { write: (cmd) => Effect.sync(() => write(cmd)) },
          subscribe: { fast: () => Stream.make({ _tag: "pulse" as const }) },
        });
        booting.observe(observe);
        const rt = yield* booting.ready;
        yield* Effect.promise(() => pulse);
        yield* rt.idle();
        process.send?.({ _tag: "settled", state: rt.getState() });
        yield* Effect.never;
      }),
    ),
  );
}
