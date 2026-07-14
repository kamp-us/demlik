/**
 * @demlik/tea/await-terminal — run a ONE-SHOT / decision-procedure machine to a
 * terminal state and hand the caller a `Promise<State>` that resolves the moment
 * the machine FIRST enters a terminal state.
 *
 * This is the ~10 lines both audit suitability probes hand-wired at their
 * integration seam: a one-shot decision machine (a credibility check, an auth
 * mint, a validation pass — run to a terminal state, then throw-or-proceed at the
 * caller boundary) has no built-in "await the terminal", so each consumer re-wires
 * a promise off `observe` that resolves when the state is terminal. This helper
 * lifts that boilerplate into `@demlik/tea` once.
 *
 * It rides the EXISTING observation surface (`packages/tea/src/index.ts`) and adds
 * NO new runtime capability:
 *   - `runtime.getState()` (total on a booted `Runtime`) covers the
 *     already-terminal-at-attach case — resolve synchronously rather than wait for
 *     a transition that may never come.
 *   - `runtime.observe((msg, state) => void): () => void` fires on EVERY transition
 *     and returns an unsubscribe — the "first terminal transition" signal, detached
 *     the instant it resolves (no leak, no busy-wait / polling loop).
 *   - `runtime.stop()` is the teardown the fire-and-await `runToTerminal` owns.
 *
 * `isTerminal` is caller-supplied — tea has no built-in terminal-set concept and
 * this helper does NOT invent one; the caller names their own terminal states.
 *
 * The optional `timeoutMs` is a plain caller-boundary timer (not an in-loop
 * progress deadline — see `../deadline` / `../with-deadline` for that shape): it
 * clears on resolve and REJECTS with the `instanceof`-checkable
 * {@link TerminalTimeoutError} if the deadline elapses first, never silently
 * resolving.
 */

import {
  type Cmd,
  type CtxArg,
  type Machine,
  type Runtime,
  run,
  type Sub,
} from "../index";

/**
 * Raised when `awaitTerminal` / `runToTerminal` is wired with a `timeoutMs` and
 * the deadline elapses before any terminal state is reached. Follows the tea
 * error dialect (`override readonly name`) and carries a `_tag` discriminant, so
 * a caller can branch on it either by `instanceof` or on the tag — the timeout is
 * a distinct, checkable rejection, never a silent resolve.
 */
export class TerminalTimeoutError extends Error {
  override readonly name = "TerminalTimeoutError";
  readonly _tag = "TerminalTimeoutError" as const;
  constructor(public readonly timeoutMs: number) {
    super(
      `@demlik/tea: awaitTerminal did not reach a terminal state within ` +
        `${timeoutMs}ms — no transition satisfied isTerminal before the deadline.`,
    );
  }
}

/** Options shared by `awaitTerminal` and `runToTerminal`. */
export interface AwaitTerminalOptions {
  /**
   * Optional bounded deadline in milliseconds. When set, the returned promise
   * REJECTS with {@link TerminalTimeoutError} if no terminal state is reached
   * within the window; the timer is cleared on the resolve path so a resolved
   * await never later rejects or leaves a dangling timer. Omit for an unbounded
   * await (never rejects for time).
   */
  readonly timeoutMs?: number;
}

/**
 * Attach to an ALREADY-RUNNING `Runtime<S, M, E>` and resolve with the terminal
 * `S` on the first transition for which `isTerminal(state)` is true.
 *
 * If the runtime is ALREADY terminal at attach time (`isTerminal(getState())`),
 * resolves immediately — it never hangs waiting for a transition that will not
 * come. Otherwise it subscribes via `observe` and detaches that subscription the
 * instant it resolves (or times out), so there is no observer leak and no
 * further callbacks fire.
 *
 * @param runtime    a booted `Runtime` (from `await run(machine, opts).ready`).
 * @param isTerminal caller-supplied terminal predicate over the machine's state.
 * @param opts       optional bounded `timeoutMs` deadline (see {@link AwaitTerminalOptions}).
 */
