// ---------------------------------------------------------------------------
// The round loop both `drive`s run — `@demlik/tea/testing/promise` and
// `@demlik/tea/testing/effect` — said once, so the two cannot drift.
//
// `bindMachine` hands back the Cmds a fold emitted and stops there; performing
// them is the caller's. So every consumer test that exercises a Cmd-emitting
// machine hand-writes the same fixture: step the Msg, await the real interpret
// handler over each emitted Cmd, feed the settle Msg back, repeat until quiet,
// with a hand-picked guard bound in the loop header. `drive` is that fixture as
// one call, and this file is its loop. It composes `bindMachine`'s synchronous
// 2-arg `step` and adds NO second reducer path.
//
// What differs per engine is only how one Cmd is performed and whether Subs
// run, so an engine hands this loop a `cellFor` lookup and, optionally, a
// `subs` driver. Everything else — the rounds, the trace, the `maxRounds`
// bound, the `Cmd.define` edge and its dispatch check (#304) — is here.
//
// **It returns the history, not just the endpoint.** `{ state, trace }`, where
// `trace` is every Msg folded and every Cmd dispatched in order, lets a test
// assert on the SEQUENCE as well as the settled state, and the same trace's
// Msgs replayed through `replay` from the same initial state reproduce the
// returned state exactly.
//
// **Exhausting `maxRounds` fails the drive.** A driver that quietly returns a
// half-driven state lets a test assert green on a machine that never settled.
//
// Strengthens invariant 9 (the testing surface is named and small).
// ---------------------------------------------------------------------------

import {
  type AnyCmdDef,
  type Cmd,
  type CmdContract,
  cmdContractOver,
  desiredSub,
  followUps,
  type Machine,
  type Sub,
  subEntriesOf,
} from "../pure/core";
import type { CtxArg } from "../runtime-types";
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
 *   returned (or fired through its injected `dispatch`), or a Msg a running
 *   Sub emitted.
 * - `cmd` — a Cmd handed to an interpret handler. It is recorded BEFORE the
 *   handler runs, so a trace recovered from a failed handler names the Cmd
 *   that failed as its last entry.
 */
export type DriveTraceEntry<M, C> =
  | { readonly kind: "msg"; readonly msg: M }
  | { readonly kind: "cmd"; readonly cmd: C };

/** What a settled `drive` hands back. */
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
 * `drive`'s `ctx` field. `CtxArg` widened by exactly one case: a machine
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
 * The options both `drive`s take. `ctx` is conditionally optional (see
 * {@link DriveCtxArg}).
 */
