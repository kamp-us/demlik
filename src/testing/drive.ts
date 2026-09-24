// ---------------------------------------------------------------------------
// `drive(machine, initial, msg, handlers, opts)` — the runtime's own loop,
// said once, for a test.
//
// `bindMachine` hands back the Cmds a fold emitted and stops there; performing
// them is the caller's. So every consumer test that exercises a Cmd-emitting
// machine hand-writes the same fixture: step the Msg, await the real interpret
// handler over each emitted Cmd, feed the settle Msg back, repeat until quiet,
// with a hand-picked guard bound in the loop header. The guard count, the
// accumulate-then-swap order and the "did I drain this round before starting
// the next" question are re-decided at every copy site, and one of those copies
// ships in `docs/how-to/ask-jev-a-typed-question.md`.
//
// `drive` is that fixture as one call. It composes `bindMachine`'s synchronous
// 2-arg `step` and adds NO second reducer path — there is no `Runtime` here, no
// observation, no clock, and nothing borrowed from the internal flow helpers.
// The only impure thing it does is `await` the handler the caller handed it.
//
// **It returns the history, not just the endpoint.** `{ state, trace }`, where
// `trace` is every Msg folded and every Cmd dispatched in order, is what makes
// this worth a stable export rather than a snippet: a test asserts on the
// SEQUENCE as well as the settled state — which handler ran, in which round,
// and what came back — and the same trace's Msgs replayed through `replay` from
// the same initial state reproduce the returned state exactly.
//
// Prior art converged on the same answer: Temporal's `TestWorkflowEnvironment`
// hands a test the event history rather than the final result, and Effect's
// `TestClock` runs make the effect log inspectable rather than opaque.
//
// **Exhausting `maxRounds` THROWS.** A driver that quietly returns a
// half-driven state lets a test assert green on a machine that never settled —
// the exact failure a hand-rolled `guard < 10` already risks.
//
// Strengthens invariant 9 (the testing surface is named and small).
// ---------------------------------------------------------------------------

import {
  type Cmd,
  type CtxArg,
  type Interpret,
  type Machine,
  Outcome,
  type PortEmitter,
  type Sub,
} from "../index";
import { cmdEdge, cmdEdgeOver, followUps } from "../pure/core";
import { bindMachine } from "./bind-machine";

/**
 * The default round bound when `opts.maxRounds` is omitted: **100**.
 *
 * A round is one drain of the pending Msgs plus one drain of the Cmds those
 * folds emitted, so a settling machine costs a handful; 100 is loose enough
 * that a legitimate retry ladder finishes inside it and tight enough that a
 * genuine cycle stops rather than hangs.
 */
export const DEFAULT_MAX_ROUNDS = 100;

/**
 * One entry of a driven run's history, in dispatch order.
 *
 * - `msg` — a Msg folded through the machine's reducer. The seed Msg is the
 *   first entry of every trace; every later one is a settle Msg a handler
 *   returned (or fired through its injected `dispatch`).
 * - `cmd` — a Cmd handed to an interpret handler. It is recorded BEFORE the
 *   handler is awaited, so a trace recovered from a rejected handler names the
 *   Cmd that rejected as its last entry.
 */
export type DriveTraceEntry<M, C> =
  | { readonly kind: "msg"; readonly msg: M }
  | { readonly kind: "cmd"; readonly cmd: C };

/** What a settled {@link drive} hands back. */
export interface DriveResult<S, M, C> {
  /** The state after the machine went quiet — no Msg pending, no Cmd unperformed. */
  readonly state: S;
  /**
   * Every Msg folded and every Cmd dispatched, in order. Filtering it to its
   * `msg` entries and replaying those through `replay` from the same initial
   * state reproduces {@link DriveResult.state}.
   */
  readonly trace: readonly DriveTraceEntry<M, C>[];
}

/**
 * {@link drive}'s `ctx` field. `CtxArg` widened by exactly one case: a machine
 * declaring `ctx: undefined` in its `types` block — the pure shape every
 * how-to on this package writes — may omit it too. `CtxArg` alone keeps `ctx`
 * REQUIRED there, because `{}` is not assignable to `undefined`, which would
 * make the common pure call site spell `{ ctx: undefined }` to say nothing.
 * A machine whose `Ctx` carries a field a handler reads still requires it.
 */
export type DriveCtxArg<Ctx> = [undefined] extends [Ctx]
  ? { readonly ctx?: Ctx }
  : CtxArg<Ctx>;

