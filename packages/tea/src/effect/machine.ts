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
): CoreMachine<S, M | Settled<D>, CmdOf<D>, U, Ctx> {
  return defineMachine<S, M, D, U, Ctx>({
    ...spec,
    types: { ...spec.types, model: {} as S, msg: {} as M },
  });
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
 * Build a tea machine with `Machine.make` from required `model` and `msg`
 * Effect schemas and a required `cmds` list. The schemas supply the model and
 * plain message types. `cmds` supplies command values and their settled messages; use `[]`
 * for a machine without commands. No separate model, message or command type
 * declaration is needed.
 *
 * The optional `types` object accepts only `sub` and `ctx`, as phantom values
 * such as `{} as MySub`. The body follows `defineMachine`: `init` returns a
 * model and commands, and `update` is a reducer or transitions table. For a
 * tagged model, name `loaded` in `init` to keep literal return values narrow.
 *
 * These schemas supply types only. The maker performs no decoding at
 * construction, boot or dispatch, and returns the existing tea `Machine` for
 * the engines and pure helpers.
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
 * ```
 */
export const Machine = { make } as const;
