// ---------------------------------------------------------------------------
// `arbSchemaGuidedSequence(machine, ctx, opts)`: Msg lists for Effect's
// `Arbitrary.checkEffect`, whose answers come from each Cmd's own Effect schema
// (#749). A Cmd made with `Cmd.make` from `@demlik/tea/effect` already holds
// its `ok` schema and its `err` tags, so nobody writes its answers a second time.
//
// The lists are drawn as blind events and folded through the machine by the
// same rule `arbGuidedSequence` uses (`src/pbt/arbitraries/guided-fold.ts`), so
// every answer answers a Cmd that was sent and not yet answered. Only the
// generator differs: Effect's `Arbitrary` here, fast-check there. Nothing here
// imports fast-check, and nothing here runs a check: the caller runs
// `Arbitrary.checkEffect`, folds with `foldEvents` and judges with a law.
// The ruling: https://github.com/kamp-us/demlik/issues/749#issuecomment-6564369809
// ---------------------------------------------------------------------------

import { Arbitrary, Data, Result, Schema } from "effect";
import {
  type Answerer,
  type BlindEvent,
  MAX_PICK,
  resolveGuided,
} from "../../pbt/arbitraries/guided-fold";
import {
  type AnyCmdDef,
  assertDistinctCmdNames,
  type Cmd,
  type Machine,
  type Sub,
} from "../../pure/core";

/**
 * The machine has no `cmds` list, so there is no schema to draw an answer from.
 *
 * @experimental
 */
export class NoCmdsError extends Data.TaggedError("NoCmdsError")<{
  readonly message: string;
}> {}

/**
 * A Cmd's `ok` schema is not an Effect schema, so no answer can be drawn from
 * it. A Cmd made with `Cmd.define` from `@demlik/tea` over zod, or any other
 * Standard Schema, lands here. `cmdType` names that Cmd.
 *
 * @experimental
 */
export class NotEffectSchemaError extends Data.TaggedError(
  "NotEffectSchemaError",
)<{
  readonly cmdType: string;
  readonly message: string;
}> {}

/**
 * `machine.cmds` is empty and no `outside` Msg was given, so every list drawn
 * would be empty.
 *
 * @experimental
 */
export class NothingToDrawError extends Data.TaggedError("NothingToDrawError")<{
  readonly message: string;
}> {}

/**
 * Why {@link arbSchemaGuidedSequence} drew no lists.
 *
 * @experimental
 */
export type SchemaAnswersError =
  | NoCmdsError
  | NotEffectSchemaError
  | NothingToDrawError;

/**
 * What {@link arbSchemaGuidedSequence} takes beside the machine and its ctx.
 *
 * @experimental
 */
export interface SchemaGuidedOptions<S, M extends { type: string }> {
  /**
   * The Msgs nothing sends a Cmd for, by Msg type: a user's click, a timer. A
   * Msg type here and in no Cmd's answers is drawn only from here.
   */
  readonly outside?: {
    readonly [K in M["type"]]?: Arbitrary.Arbitrary<Extract<M, { type: K }>>;
  };
  /**
   * Caps the events drawn. Default 60. `checkEffect` and `sampleEffect` cap a
   * list at their `size` too, which defaults to 10, so pass a `size` of at least
   * this to draw lists this long.
   */
  readonly maxLength?: number;
  /**
   * The saved state the fold starts from. Give `foldEvents` the same one, or it
   * reads the list from a different start. Default `null`.
   */
  readonly loaded?: S | null;
}

/** What one answer event drew for one Cmd: its `ok` value, or an `err` tag. */
type Outcome =
  | { readonly outcome: "ok"; readonly value: unknown }
  | { readonly outcome: "err"; readonly tag: string };

/** The minting half of a `CmdDef`, which `AnyCmdDef` leaves out. */
interface Minting {
  readonly ok: (cmd: Cmd, value: unknown) => unknown;
  readonly err: (cmd: Cmd, error: { readonly _tag: string }) => unknown;
}

const PREFIX = "@demlik/tea/testing/effect: arbSchemaGuidedSequence";

/** An arbitrary of the integers from 0 to `max`, both included. */
const upTo = (max: number): Arbitrary.Arbitrary<number> =>
  Arbitrary.schema(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: max })),
  );