export function awaitTerminal<
  S,
  M extends { type: string },
  E extends { type: string } = never,
>(
  runtime: Runtime<S, M, E>,
  isTerminal: (state: S) => boolean,
  opts: AwaitTerminalOptions = {},
): Promise<S> {
  return new Promise<S>((resolve, reject) => {
    // Already-terminal-at-attach: resolve now. Returning here attaches neither an
    // observer nor a timer, so the immediate case cannot leak either.
    const current = runtime.getState();
    if (isTerminal(current)) {
      resolve(current);
      return;
    }

    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let detach: (() => void) | undefined;

    const cleanup = (): void => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (detach !== undefined) {
        detach();
        detach = undefined;
      }
    };

    detach = runtime.observe((_msg, state) => {
      if (settled) return;
      if (isTerminal(state)) {
        settled = true;
        cleanup();
        resolve(state);
      }
    });

    // Narrow into a const so the closure keeps the `number` narrowing (the field
    // itself is `number | undefined`).
    const timeoutMs = opts.timeoutMs;
    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new TerminalTimeoutError(timeoutMs));
      }, timeoutMs);
    }
  });
}

/**
 * Fire-and-await convenience: `run()` the machine, dispatch the seed `msgs`, and
 * resolve with the terminal state — then tear the runtime down (`runtime.stop()`)
 * on BOTH the resolve and reject paths. Wraps {@link awaitTerminal}.
 *
 * The seed carries the machine's `ctx` (conditionally optional, exactly as
 * `run`'s `ctx` — a pure machine omits it) and the `msgs` to dispatch once
 * booted. A `timeoutMs` in `opts` bounds the await identically to `awaitTerminal`.
 *
 * @param machine    the machine to boot.
 * @param seed       `{ ctx?, msgs }` — the boot context and the seed messages.
 * @param isTerminal caller-supplied terminal predicate over the machine's state.
 * @param opts       optional bounded `timeoutMs` deadline (see {@link AwaitTerminalOptions}).
 */
export async function runToTerminal<
  S,
  M extends { type: string },
  C extends Cmd,
  U extends Sub,
  Ctx,
>(
  machine: Machine<S, M, C, U, Ctx>,
  seed: CtxArg<Ctx> & { readonly msgs: readonly M[] },
  isTerminal: (state: S) => boolean,
  opts: AwaitTerminalOptions = {},
): Promise<S> {
  // Split the seed messages out from the boot context: `run`'s opts don't carry
  // `msgs`, so what remains is exactly the conditionally-optional `ctx` arg. The
  // cast is because `CtxArg<Ctx>` is a deferred generic conditional TS won't
  // verify against `run`'s all-optional opts (its weak-type check) — the value
  // is structurally valid; `run` defaults an absent `ctx` to `{}`.
  const { msgs, ...ctxArg } = seed;
  const runtime = await run<S, M, C, U, Ctx>(
    machine,
    ctxArg as Parameters<typeof run<S, M, C, U, Ctx>>[1],
  ).ready;
  try {
    // Attach the terminal await BEFORE dispatching so a terminal transition that
    // lands during a seed dispatch is caught (and the immediate-terminal check
    // inside awaitTerminal covers a machine that boots already terminal).
    const terminal = awaitTerminal(runtime, isTerminal, opts);
    // Dispatch runs serially on the runtime's tail; fire all seeds and let a
    // dispatch failure (a reducer/interpret throw) surface by racing it against
    // the terminal await rather than floating as an unhandled rejection.
    const seeding = Promise.all(msgs.map((msg) => runtime.dispatch(msg)));
    const state = await Promise.race([terminal, seeding.then(() => terminal)]);
    await runtime.stop();
    return state;
  } catch (err) {
    // Tear down on the reject path too (timeout, dispatch failure) — a rejected
    // runToTerminal never leaves the runtime running.
    await runtime.stop().catch(() => {});
    throw err;
  }
}
