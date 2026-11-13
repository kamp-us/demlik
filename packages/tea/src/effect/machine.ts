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

/**
 * `unknown` while no plain Msg tag is a settled Msg name of a listed Cmd, else
 * an object with one required key per colliding tag, so `msg: Schema.Schema<M>`
 * is refused on its own line with each tag named in the diagnostic.
 */
type NoSettledTag<M extends { type: string }, D extends AnyCmdDef> = [
  Extract<M["type"], Settled<D>["type"]>,
] extends [never]
  ? unknown
  : {
      readonly [Tag in `msg tag "${Extract<
        M["type"],
        Settled<D>["type"]
      >}" is a settled Msg name of a listed Cmd`]: never;
    };

/**
 * The members of a tag union that are no one literal: `string` or a template
 * literal. `Record<Tag, unknown>` has no required key for either, so the empty
 * object satisfies it, and it has one for every literal.
 */
type OpenTag<Tag extends string> = Tag extends string
  ? Record<never, never> extends Record<Tag, unknown>
    ? Tag
    : never
  : never;

/**
 * `unknown` while every plain Msg tag is a literal, else one required key that
 * says so. One open member among literals is still found, since `OpenTag`
 * reads each member alone.
 */
type LiteralTags<Tag extends string> = [OpenTag<Tag>] extends [never]
  ? unknown
  : { readonly "every msg tag must be a literal, not an open string": never };

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
    readonly msg: Schema.Schema<M> &
      NoSettledTag<M, D> &
      LiteralTags<M["type"]>;
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
 * Two declarations are refused on the `msg` line, and the diagnostic names the
 * fault. A plain message whose tag is a settled message name of a listed
 * command (`fetch_file_ok` beside the command `fetch_file`) would put two
 * different messages in one update cell; the diagnostic names each such tag,
 * and the fix is to rename the message. A message whose tag is not a literal
 * (`Schema.String`, or a `Schema.TemplateLiteral`) would turn the update table
 * into one that accepts any cell name, so a misspelled cell compiles; the
 * diagnostic says every tag must be a literal, and the fix is to give the
 * message a `Schema.Literal` tag.
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