export type DriveOptions<Ctx> = DriveCtxArg<Ctx> & {
  /**
   * The round bound. Exceeding it fails the drive with
   * {@link DriveRoundsExceededError}; `drive` never returns a half-driven
   * state. Defaults to {@link DEFAULT_MAX_ROUNDS} (100).
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
 * Raised when a Cmd reaches `drive` with no handler for its `type` in the
 * handler record. The record's mapped type makes that a compile error at a
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

/** The key `drive` hangs a partial trace off a failure under. */
const TRACE_KEY = "driveTrace";

/**
 * Hang `trace` off `err` on a non-enumerable property, so {@link driveTraceOf}
 * reads it back without changing how the error prints or serializes. A
 * non-object failure carries nothing.
 */
export function annotateTrace(err: unknown, trace: readonly unknown[]): void {
  if (typeof err !== "object" || err === null) return;
  Object.defineProperty(err, TRACE_KEY, {
    value: [...trace],
    enumerable: false,
    configurable: true,
    writable: true,
  });
}

/**
 * Read back the partial trace `drive` attached to an error a handler failed
 * with. Returns `undefined` for anything `drive` did not annotate.
 *
 * A failing handler's error leaves `drive` UNSWALLOWED — same value, same
 * `instanceof`, same `_tag` — so a test that already branches on the handler's
 * own error type keeps doing so. The trace rides along on a non-enumerable
 * property so it is recoverable without changing how the error prints or
 * serializes.
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

// === The loop ===

/**
 * Perform one Cmd and resolve with the handler's raw return, before the
 * `Cmd.define` edge reads it. The `dispatch` it is handed is already checked
 * (#304).
 */
export type DriveCell<M, C> = (
  cmd: C,
  dispatch: (msg: M) => void,
) => Promise<unknown>;

/** The Subs a drive runs, as the loop sees them. */
export interface DriveSubs<S, M> {
  /**
   * Start every Sub `state` wants that is not running, and stop every running
   * one it no longer wants — the engine's reconcile, after each fold.
   */
  readonly reconcile: (state: S) => void;
  /**
   * Wait for the next Msgs a running Sub emits. Resolves with every Msg
   * buffered by then, or with `undefined` once no Sub is left running; rejects
   * when a Sub failed.
   */
  readonly next: () => Promise<readonly M[] | undefined>;
  /** Stop every Sub still running. */
  readonly close: () => Promise<void>;
}

/** What one engine hands the shared loop. */
export interface DriveEngine<S, M, C> {
  /**
   * The edge and dispatch check over the machine's `Cmd.define` list. The
   * engine builds it (see {@link driveContractOf}) so a handler that settles
   * through `cmdEdgeOf(ctx)` mints into the same record the check reads.
   */
  readonly contract: CmdContract;
  /** The cell that performs a Cmd of `type`, or `undefined` when none does. */
  readonly cellFor: (type: string) => DriveCell<M, C> | undefined;
  /** The Subs to run beside the Cmds; an engine that runs none omits it. */
  readonly subs?: DriveSubs<S, M>;
}

/** The contract both `drive`s hold a machine's Cmds to (ADR 0021). */
export function driveContractOf(
  machine: { readonly cmds?: readonly AnyCmdDef[] },
  clock: () => number,
): CmdContract {
  return cmdContractOver(machine.cmds ?? [], clock);
}

/**
 * Drive `machine` from `initial` through `msg`, performing every emitted Cmd
 * through `engine.cellFor`, until the machine goes quiet.
 *
 * One round is: fold every pending Msg, then perform every Cmd those folds
 * emitted, in order. A Msg a cell returns or dispatches is pending for the next
 * round. When nothing is pending and Subs are running, the loop waits for the
 * next Msgs they emit; it settles once no Msg is pending, no Cmd is unperformed
 * and no Sub is left running.
 *
 * Every error that leaves the loop carries the partial trace (see
 * {@link driveTraceOf}).
 */
export async function driveLoop<
  S,
  M extends { type: string },
  C extends Cmd,
  U extends Sub,
  Ctx,
>(
  machine: Machine<S, M, C, U, Ctx>,
  initial: S,
  msg: M,
  ctx: Ctx,
  maxRounds: number,
  engine: DriveEngine<S, M, C>,
): Promise<DriveResult<S, M, C>> {
  const bound = bindMachine(machine, ctx);
  const { contract, cellFor, subs } = engine;

  const trace: DriveTraceEntry<M, C>[] = [];
  let state = initial;
  let pending: M[] = [msg];
  let round = 0;

  try {
    subs?.reconcile(state);
    while (pending.length > 0) {
      round += 1;
      if (round > maxRounds) {
        throw new DriveRoundsExceededError<M, C>(maxRounds, round, trace);
      }

      // Drain the round's Msgs first, THEN its Cmds. Swapping the buffer before
      // the fold is what keeps a settle Msg out of the round that produced it.
      const folding = pending;
      pending = [];
      const emitted: C[] = [];
      for (const next of folding) {
        trace.push({ kind: "msg", msg: next });
        const [advanced, cmds] = bound.step(state, next);
        state = advanced;
        emitted.push(...cmds);
        subs?.reconcile(state);
      }

      for (const cmd of emitted) {
        trace.push({ kind: "cmd", cmd });
        const cell = cellFor(cmd.type);
        if (cell === undefined) {
          throw new DriveNoHandlerError<M, C>(cmd.type, trace);
        }
        // The dispatch half of ADR 0021, as the engine applies it (#304): a
        // `Cmd.define`d handler may not send a `_ok` / `_err` it built itself.
        // That Msg is dropped, never folded, and the refusal fails the drive
        // once the cell settles, so a handler that catches it cannot hide it.
        let refused: { readonly error: unknown } | undefined;
        const dispatch = (fired: M): void => {
          try {
            contract.checkDispatch(cmd, fired);
          } catch (error) {
            refused ??= { error };
            return;
          }
          pending.push(fired);
        };
        const settled = contract.settle(cmd, await cell(cmd, dispatch));
        if (refused !== undefined) throw refused.error;
        // A returned list lands in order, as `run`'s loop enqueues it.
        pending.push(...followUps<M>(settled));
      }

      if (pending.length === 0 && subs !== undefined) {
        pending = [...((await subs.next()) ?? [])];
      }
    }
  } catch (err) {
    // Unswallowed: the failure's own value is what leaves the loop, so a
    // test's `instanceof` / `_tag` branch still lands.
    annotateTrace(err, trace);
    throw err;
  } finally {
    await subs?.close();
  }

  return { state, trace };
}

/** The Subs `machine` wants at `state`, keyed by the id the engines derive. */
export function desiredSubs<S>(
  machine: { readonly subs?: ReadonlyArray<unknown> },
  state: S,
): ReadonlyMap<string, Sub> {
  const desired = new Map<string, Sub>();
  for (const entry of subEntriesOf<S>(machine)) {
    const sub = desiredSub(entry, state);
    if (sub !== null) desired.set(sub.id, sub);
  }
  return desired;
}
