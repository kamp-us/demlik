/**
 * Cold-wake resume — the boot/hibernation re-fire path: the generalized
 * `bootResume` port, its agent specialization `autoBoot`, and the wake-time
 * re-emit of surviving tool round-trips. See `./host` for the transport-model
 * rationale.
 */

import {
  type AgentMachineMsg,
  type AgentState,
  agentBootMsg,
  status,
} from "../agent/index";
import type { BootingRuntime } from "../index";
import type { DurableCommandCarrier } from "./deferred-gateway";

// ─────────────────────────────────────────────────────────────────────────────
// bootResume + agentIsResumable + autoBoot — cold-wake resume on rehydrate (seam B).
//
// A run that loaded from storage mid-loop must re-fire its one outstanding
// effect. `bootResume` is the GENERALIZED helper (issue #231): after
// `runtime.ready`, it derives a single resume Msg from the rehydrated State via
// a caller-supplied `ResumePort` and dispatches it exactly once — a no-op on a
// fresh DO. `autoBoot` is the AGENT specialization of it (the `agentIsResumable`
// predicate + the `agentBootMsg` typed port, issue #60), so no divergent second
// resume pattern is left standing.
//
// It leans on the init-purity contract (Invariant 2, enforced by `replay` in
// `../index`): `init(loaded)` returns ZERO Cmds on rehydrate, so effects never
// re-fire from boot — `bootResume`, NOT `init`, is the boot-effect hook. See
// `.patterns/tea-do/recovery.md`.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The typed cold-wake resume port `bootResume` fires through — the agent's
 * `AgentBootPort` (issue #60) generalized to any DO-hosted machine (issue #231).
 *
 * - `isResumable(state)` — true iff the rehydrated State is mid-loop and needs a
 *   resume dispatch. False on a fresh boot, which makes `bootResume` a no-op.
 * - `resumeMsg(now)` — the TYPED constructor for the single resume Msg (never a
 *   hand-built `{ type: … }` literal); the `agentBootMsg` shape lifted out so a
 *   non-agent grain supplies its own boot Msg constructor.
 */
export interface ResumePort<S, M extends { type: string }> {
  readonly isResumable: (state: S) => boolean;
  readonly resumeMsg: (now: number) => M;
}

/**
 * After `runtime.ready`, derive the single resume Msg from the rehydrated State
 * via `port` and dispatch it exactly once — the generalized AgentBoot. On a
 * fresh (non-rehydrated) machine `port.isResumable` is false and this is a
 * no-op. Call once right after building the runtime; it standardizes the
 * hand-written `if (isResumable(state)) await runtime.dispatch(bootMsg(now()))`
 * every DO-hosted machine otherwise re-derives.
 *
 * `await ready` is the single boot gate (issue #45): `getState()` is total only
 * on the booted `Runtime`, so state cannot be inspected before boot populates
 * it. `now` is injected (the sole boot clock read) so a test can pin it.
 */
export async function bootResume<
  S,
  M extends { type: string },
  E extends { type: string } = never,
>(
  booting: BootingRuntime<S, M, E>,
  port: ResumePort<S, M>,
  now: () => number = Date.now,
): Promise<void> {
  const runtime = await booting.ready;
  if (port.isResumable(runtime.getState())) {
    await runtime.dispatch(port.resumeMsg(now()));
  }
}

/**
 * True iff an agent slice loaded from storage is mid-loop (running + awaiting
 * tools) — the resumable case `agent_boot` re-fires.
 *
 * The resumability question IS "is the run suspended on tools?" — so this
 * delegates to the agent's own typed `status` channel (issue #49) rather than
 * re-deriving the private `run.phase` / `conversation.awaiting` shape by hand.
 * The host no longer leaks the agent's internal slice structure; a change to
 * `Awaiting` surfaces as a compile error in `status`, not a silent break here.
 */
export function agentIsResumable<
  Stage,
  P extends string,
  O extends Record<P, unknown>,
  R,
>(state: AgentState<Stage, P, O, R>): boolean {
  return status(state).kind === "suspended";
}

/**
 * The AGENT specialization of {@link bootResume} (issue #231): after
 * `runtime.ready`, self-dispatch `agent_boot` iff the rehydrated slice is
 * resumable, a no-op on a fresh DO. Wires the agent slice's `agentIsResumable`
 * predicate + the agent-owned `agentBootMsg` typed port (issue #60) into the
 * generalized helper, so the resume dispatch lives in ONE place — see
 * `bootResume`'s docblock for the boot-gate / init-purity rationale.
 *
 * `now` is injected (the host's only clock read for boot) so a test can pin it.
 */
export async function autoBoot<
  Stage,
  P extends string,
  O extends Record<P, unknown>,
  R,
  E extends { type: string } = never,
>(
  booting: BootingRuntime<
    AgentState<Stage, P, O, R>,
    AgentMachineMsg<P, O, R>,
    E
  >,
  now: () => number = Date.now,
): Promise<void> {
  await bootResume(
    booting,
    { isResumable: agentIsResumable, resumeMsg: agentBootMsg },
    now,
  );
}

/**
 * RE-EMIT ON ACTIVATION (the #91 wake path). Given a durable carrier whose
 * recorder was rehydrated from the persisted ledger events (e.g.
 * `durableCommandCarrier(deferredGateway(), pendingEffectsLedger({ events }),
 * …)` on a wake), re-fire every owed-but-unconfirmed round-trip via
 * `reissue(callId)` — the consumer's "re-send the command frame for this
 * `callId`" callback. The survivors are read straight off the carrier's own
 * recorder (`recorder.surviving()`), which folded the restore log at
 * construction — the carrier is the single source of the in-flight set, so the
 * caller does not re-fold the log here.
 *
 * Idempotent by construction:
 *   - the ledger's monotonic `deliveryId` is the dedup key the RECEIVER uses, so
 *     a late/duplicate reply for an already-resolved round-trip is absorbed
 *     (at-least-once delivery — see `survivingEffects`);
 *   - re-issuing the SAME survivor twice within one activation re-sends once —
 *     if `reissue` routes through the carrier's `await`, the gateway returns the
 *     open Promise for an in-flight `callId` without re-firing `send`.
 *
 * Returns the `callId`s re-emitted (oldest-first by id) — the host can log /
 * assert the re-emit set. On a fresh or fully-confirmed carrier this is empty
 * (nothing re-fired).
 *
 * Call this once, right after the runtime's boot gate resolves (alongside
 * {@link autoBoot}): `autoBoot` re-fires the agent's own `agent_boot`;
 * `reissueSurvivingEffects` re-fires the in-flight TOOL round-trips. Together
 * they restore a suspended run's full in-flight state after a wake.
 */
export function reissueSurvivingEffects<R>(
  carrier: DurableCommandCarrier<R>,
  reissue: (callId: string) => void,
): readonly string[] {
  const reemitted: string[] = [];
  for (const { effect } of carrier.recorder.surviving()) {
    reissue(effect.callId);
    reemitted.push(effect.callId);
  }
  return reemitted;
}
