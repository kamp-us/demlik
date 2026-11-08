import { Effect, Schema, Stream } from "effect";
import { expectTypeOf } from "vitest";
import type { CmdOf, Machine as CoreMachine, Settled, Sub } from "../index";
import * as Core from "../index";
import * as PromiseEntry from "../promise";
import {
  type closeTicket,
  type DeskModel,
  type DeskMsg,
  desk,
  type loadTickets,
  type readTicket,
} from "./fixtures/schema-machine";
import { Cmd, Machine, run } from "./index";

type DeskCommands = typeof loadTickets | typeof readTicket | typeof closeTicket;
expectTypeOf(desk).toEqualTypeOf<
  CoreMachine<
    typeof DeskModel.Type,
    typeof DeskMsg.Type | Settled<DeskCommands>,
    CmdOf<DeskCommands>,
    Sub<never>,
    unknown
  >
>();
const Count = Schema.Struct({ count: Schema.Number });
const Incremented = Schema.Struct({ type: Schema.Literal("UserIncremented") });
const plainSpec = {
  model: Count,
  msg: Incremented,
  cmds: [] as const,
  init: (loaded: typeof Count.Type | null) =>
    [loaded ?? { count: 0 }, []] as const,
  update: {
    UserIncremented: (state: typeof Count.Type) =>
      [{ count: state.count + 1 }, []] as const,
  },
};
const plain = Machine.make(plainSpec);
expectTypeOf(plain).toEqualTypeOf<
  CoreMachine<
    typeof Count.Type,
    typeof Incremented.Type,
    never,
    Sub<never>,
    unknown
  >
>();
void run(plain, {});
const plainMessages = [{ type: "UserIncremented" }] as const;
void Core.replay(plain, { msgs: plainMessages, ctx: {} });

const { model: _model, ...withoutModel } = plainSpec;
const { msg: _msg, ...withoutMsg } = plainSpec;
const { cmds: _cmds, ...withoutCmds } = plainSpec;
// @ts-expect-error model is required even when init has a model annotation
Machine.make(withoutModel);
// @ts-expect-error msg is required even when update names the only cell
Machine.make(withoutMsg);
// @ts-expect-error cmds is required even for a machine with no commands
Machine.make(withoutCmds);

Machine.make({
  ...plainSpec,
  // @ts-expect-error model must be an Effect schema
  model: { count: 0 },
});
Machine.make({
  ...plainSpec,
  // @ts-expect-error a message schema must describe records with a type tag
  msg: Schema.String,
});
Machine.make({
  ...plainSpec,
  update: {
    // @ts-expect-error the misspelled cell cannot widen the declared messages
    UserIncremnted: (state: typeof Count.Type) => [state, []],
  },
});
Machine.make({
  ...plainSpec,
  update: {
    ...plainSpec.update,
    // @ts-expect-error an extra cell cannot add an undeclared message
    UserReset: (state: typeof Count.Type) => [state, []],
  },
});
Machine.make({
  ...plainSpec,
  // @ts-expect-error init must return the schema's model, not infer a wider one
  init: () => [{ count: "wrong" }, []],
});
Machine.make({
  ...plainSpec,
  update: {
    // @ts-expect-error a cell cannot return an invalid model
    UserIncremented: () => [{ count: "wrong" }, []],
  },
});

const undeclared = Cmd.make("Undeclared", {
  input: Schema.Struct({}),
  ok: Schema.String,
  err: [],
});
Machine.make({
  ...plainSpec,
  // @ts-expect-error commands cannot be inferred from init instead of cmds
  init: () => [{ count: 0 }, [undeclared({})]],
});
Machine.make({
  ...plainSpec,
  update: {
    // @ts-expect-error update cannot emit a command missing from cmds
    UserIncremented: (state) => [state, [undeclared({})]],
  },
});
Machine.make({
  ...plainSpec,
  // @ts-expect-error model belongs in its required schema declaration
  types: { model: {} as typeof Count.Type },
});
Machine.make({
  ...plainSpec,
  // @ts-expect-error msg belongs in its required schema declaration
  types: { msg: {} as typeof Incremented.Type },
});
Machine.make({
  ...plainSpec,
  // @ts-expect-error commands come from cmds, not types.cmd
  types: { cmd: {} as ReturnType<typeof undeclared> },
});

type Tick = Sub<"ticker", { readonly every: number }>;
const contextual = Machine.make({
  model: Count,
  msg: Incremented,
  cmds: [],
  types: {
    sub: {} as Tick,
    ctx: {} as { readonly start: number },
  },
  init: (loaded, ctx) => [loaded ?? { count: ctx.start }, []],
  update: { UserIncremented: (state) => [{ count: state.count + 1 }, []] },
  subs: [{ type: "ticker", deps: (state) => ({ every: state.count + 1 }) }],
});
const options = {
  ctx: { start: 1 },
  subscribe: {
    ticker: (sub: Tick) =>
      Stream.fromEffect(
        Effect.succeed({ type: "UserIncremented" as const }).pipe(
          Effect.delay(sub.deps.every),
        ),
      ),
  },
};
void run(contextual, options);
const { ctx: _ctx, ...withoutCtx } = options;
const { subscribe: _subscribe, ...withoutSubscribe } = options;
// @ts-expect-error types.ctx makes ctx required at run
void run(contextual, withoutCtx);
// @ts-expect-error types.sub makes its runner required at run
void run(contextual, withoutSubscribe);
void run(contextual, {
  ...options,
  // @ts-expect-error ctx keeps its declared shape
  ctx: { start: "wrong" },
});
Machine.make({
  ...plainSpec,
  types: { sub: {} as Tick },
  // @ts-expect-error the declared sub still determines its dependencies
  subs: [{ type: "ticker", deps: () => ({ every: "wrong" }) }],
});

// @ts-expect-error the neutral entry still exports Machine as a type only
void Core.Machine;
// @ts-expect-error the Promise entry does not export the Effect maker
void PromiseEntry.Machine;
