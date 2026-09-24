// ---------------------------------------------------------------------------
// `drive(machine, initial, msg, handlers, opts)` for the Promise engine: the
// runtime's own Cmd→handler→settle-Msg loop, said once, for a test.
//
// The loop is `../drive-loop.ts`, shared with the Effect `drive`. What this
// file adds is the Promise edge: each handler is awaited with the ctx `run`
// would hand it, and its `dispatch`. There is no `Runtime` here and no Sub is
// run; the only impure thing it does is `await` the handler the caller handed
// it.
//
// Prior art converged on the same answer: Temporal's `TestWorkflowEnvironment`
// hands a test the event history rather than the final result, and Effect's
// `TestClock` runs make the effect log inspectable rather than opaque.
// ---------------------------------------------------------------------------

import {
  type Cmd,
  type Interpret,
  type Machine,
  Outcome,
  type PortEmitter,
  type Sub,
} from "../../index";
import { cmdEdge } from "../../pure/core";
import {
  DEFAULT_MAX_ROUNDS,
  type DriveCell,
  type DriveOptions,
  type DriveResult,
  driveContractOf,
  driveLoop,
} from "../drive-loop";

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
 * all. Subs are not run.
 *
 * A `Cmd.define`d Cmd's handler is held to the engine's contract (ADR 0021):
 * its outcome is minted into `_ok` / `_err`, and a `_ok` / `_err` it builds and
 * dispatches itself is refused, failing the drive with `OutcomeContractError`
 * exactly where `run` would report it (#304). A settle it minted through
 * `cmdEdgeOf(ctx)` passes.
 *
 * The `ctx` handed to each handler is `opts.ctx` augmented with a NO-OP `emit`,
 * so a handler that emits to a `Port` runs without a live runtime; nothing here
 * observes ports. Supply your own `emit` on `ctx` to capture them.
 *
 * @throws {DriveRoundsExceededError} when the machine is still emitting work
 *   after `opts.maxRounds` rounds. It never returns a half-driven state.
 * @throws whatever a handler rejects with, unchanged — annotated with the
 *   partial trace, readable via `driveTraceOf`.
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
  const contract = driveContractOf(machine, options.clock ?? Date.now);

  // A handler's ctx is `Ctx & PortEmitter`, plus the `ok` / `err` builders and
  // the edge a defined Cmd's handler is handed. The Ctx half is the caller's;
  // the rest is the kernel's, and a driven test has no kernel — so a no-op
  // `emit` stands in, placed FIRST so a caller's own `emit` wins.
  const noopEmit: PortEmitter = { emit: () => {} };
  const handlerCtx = {
    ...noopEmit,
    ok: Outcome.ok,
    err: Outcome.err,
    [cmdEdge]: contract.settle,
    ...(options.ctx as unknown as Record<string, unknown> | undefined),
  };

  // Indexed dynamically: `Interpret`'s mapped type already proved every Cmd
  // variant has a cell, but `cmd.type` is a union at the value level and TS
  // cannot correlate the two sides of that index.
  const cells = handlers as unknown as Record<
    string,
    | ((cmd: C, ctx: unknown, dispatch: (msg: M) => void) => Promise<unknown>)
    | undefined
  >;
  const cellFor = (type: string): DriveCell<M, C> | undefined => {
    const cell = cells[type];
    return cell && ((cmd, dispatch) => cell(cmd, handlerCtx, dispatch));
  };

  return driveLoop(
    machine,
    initial,
    msg,
    options.ctx as Ctx,
    options.maxRounds ?? DEFAULT_MAX_ROUNDS,
    { contract, cellFor },
  );
}
