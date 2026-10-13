/**
 * The Effect entry's `Cmd`: the core `Cmd` with a `define` that takes plain
 * Effect schemas (#631). It is a function over the core `Cmd.define`, so the
 * def it returns is the same `CmdDef` a hand-wrapped call builds.
 */

import { Schema } from "effect";
import {
  type CmdDef,
  type CmdInput,
  Cmd as CoreCmd,
  type TaggedError,
} from "../pure/core";

/**
 * An Effect schema that checks a value and hands the same type on. Both sides
 * are one type, and decoding needs no service.
 *
 * tea types a handler's answer by the type the `ok` schema hands on, and checks
 * that answer by parsing it. A schema whose two sides differ — a
 * transformation like `Schema.FiniteFromString`, a brand — would refuse the
 * very value the handler's type asks for, so it does not compile here. Pass
 * `Schema.toType(schema)` to keep the checks and drop the translation.
 */
export type CheckingSchema<T> = Schema.Codec<T, NoInfer<T>>;

function define<
  const Name extends string,
  Input extends CmdInput,
  Ok,
  const Tags extends readonly string[],
>(
  name: Name,
  spec: {
    readonly input: CheckingSchema<Input>;
    readonly ok: CheckingSchema<Ok>;
    readonly err: Tags;
  },
): CmdDef<Name, Input, Ok, TaggedError<Tags[number]>> {
  return CoreCmd.define(name, {
    input: Schema.toStandardSchemaV1(spec.input),
    ok: Schema.toStandardSchemaV1(spec.ok),
    err: spec.err,
  });
}

/**
 * A Cmd value, as the core types it. Exported beside the `Cmd` helpers so an
 * Effect user reads both from this entry.
 */
export type Cmd<T extends string = string, Ok = unknown, E = unknown> = CoreCmd<
  T,
  Ok,
  E
>;

/**
 * The helpers for building Cmds on the Effect engine. `Cmd.none`, `Cmd.batch`,
 * `Cmd.when` and `Cmd.whenDefined` are the core's; `Cmd.define` is this
 * entry's own.
 */
export const Cmd = {
  ...CoreCmd,
  /**
   * Declare a typed Cmd constructor from plain Effect schemas. It returns what
   * the core `Cmd.define` returns, with each schema passed through
   * `Schema.toStandardSchemaV1` for you:
   *
   *   const fetchUser = Cmd.define("fetch_user", {
   *     input: Schema.Struct({ id: Schema.String }),
   *     ok: Schema.Struct({ name: Schema.String }),
   *     err: ["not_found"],
   *   });
   *
   * `input` and `ok` take a schema that checks and never translates: both of
   * its sides are one type and decoding needs no service. A transformation, a
   * brand or a schema that needs a service is a compile error.
   *
   * To keep the checks of a transformation or a brand, pass
   * `Schema.toType(schema)`. That is no way through for a schema that needs a
   * service: its check lives in the decode step, and `Schema.toType` drops that
   * step, so the Cmd would compile and never run the check. Run such a check in
   * the handler.
   *
   * A schema whose validation needs a Promise compiles, and is refused with
   * `AsyncSchemaError` when the Cmd settles, as the core's is.
   *
   * It takes Effect schemas only. A zod schema, or any other Standard Schema,
   * goes to `Cmd.define` from `@demlik/tea`.
   */
  define,
} as const;