/**
 * {@link drive}'s options. `ctx` is conditionally optional (see
 * {@link DriveCtxArg}).
 */
export type DriveOptions<Ctx> = DriveCtxArg<Ctx> & {
  /**
   * The round bound. Exceeding it throws {@link DriveRoundsExceededError};
   * `drive` never returns a half-driven state. Defaults to
   * {@link DEFAULT_MAX_ROUNDS} (100).
   */
  readonly maxRounds?: number;
  /**
   * The clock that stamps `at` on a `Cmd.define`d Cmd's minted `_ok` / `_err`
   * Msg — the one `run` takes. Defaults to `Date.now`; pin it for a test that
   * asserts on `at`.
   */
  readonly clock?: () => number;
};

/**
 * Raised when a driven machine is still emitting work after `maxRounds` rounds.
 * Follows the tea error dialect (`override readonly name`) and carries a `_tag`
 * discriminant, so a test branches on it by `instanceof` or on the tag.
 *
 * It carries the round count it stopped at and the PARTIAL trace up to that
 * point, which is what a test needs to see the cycle — the bound alone says
 * only that one exists.
 */
export class DriveRoundsExceededError<M, C> extends Error {
  override readonly name = "DriveRoundsExceededError";
  readonly _tag = "DriveRoundsExceededError" as const;
  constructor(
    /** The bound that was exceeded. */
    public readonly maxRounds: number,
    /** The round the driver stopped at — always `maxRounds + 1`. */
    public readonly rounds: number,
    /** Every Msg folded and Cmd dispatched before the driver gave up. */
    public readonly trace: readonly DriveTraceEntry<M, C>[],
  ) {
    super(
      `@demlik/tea: drive did not settle within ${maxRounds} round(s) — the ` +
        `machine was still emitting work at round ${rounds}. The partial ` +
        `trace (${trace.length} entr${trace.length === 1 ? "y" : "ies"}) is ` +
        `on the error's \`trace\` field.`,
    );
  }
}

/**
 * Raised when a Cmd reaches {@link drive} with no handler for its `type` in the
 * `handlers` record. `Interpret`'s mapped type makes that a compile error at a
 * well-typed call site; this is the runtime arm for a handler record assembled
 * dynamically or cast.
 */
export class DriveNoHandlerError<M, C> extends Error {
  override readonly name = "DriveNoHandlerError";
  readonly _tag = "DriveNoHandlerError" as const;
  constructor(
    /** The Cmd `type` nothing in the handler record answered. */
    public readonly cmdType: string,
    /** Every Msg folded and Cmd dispatched before the miss. */
    public readonly trace: readonly DriveTraceEntry<M, C>[],
  ) {
    super(
      `@demlik/tea: drive found no interpret handler for Cmd type ` +
        `"${cmdType}" — the handlers record must answer every Cmd the ` +
        `machine emits.`,
    );
  }
}

/** The key `drive` hangs a partial trace off a rejected handler's error under. */
const TRACE_KEY = "driveTrace";

/**
 * Read back the partial trace `drive` attached to an error a handler rejected
 * with. Returns `undefined` for anything `drive` did not annotate.
 *
 * A rejecting handler's error propagates out of `drive` UNSWALLOWED — same
 * value, same `instanceof`, same `_tag` — so a test that already branches on
 * the handler's own error type keeps doing so. The trace rides along on a
 * non-enumerable property so it is recoverable without changing how the error
 * prints or serializes.
 */
export function driveTraceOf<M, C>(
  err: unknown,
): readonly DriveTraceEntry<M, C>[] | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const carried = (err as Record<string, unknown>)[TRACE_KEY];
  return Array.isArray(carried)
    ? (carried as readonly DriveTraceEntry<M, C>[])
    : undefined;
}

/**
 * Drive `machine` from `initial` through `msg` against the REAL interpret
 * `handlers`, feeding every settle Msg back until the machine goes quiet, and
 * hand back the settled state together with the whole history.
 *
 * `handlers` is the same table a host hands `run` as its `interpret` (e.g.
 * a jev knob's `resilient_run` handler), so the test drives the real interpreter and
 * mocks only the port beneath it.
 *
 * One round is: fold every pending Msg, then await a handler for every Cmd
 * those folds emitted. A Msg a handler returns — or fires through its injected
 * `dispatch` — is pending for the next round. A machine that emits no Cmd for
 * its seed Msg therefore settles in ONE round and never awaits a handler at
 * all.
 *
 * The `ctx` handed to each handler is `opts.ctx` augmented with a NO-OP `emit`,
 * so a handler that emits to a `Port` runs without a live runtime; nothing here
 * observes ports. Supply your own `emit` on `ctx` to capture them.
 *
 * @throws {DriveRoundsExceededError} when the machine is still emitting work
 *   after `opts.maxRounds` rounds. It never returns a half-driven state.
 * @throws whatever a handler rejects with, unchanged — annotated with the
 *   partial trace, readable via {@link driveTraceOf}.
 */