/** Draw one of `arms`, each as likely as the next. */
const oneOf = <A>(
  arms: readonly Arbitrary.Arbitrary<A>[],
): Arbitrary.Arbitrary<A> =>
  arms.length === 1
    ? (arms[0] as Arbitrary.Arbitrary<A>)
    : Arbitrary.flatMap(
        upTo(arms.length - 1),
        (at) => arms[at] as Arbitrary.Arbitrary<A>,
      );

/**
 * The outcomes one Cmd's answer is drawn from: its `ok` schema, and each of its
 * `errTags`. `null` when that `ok` schema is not an Effect schema.
 */
function outcomesOf(def: AnyCmdDef): Arbitrary.Arbitrary<Outcome> | null {
  const ok = def.schema.ok;
  if (!Schema.isSchema(ok)) return null;
  const okArm = Schema.Struct({ outcome: Schema.Literal("ok"), value: ok });
  const outcome =
    def.errTags.length === 0
      ? okArm
      : Schema.Union([
          okArm,
          Schema.Struct({
            outcome: Schema.Literal("err"),
            tag: Schema.Literals(def.errTags),
          }),
        ]);
  return Arbitrary.schema(outcome) as Arbitrary.Arbitrary<Outcome>;
}

/**
 * Draw Msg lists for `Arbitrary.checkEffect` in which every answer answers a Cmd
 * that was sent and not yet answered, and comes from that Cmd's own schema: an
 * `ok` answer is drawn from its `schema.ok`, an `err` answer carries one of its
 * `errTags`. Edit a schema and what is drawn changes with it, with no change to
 * the test.
 *
 * Each list is drawn as blind events folded through the machine. An answer event
 * names one waiting Cmd and is minted with that Cmd's def, `def.ok(cmd, value)`
 * or `def.err(cmd, { _tag })`. With nothing waiting the answer is dropped, and an
 * `outside` Msg the event drew goes in its place, or nothing when there is no
 * `outside`. An event whose Msg the state has no cell for is dropped too, and a
 * refused answer leaves its Cmd waiting. A Cmd no def in `machine.cmds` builds is
 * never answered.
 *
 * It runs no check. Fold each list with `foldEvents` and judge it with a law,
 * `lawInvariant`, `lawTerminates` or `lawTrace`, inside `Arbitrary.checkEffect`.
 * A list it finds there shrinks by deleting events and shrinking them, and what
 * is left still folds by the same rule. With `outside` given and every Msg
 * accepted in every state, each event means one Msg, so a shrunk list is never
 * longer than the one first found. A dropped event breaks that: deleting an
 * answer before it can let it back in.
 *
 * A `machine.cmds` that names one Cmd twice throws `CmdNameCollisionError`, as it
 * does in `run` and `drive`: it is a wrong program, not a machine to draw for.
 *
 * It returns a failed `Result`, never an empty arbitrary, on a machine with no
 * `machine.cmds` ({@link NoCmdsError}), on a Cmd whose `ok` schema is not an
 * Effect schema ({@link NotEffectSchemaError}, naming it), and when there is
 * nothing at all to draw ({@link NothingToDrawError}).
 *
 * @example
 * ```ts
 * import type { CmdOf, Machine, Settled } from "@demlik/tea";
 * import { Cmd } from "@demlik/tea/effect";
 * import {
 *   arbSchemaGuidedSequence,
 *   foldEvents,
 *   lawInvariant,
 * } from "@demlik/tea/testing/effect";
 * import { Arbitrary, Effect, Result, Schema } from "effect";
 *
 * const fetchCount = Cmd.make("fetch_count", {
 *   input: Schema.Struct({}),
 *   ok: Schema.Struct({ n: Schema.Int }),
 *   err: ["offline"],
 * });
 * type Msg = { type: "start" } | Settled<typeof fetchCount>;
 * declare const machine: Machine<
 *   { readonly total: number },
 *   Msg,
 *   CmdOf<typeof fetchCount>,
 *   never,
 *   object
 * >;
 *
 * const lists = Result.getOrThrow(
 *   arbSchemaGuidedSequence(machine, {}, {
 *     outside: { start: Arbitrary.Constant({ type: "start" as const }) },
 *   }),
 * );
 * const result = await Effect.runPromise(
 *   Arbitrary.checkEffect(
 *     lists,
 *     (msgs) =>
 *       lawInvariant(foldEvents(machine, {}, null, msgs), ({ next }) =>
 *         Number.isFinite(next.total),
 *       ) === null,
 *     { runs: 500, size: 60 },
 *   ),
 * );
 * ```
 *
 * @experimental
 */
