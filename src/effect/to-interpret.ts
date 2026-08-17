/**
 * @packageDocumentation
 * Direction 1 — Effect → tea. Lower a dictionary of Effect-authored handlers
 * into the `Interpret<M, C, Ctx>` tea's kernel already knows how to run.
 *
 * The load-bearing rule is `E = never`: a handler's error channel must be
 * discharged INSIDE the effect, folded into a Msg. tea has one failure
 * vocabulary — the Msg union — and a typed Effect failure escaping into the
 * kernel would silently become a rejected dispatch, which in tea means "abort
 * the remaining Cmds of this transition". Fold it, don't leak it.
 *
 * tea semantics preserved verbatim:
 *   - ONE `runPromiseExit` per Cmd; the serial await is tea's, never ours.
 *   - The effect runs `uninterruptible` at the outer region — tea has no
 *     cancellation, so a handler is never interrupted.
 *   - A defect (or interruption) with no `onDefect` rethrows, so it behaves
 *     exactly like a thrown promise handler: the caller's dispatch rejects and
 *     the transition's remaining Cmds are abandoned.
 */

import { Cause, Effect, Exit } from "effect";
import type { Cmd, Interpret, PortEmitter } from "../pure/core";
import type { TeaEnv, TeaServices } from "./services";

/** A ManagedRuntime-shaped runner. Structural so any `R`-providing runner fits. */
export interface EffectRunner<R> {
  readonly runPromiseExit: <A, E>(
    effect: Effect.Effect<A, E, R>,
  ) => Promise<Exit.Exit<A, E>>;
}

/**
 * One Effect-authored interpret cell: the Cmd in, a follow-up Msg (or nothing)
 * out, `E = never` by construction, `R` covering the app's own services plus
 * the two tea services.
 */
export type EffectHandler<M, K extends Cmd, R = never> = (
  cmd: K,
  // biome-ignore lint/suspicious/noConfusingVoidType: mirrors tea's Interpret cell — a handler yields a follow-up Msg or nothing
) => Effect.Effect<M | void, never, R | TeaEnv>;

/**
 * Total dictionary of Effect-authored handlers keyed by `Cmd["type"]` — the
 * Effect-side twin of `Interpret<M, C, Ctx>`.
 */
export type EffectHandlers<M, C extends Cmd, R = never> = {
  [K in C["type"]]: EffectHandler<M, Extract<C, { type: K }>, R>;
};

/** Wiring `toInterpret` / `effectCell` need to lower a handler. */
export interface LoweringOptions<M, Ctx, R> {
  /** The runner that discharges the app's `R` (typically a `ManagedRuntime`). */
  readonly runtime: EffectRunner<R | TeaEnv>;
  /** The keys from `teaServices<M, Ctx>()`. */
  readonly services: TeaServices<M, Ctx>;
  /**
   * Fold a DEFECT (or interruption) into a Msg instead of rejecting. Omit and
   * the defect is rethrown, matching a throwing promise handler.
   */
  // biome-ignore lint/suspicious/noConfusingVoidType: mirrors tea's Interpret cell return — a Msg or nothing
  readonly onDefect?: (defect: unknown, cmd: Cmd) => M | void;
}

/**
 * Lower ONE Effect-authored handler into a tea interpret cell. For mixed
 * dictionaries where only some cells are Effect-authored.
 */
export function effectCell<M extends { type: string }, K extends Cmd, Ctx, R>(
  handler: EffectHandler<M, K, R>,
  options: LoweringOptions<M, Ctx, R>,
): (
  cmd: K,
  ctx: Ctx & PortEmitter,
  dispatch?: (msg: M) => void,
  // biome-ignore lint/suspicious/noConfusingVoidType: mirrors tea's Interpret cell
) => Promise<M | void> {
  const { runtime, services, onDefect } = options;
  return async (cmd, ctx, dispatch) => {
    // The kernel ALWAYS passes `dispatch`; the optionality is a type-level
    // back-compat affordance. A no-op keeps the service total either way.
    const detached = dispatch ?? (() => {});
    const program = handler(cmd).pipe(
      Effect.provideService(services.TeaCtx, ctx),
      Effect.provideService(services.TeaDispatch, { dispatch: detached }),
      // tea never interrupts a handler. Say so at the outer region rather than
      // hoping no caller wires a timeout around the run.
      Effect.uninterruptible,
    );
    const exit = await runtime.runPromiseExit(program);
    if (Exit.isSuccess(exit)) return exit.value;
    // E is `never`, so a Failure here is a defect or an interruption.
    const defect = Cause.squash(exit.cause);
    if (onDefect) return onDefect(defect, cmd);
    throw defect;
  };
}

/**
 * Lower a whole `EffectHandlers` dictionary into the `Interpret<M, C, Ctx>`
 * a `Machine` wants. Totality carries across: the input is keyed by
 * `C["type"]`, so the output is too.
 */
export function toInterpret<
  M extends { type: string },
  C extends Cmd,
  Ctx,
  R = never,
>(
  handlers: EffectHandlers<M, C, R>,
  options: LoweringOptions<M, Ctx, R>,
): Interpret<M, C, Ctx> {
  const lowered: Record<string, unknown> = {};
  for (const key of Object.keys(handlers)) {
    const handler = (
      handlers as unknown as Record<string, EffectHandler<M, C, R>>
    )[key];
    if (handler === undefined) continue;
    lowered[key] = effectCell<M, C, Ctx, R>(handler, options);
  }
  return lowered as Interpret<M, C, Ctx>;
}
