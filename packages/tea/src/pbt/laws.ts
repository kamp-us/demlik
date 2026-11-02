// ---------------------------------------------------------------------------
// The laws, as plain check functions over one fold (#749).
//
// A law reads what `foldEvents` handed back and answers `null` when it holds, or
// a `LawBreak` saying what broke. It draws nothing and throws nothing of its
// own, so any checker can run it: fast-check through `propertyTerminates`,
// `propertyInvariant` and `propertyTrace`, which call these, or Effect's
// `Arbitrary.checkEffect`, through `@demlik/tea/testing/effect`.
//
// This file imports neither `fast-check` nor `effect`, and
// `src/entry-points.import-graph.test.ts` keeps it that way, so both entries
// export it. The ruling: https://github.com/kamp-us/demlik/issues/749#issuecomment-6564369809
// ---------------------------------------------------------------------------

import type { Fold, Step } from "./runners/replay-fold";

/**
 * What a broken law says. `report` names the fold that broke it. `reason` is the
 * string the check returned to say why, or `null` when it returned `false`.
 *
 * @experimental
 */
export interface LawBreak {
  readonly report: string;
  readonly reason: string | null;
}

/**
 * Read what a check answered: `true` and `null` hold, `false` and any string
 * break. An empty string breaks with nothing to say, so it reads as `false`.
 */
function verdict(
  answer: boolean | string | null,
  report: () => string,
): LawBreak | null {
  if (answer === true || answer === null) return null;
  const reason = answer === false || answer === "" ? null : answer;
  return { report: report(), reason };
}

/**
 * The law `propertyTerminates` runs: the fold's final state is one `terminal`
 * accepts. `terminal` also gets the Cmds `init` sent.
 *
 * @example
 * ```ts
 * import type { Machine } from "@demlik/tea";
 * import { foldEvents, lawTerminates } from "@demlik/tea/pbt";
 *
 * type State = { type: "idle" } | { type: "done" };
 * type Msg = { type: "finish" };
 * declare const machine: Machine<State, Msg, never, never, object>;
 *
 * const fold = foldEvents(machine, {}, null, [{ type: "finish" }]);
 * lawTerminates(fold, (s) => s.type === "done"); // null when it holds
 * ```
 *
 * @experimental
 */
export function lawTerminates<S, M, C>(
  fold: Fold<S, M, C>,
  terminal: (state: NoInfer<S>, initCmds: readonly NoInfer<C>[]) => boolean,
): LawBreak | null {
  if (terminal(fold.finalState, fold.initCmds)) return null;
  return {
    report:
      `final state did not match terminal predicate. ` +
      `Final: ${JSON.stringify(fold.finalState)}`,
    reason: null,
  };
}

/**
 * The law `propertyInvariant` runs: `invariant` holds on every step of the fold.
 * Return `true` or `null` to accept, `false` or a string saying why to break. It
 * stops at the first step that breaks, and the report names that step. The second
 * argument is the Cmds `init` sent.
 *
 * @example
 * ```ts
 * import type { Machine } from "@demlik/tea";
 * import { foldEvents, lawInvariant } from "@demlik/tea/pbt";
 *
 * type State = { readonly n: number };
 * type Msg = { type: "inc" };
 * declare const machine: Machine<State, Msg, never, never, object>;
 *
 * const fold = foldEvents(machine, {}, null, [{ type: "inc" }]);
 * lawInvariant(fold, ({ prev, next }) => next.n > prev.n || "n did not grow");
 * ```
 *
 * @experimental
 */
export function lawInvariant<S, M, C>(
  fold: Fold<S, M, C>,
  invariant: (
    step: Step<NoInfer<S>, NoInfer<M>, NoInfer<C>>,
    initCmds: readonly NoInfer<C>[],
  ) => boolean | string | null,
): LawBreak | null {
  for (const step of fold.steps) {
    const broken = verdict(
      invariant(step, fold.initCmds),
      () =>
        `failed at step msg=${JSON.stringify(step.msg)} ` +
        `prev=${JSON.stringify(step.prev)} next=${JSON.stringify(step.next)} ` +
        `cmds=${JSON.stringify(step.cmds)}`,
    );
    if (broken !== null) return broken;
  }
  return null;
}

/**
 * The law `propertyTrace` runs: `predicate` holds on the fold's steps and final
 * state together. Return `true` or `null` to accept, `false` or a string saying
 * why to break. The last argument is the Cmds `init` sent.
 *
 * @example
 * ```ts
 * import type { Machine } from "@demlik/tea";
 * import { foldEvents, lawTrace } from "@demlik/tea/pbt";
 *
 * type State = { type: "open" } | { type: "done" };
 * type Msg = { type: "close" };
 * declare const machine: Machine<State, Msg, never, never, object>;
 *
 * const fold = foldEvents(machine, {}, null, [{ type: "close" }]);
 * lawTrace(fold, (steps, final) => final.type !== "done" || steps.length > 0);
 * ```
 *
 * @experimental
 */
export function lawTrace<S, M, C>(
  fold: Fold<S, M, C>,
  predicate: (
    steps: readonly Step<NoInfer<S>, NoInfer<M>, NoInfer<C>>[],
    finalState: NoInfer<S>,
    initCmds: readonly NoInfer<C>[],
  ) => boolean | string | null,
): LawBreak | null {
  return verdict(
    predicate(fold.steps, fold.finalState, fold.initCmds),
    () =>
      `predicate failed on trace length=${fold.steps.length}, ` +
      `final=${JSON.stringify(fold.finalState)}`,
  );
}