export function arbSchemaGuidedSequence<
  S,
  M extends { type: string },
  C extends Cmd,
  U extends Sub,
  Ctx,
>(
  machine: Machine<S, M, C, U, Ctx>,
  ctx: NoInfer<Ctx>,
  opts?: SchemaGuidedOptions<NoInfer<S>, M>,
): Result.Result<Arbitrary.Arbitrary<readonly M[]>, SchemaAnswersError> {
  const defs = machine.cmds;
  if (defs === undefined) {
    return Result.fail(
      new NoCmdsError({
        message: `${PREFIX}: the machine has no \`cmds\`, so no Cmd has a schema to draw its answer from. List its Cmd constructors in \`defineMachine({ cmds })\`.`,
      }),
    );
  }
  assertDistinctCmdNames(defs);

  const answerers: Answerer<C, M>[] = [];
  const outcomes: Arbitrary.Arbitrary<Outcome>[] = [];
  for (const def of defs) {
    const drawn = outcomesOf(def);
    if (drawn === null) {
      return Result.fail(
        new NotEffectSchemaError({
          cmdType: def.cmdType,
          message: `${PREFIX}: the "${def.cmdType}" Cmd's ok schema is not an Effect schema, so no answer can be drawn from it. Define it with \`Cmd.make\` from \`@demlik/tea/effect\`.`,
        }),
      );
    }
    const mint = def as unknown as Minting;
    answerers.push({
      cmdType: def.cmdType,
      make: (cmd, value) => {
        const drew = value as Outcome;
        return (
          drew.outcome === "ok"
            ? mint.ok(cmd, drew.value)
            : mint.err(cmd, { _tag: drew.tag })
        ) as M;
      },
    });
    outcomes.push(drawn);
  }

  const outsides = Object.values(
    opts?.outside ?? {},
  ) as Arbitrary.Arbitrary<M>[];
  const outside = outsides.length === 0 ? null : oneOf(outsides);
  // An answer event also draws the outside Msg that stands in for it when nothing
  // is waiting. Then every event means one Msg, so a shrink, which only deletes
  // events and shrinks them, can never grow a list past the one first found.
  const answer =
    outcomes.length === 0
      ? null
      : Arbitrary.map(
          Arbitrary.all([
            upTo(MAX_PICK),
            Arbitrary.all(outcomes),
            outside ?? Arbitrary.Constant(undefined),
          ]),
          ([pick, values, otherwise]): BlindEvent<M> =>
            otherwise === undefined
              ? { kind: "answer", pick, values }
              : { kind: "answer", pick, values, otherwise },
        );

  // An answer is twice as likely as an outside Msg, as in `arbGuidedSequence`.
  // The answer arms come first, so a shrink turns an outside Msg into an answer,
  // which sends less, and never the other way.
  const arms: Arbitrary.Arbitrary<BlindEvent<M>>[] = [];
  if (answer !== null) arms.push(answer, answer);
  if (outside !== null) {
    arms.push(
      Arbitrary.map(
        outside,
        (msg): BlindEvent<M> => ({ kind: "outside", msg }),
      ),
    );
  }
  if (arms.length === 0) {
    return Result.fail(
      new NothingToDrawError({
        message: `${PREFIX}: \`machine.cmds\` is empty and no \`outside\` Msg was given, so every list would be empty.`,
      }),
    );
  }

  const loaded = opts?.loaded ?? null;
  return Result.succeed(
    Arbitrary.map(
      Arbitrary.array(oneOf(arms), { maxLength: opts?.maxLength ?? 60 }),
      (events) => resolveGuided(machine, ctx, loaded, answerers, events),
    ),
  );
}
