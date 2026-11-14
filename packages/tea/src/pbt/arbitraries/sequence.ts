// ---------------------------------------------------------------------------
// Msg-sequence arbitraries.
//
// `arbMsgSequence(msgArb, opts)` produces `fc.Arbitrary<readonly M[]>` —
// fast-check's default-shrinker handles the array; the per-element shrinker
// inside `msgArb` shrinks each variant. Optional `prefix` is prepended
// verbatim (used by Test A: "the bug-triggering Msg leads the sequence").
//
// `arbGuidedSequence(machine, ctx, cells, opts)` draws lists whose answers each
// fit a Cmd really sent. It draws blind events first, then a `map` folds them
// through the machine and gives each one its meaning, so a shrink can delete any
// event and the rest still make a valid list. The fold is `./guided-fold.ts`,
// which `@demlik/tea/testing/effect` shares. The route and its numbers are in
// the ruling: https://github.com/kamp-us/demlik/issues/745#issuecomment-6552209764
// ---------------------------------------------------------------------------

import * as fc from "fast-check";
import type { Cmd, Machine, Sub } from "../../index";
import { assertDistinctCmdNames } from "../../pure/core";
import {
  type Answerer,
  type BlindEvent,
  MAX_PICK,
  resolveGuided,
} from "./guided-fold";

/**
 * Build an arbitrary of Msg sequences over a per-Msg arbitrary. Optionally
 * bounded in length and / or prefixed with a fixed sequence.
 *
 * - `minLength` (default 0) and `maxLength` (default 30) bound the random
 *   array length. `prefix` is prepended AFTER the random tail is built; the
 *   final length is `prefix.length + tail.length`. `size` decides how much of
 *   that bound the draws actually use.
 * - `prefix` is the load-bearing escape hatch for "the first msg is the
 *   one that exercises the cell I care about" (e.g. Test A's
 *   `[{ type: "ws:client:hello" }]` prefix to land in the
 *   `auditing.ws:client:hello` cell on the first transition).
 *
 * @example
 * ```ts
 * import { arbMsgSequence } from "@demlik/tea/pbt";
 * import type * as fc from "fast-check";
 *
 * type Msg = { type: "ws:client:hello" } | { type: "tick" };
 * declare const msgArb: fc.Arbitrary<Msg>;
 *
 * arbMsgSequence(msgArb, { minLength: 1, maxLength: 30 });
 * arbMsgSequence(msgArb, { prefix: [{ type: "ws:client:hello" }], maxLength: 20 });
 * arbMsgSequence(msgArb, { maxLength: 60, size: "max" });
 * ```
 */
export function arbMsgSequence<M extends { type: string }>(
  msgArb: fc.Arbitrary<M>,
  opts?: {
    readonly minLength?: number;
    readonly maxLength?: number;
    readonly prefix?: readonly NoInfer<M>[];
    /**
     * Forwarded to `fc.array`. Left out, fast-check's default size applies:
     * `"small"` unless `fc.configureGlobal` changed it, which draws at most
     * `2 * minLength + 10` Msgs however large `maxLength` is. So `maxLength: 60`
     * comes out about 10 long, and a state that takes more steps than that is
     * never reached. Pass `"max"` to draw up to `maxLength`.
     */
    readonly size?: fc.SizeForArbitrary;
  },
): fc.Arbitrary<readonly M[]> {
  const minLength = opts?.minLength ?? 0;
  const maxLength = opts?.maxLength ?? 30;
  const prefix = opts?.prefix ?? [];
  const tail = fc.array(msgArb, { minLength, maxLength, size: opts?.size });
  if (prefix.length === 0) return tail;
  return tail.map((arr) => [...prefix, ...arr]);
}

/**
 * How one type of Cmd gets answered. `draw` runs before the fold, so a shrink
 * can shrink its value, and it cannot see the state. `make` runs in the fold and
 * gets the Cmd really sent, so an answer is `make: (cmd, v) => fetch.ok(cmd, v)`.
 * To draw both outcomes, have `draw` choose between them.
 */
export interface AnswerCell<K extends Cmd, V, M> {
  readonly draw: fc.Arbitrary<V>;
  readonly make: (cmd: K, value: V) => NoInfer<M>;
}

/**
 * What {@link arbGuidedSequence} draws from. `outside` holds the Msgs nothing
 * sends a Cmd for, by Msg type. `answers` holds an {@link AnswerCell} by Cmd type,
 * and `A` is the value each one draws, inferred from its `draw`. A Cmd type with no
 * cell is never answered. A Msg type in neither table is never drawn.
 */
export interface GuidedCells<
  M extends { type: string },
  C extends Cmd,
  A extends { readonly [K in C["type"]]?: unknown },
> {
  readonly outside?: {
    readonly [K in M["type"]]?: fc.Arbitrary<Extract<M, { type: K }>>;
  };
  readonly answers?: {
    readonly [K in keyof A]: K extends C["type"]
      ? AnswerCell<Extract<C, { type: K }>, A[K], M>
      : never;
  };
}