export async function drive<
  S,
  M extends { type: string },
  C extends Cmd,
  U extends Sub,
  Ctx,
>(
  machine: Machine<S, M, C, U, Ctx>,
  initial: S,
  msg: M,
  handlers: Interpret<M, C, Ctx>,
  ...[opts]: Record<never, never> extends DriveOptions<Ctx>
    ? [opts?: DriveOptions<Ctx>]
    : [opts: DriveOptions<Ctx>]
): Promise<DriveResult<S, M, C>> {
  const options = (opts ?? {}) as {
    ctx?: Ctx;
    maxRounds?: number;
    clock?: () => number;
  };
  const maxRounds = options.maxRounds ?? DEFAULT_MAX_ROUNDS;
  const bound = bindMachine(machine, options.ctx as Ctx);

  // The `Cmd.define` edge `run` applies (ADR 0021): a defined Cmd's handler
  // returns an outcome, and the edge mints it into the def's `_ok` / `_err`
  // Msg. A hand-written Cmd's return passes through untouched.
  const settle = cmdEdgeOver(machine.cmds ?? [], options.clock ?? Date.now);

  // A handler's ctx is `Ctx & PortEmitter`, plus the `ok` / `err` builders and
  // the edge a defined Cmd's handler is handed. The Ctx half is the caller's;
  // the rest is the kernel's, and a driven test has no kernel — so a no-op
  // `emit` stands in, placed FIRST so a caller's own `emit` wins.
  const noopEmit: PortEmitter = { emit: () => {} };
  const handlerCtx = {
    ...noopEmit,
    ok: Outcome.ok,
    err: Outcome.err,
    [cmdEdge]: settle,
    ...(options.ctx as unknown as Record<string, unknown> | undefined),
  };

  // Indexed dynamically: `Interpret`'s mapped type already proved every Cmd
  // variant has a cell, but `cmd.type` is a union at the value level and TS
  // cannot correlate the two sides of that index.
  const cells = handlers as unknown as Record<
    string,
    | ((
        cmd: C,
        ctx: unknown,
        dispatch?: (msg: M) => void,
        // biome-ignore lint/suspicious/noConfusingVoidType: mirrors `Interpret`'s own cell return — follow-up Msgs, or nothing
      ) => Promise<M | readonly M[] | void>)
    | undefined
  >;

  const trace: DriveTraceEntry<M, C>[] = [];
  let state = initial;
  let pending: M[] = [msg];
  let round = 0;

  while (pending.length > 0) {
    round += 1;
    if (round > maxRounds) {
      throw new DriveRoundsExceededError<M, C>(maxRounds, round, trace);
    }

    // Drain the round's Msgs first, THEN its Cmds. Swapping the buffer before
    // the fold is what keeps a settle Msg out of the round that produced it —
    // the ordering question every hand-rolled copy of this loop re-answers.
    const folding = pending;
    pending = [];
    const emitted: C[] = [];
    for (const next of folding) {
      trace.push({ kind: "msg", msg: next });
      const [advanced, cmds] = bound.step(state, next);
      state = advanced;
      emitted.push(...cmds);
    }

    for (const cmd of emitted) {
      trace.push({ kind: "cmd", cmd });
      const cell = cells[cmd.type];
      if (cell === undefined) {
        throw new DriveNoHandlerError<M, C>(cmd.type, trace);
      }
      let settled: unknown;
      try {
        settled = settle(
          cmd,
          await cell(cmd, handlerCtx, (fired) => {
            pending.push(fired);
          }),
        );
      } catch (err) {
        // Unswallowed: the handler's own error is what leaves `drive`, so a
        // test's `instanceof` / `_tag` branch still lands. The trace rides on
        // a non-enumerable property (see `driveTraceOf`).
        if (typeof err === "object" && err !== null) {
          Object.defineProperty(err, TRACE_KEY, {
            value: [...trace],
            enumerable: false,
            configurable: true,
            writable: true,
          });
        }
        throw err;
      }
      // A returned list lands in order, as `run`'s loop enqueues it.
      pending.push(...followUps<M>(settled));
    }
  }

  return { state, trace };
}
