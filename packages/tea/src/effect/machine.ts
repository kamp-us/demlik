import type { Schema } from "effect";
import type {
  AnyCmdDef,
  Cmd,
  CmdOf,
  Machine as CoreMachine,
  Settled,
  Sub,
} from "../pure/core";
import { defineMachine, type MachineTypes } from "../runtime-types";

function make<
  S,
  M extends { type: string },
  D extends AnyCmdDef,
  U extends Sub = Sub<never>,
  Ctx = unknown,
>(
  spec: NoInfer<
    Omit<CoreMachine<S, M | Settled<D>, CmdOf<D>, U, Ctx>, "cmds">
  > & {
    readonly model: Schema.Schema<S>;
    readonly msg: Schema.Schema<M>;
    readonly cmds: readonly D[];
    readonly types?: Pick<MachineTypes<S, M, never, U, Ctx>, "sub" | "ctx">;
  },
): CoreMachine<S, M | Settled<D>, CmdOf<D>, U, Ctx> & {
  readonly model: Schema.Schema<S>;
  readonly msg: Schema.Schema<M>;
} {
  const machine = {
    ...spec,
    types: { ...spec.types, model: {} as S, msg: {} as M },
  };
  defineMachine<S, M, D, U, Ctx>(machine);
  return machine;
}

/** A core tea machine, with the same init, update and engine contracts. */
export type Machine<
  S,
  M extends { type: string },
  C extends Cmd,
  U extends Sub,
  Ctx,
> = CoreMachine<S, M, C, U, Ctx>;

/**
 * Build a tea machine with readonly `model` and `msg` schema references for
 * explicit host decoding. Required `model` and `msg` Effect schemas supply the
 * model and plain message types. A required `cmds` list supplies command values
 * and their settled messages; use `[]`
 * for a machine without commands. No separate model, message or command type
 * declaration is needed.
 *
 * The optional `types` object accepts only `sub` and `ctx`, as phantom values
 * such as `{} as MySub`. The body follows `defineMachine`: `init` returns a
 * model and commands, and `update` is a reducer or transitions table. For a
 * tagged model, name `loaded` in `init` to keep literal return values narrow.
 *
 * The result exposes the same schema references as readonly `model` and `msg`
 * properties, typed as `Schema.Schema<S>` and `Schema.Schema<M>`. `msg` describes
 * plain messages only, without command-settlement messages. The result remains
 * a core tea `Machine` accepted by the engines and pure helpers.
 *
 * The maker performs no decoding at construction, boot or dispatch. Hosts parse
 * external data explicitly. The exposed schema types track decoded values;
 * `Schema.toType(machine.model)` and `Schema.toType(machine.msg)` let a host
 * validate saved models and incoming messages already in those decoded shapes.
 *
 * @example
 * ```ts
 * import { Machine } from "@demlik/tea/effect";
 * import { Schema } from "effect";
 *
 * const counter = Machine.make({
 *   model: Schema.Struct({ count: Schema.Number }),
 *   msg: Schema.Struct({ type: Schema.Literal("UserIncremented") }),
 *   cmds: [],
 *   init: (loaded) => [loaded ?? { count: 0 }, []],
 *   update: {
 *     UserIncremented: (state) => [{ count: state.count + 1 }, []],
 *   },
 * });
 *
 * Schema.decodeUnknownSync(Schema.toType(counter.model))({ count: 2 });
 * Schema.decodeUnknownSync(Schema.toType(counter.msg))({
 *   type: "UserIncremented",
 * });
 * ```
 */
export const Machine = { make } as const;