/**
 * Draw Msg lists in which every answer answers a Cmd that was sent and not yet
 * answered, so a law that something must happen can be checked on random lists.
 * The result is a plain list for any runner, such as `propertyTerminates`.
 *
 * It draws blind events, then folds them through the machine. An answer event
 * holds a pick and one value per answer cell, and the fold reads the pick modulo
 * the Cmds waiting at that point. With nothing waiting, the event is dropped.
 *
 * **Refusals.** An event whose Msg the state at that point has no cell for is
 * dropped too, in either update form, so a transitions machine can leave a Msg out
 * of a state and no list holds it there. A Cmd whose answer was refused keeps
 * waiting, and a later event can still answer it. A list therefore never tests
 * that a state refuses a Msg: send that Msg by hand for that.
 *
 * **Waiting** holds every Cmd that `init` and the steps have sent, that has a cell
 * in `answers`, and that has no answer yet. A Cmd sent twice waits twice. The fold
 * reads it off what the reducer returned, not `machine.cmds`, so a machine with no
 * `cmds` field gets the same lists, and a hand-written Cmd is answered like a
 * defined one. No answer is matched by its `cmd` field: the pick names the Cmd.
 *
 * A shrink deletes events and shrinks picks and values, and the fold reads what
 * is left, so a shrunk list holds to the same rule. Blind picks find a narrow
 * order less often than a guided draw would, which more runs pay for.
 *
 * A step that throws ends its list on the Msg that threw, so a runner's fold meets
 * the same throw and reports it as that list's failure.
 *
 * A `machine.cmds` that names one Cmd twice throws `CmdNameCollisionError`, as it
 * does in `run` and `drive`. The answers here come from the cells' keys, so a
 * repeat would not change them; the rule holds on every entry that draws or runs a list.
 *
 * - `maxLength` (default 60) caps the events drawn, and dropped ones count, so a
 *   list comes out shorter. `size` (default `"max"`) is forwarded to `fc.array`:
 *   with most answers dropped, fast-check's `"small"` rarely gets a run anywhere.
 * - `loaded` starts the fold from a saved state. Give a runner the same one, or
 *   its fold reads the list from a different start.
 *
 * Throws when `cells` has no cell at all, since that could only draw empty lists.
 *
 * @example
 * ```ts
 * import type { Machine } from "@demlik/tea";
 * import {
 *   arbConstantMsg,
 *   arbGuidedSequence,
 *   propertyTrace,
 *   stubCtxThrowingProxy,
 * } from "@demlik/tea/pbt";
 * import * as fc from "fast-check";
 *
 * type Merge = { readonly type: "merge"; readonly pr: number };
 * type State = { type: "idle" } | { type: "merging" } | { type: "landed" };
 * type Msg = { type: "start" } | { type: "merged"; cmd: Merge; sha: string };
 * declare const machine: Machine<State, Msg, Merge, never, object>;
 * const ctx = stubCtxThrowingProxy<object>();
 *
 * const lists = arbGuidedSequence(machine, ctx, {
 *   outside: { start: arbConstantMsg("start") },
 *   answers: {
 *     merge: {
 *       draw: fc.string(),
 *       make: (cmd, sha) => ({ type: "merged", cmd, sha }),
 *     },
 *   },
 * });
 *
 * propertyTrace(
 *   machine,
 *   ctx,
 *   lists,
 *   (steps, final) =>
 *     !steps.some((step) => step.msg.type === "merged") ||
 *     final.type === "landed",
 * );
 * ```
 */
export function arbGuidedSequence<
  S,
  M extends { type: string },
  C extends Cmd,
  U extends Sub,
  Ctx,
  A extends { readonly [K in C["type"]]?: unknown },
>(
  machine: Machine<S, M, C, U, Ctx>,
  ctx: NoInfer<Ctx>,
  cells: GuidedCells<M, C, A>,
  opts?: {
    readonly maxLength?: number;
    readonly size?: fc.SizeForArbitrary;
    readonly loaded?: NoInfer<S> | null;
  },
): fc.Arbitrary<readonly M[]> {
  assertDistinctCmdNames(machine.cmds ?? []);
  type Cell = AnswerCell<C, unknown, M>;
  const outside = Object.values(cells.outside ?? {}) as fc.Arbitrary<M>[];
  const answers = Object.entries(cells.answers ?? {}) as [string, Cell][];
  const answerers = answers.map(
    ([cmdType, cell]): Answerer<C, M> => ({ cmdType, make: cell.make }),
  );

  const arms: fc.WeightedArbitrary<BlindEvent<M>>[] = [];
  if (outside.length > 0) {
    arms.push({
      weight: 1,
      arbitrary: fc
        .oneof(...outside)
        .map((msg): BlindEvent<M> => ({ kind: "outside", msg })),
    });
  }
  if (answers.length > 0) {
    arms.push({
      weight: 2,
      arbitrary: fc
        .tuple(
          fc.nat(MAX_PICK),
          fc.tuple(...answers.map(([, cell]) => cell.draw)),
        )
        .map(
          ([pick, values]): BlindEvent<M> => ({
            kind: "answer",
            pick,
            values,
          }),
        ),
    });
  }
  if (arms.length === 0) {
    throw new Error(
      "@demlik/tea/pbt: arbGuidedSequence got no cells, in `outside` or `answers`, so it could only draw empty lists.",
    );
  }

  const loaded = opts?.loaded ?? null;
  return fc
    .array(fc.oneof(...arms), {
      maxLength: opts?.maxLength ?? 60,
      size: opts?.size ?? "max",
    })
    .map((events) => resolveGuided(machine, ctx, loaded, answerers, events));
}
