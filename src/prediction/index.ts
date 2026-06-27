/**
 * @demlik/tea/prediction — the client-prediction ack primitive (epic #186, facet 2).
 *
 * The contract the Gambetta/Valve authoritative-server netcode loop needs:
 * **command-seq-in → last-applied-seq-out.** A client tags each predicted
 * command/`Msg` with a monotonic `seq`; the authoritative side replies with the
 * `lastAppliedSeq` it has processed. `partitionByAck` then splits the client's
 * pending buffer into the inputs the server has ACKED (`seq <= lastAppliedSeq`)
 * and those still PENDING (`seq > lastAppliedSeq`) — the un-acked tail the
 * reconciliation pass (#214) replays over the authoritative snapshot via
 * `foldMsgs` (#211, `@demlik/tea/pure`).
 *
 * Deliberately **Model-shape-agnostic** (ADR 0006): the ack is a standalone
 * value, NOT a field this module requires on the consumer's `State`. It
 * generalizes the `lastAckedSeq`-on-the-Model + `seq`-threaded-through-the-Msg
 * pattern vortex hand-rolled (epic #186). It is a LEAF module — pure and
 * runtime-free, importing nothing from the tea core or host, so it can never
 * drag `run`/the host into a client bundle.
 *
 * This is the read/ack side of the primitive; `tagSeq`/`nextSeq` are the write
 * side, letting a client mint monotonic seqs from its pending buffer alone —
 * again with no counter field on the Model.
 *
 * `reconcile` (the read side's payoff, #214) composes this ack partition with
 * the pure fold seam `foldMsgs` (#211) to perform the whole Gambetta/Valve
 * reconciliation step in one call. The `foldMsgs` import is the ONLY dependency
 * this leaf takes, and it reaches into the pure-core leaf (`../pure/core`) — NOT
 * the runtime root — so the module stays runtime-free and the `@demlik/tea/pure`
 * import-graph guard (ADR 0006, #213) still holds.
 */

import type { Cmd, Machine, Sub } from "../pure/core";
import { foldMsgs } from "../pure/core";

/**
 * A monotonic, non-negative sequence number tagging one client-predicted
 * command. Monotonicity is the client's contract (mint successive seqs with
 * `nextSeq`); this module only ever *compares* seqs.
 */
export type Seq = number;

/** A command (or `Msg`) tagged with the `seq` the client assigned it. */
export interface SeqTagged<T> {
  readonly seq: Seq;
  readonly value: T;
}

/** Tag a command/`Msg` with its sequence number. */
export const tagSeq = <T>(seq: Seq, value: T): SeqTagged<T> => ({ seq, value });

/**
 * The authoritative side's acknowledgement: the highest `seq` it has applied.
 * Everything with `seq <= lastAppliedSeq` is settled; everything above is still
 * in flight. This *is* the whole "ack from the authoritative side" — a value
 * the consumer carries however it likes (a wire field, a message payload),
 * never a shape this module imposes on the Model.
 */
export interface Ack {
  readonly lastAppliedSeq: Seq;
}

/** Construct an `Ack` for a last-applied sequence number. */
export const ack = (lastAppliedSeq: Seq): Ack => ({ lastAppliedSeq });

/** The result of splitting a seq-tagged buffer against an ack. */
export interface AckPartition<T> {
  /** Inputs the authoritative side has applied (`seq <= lastAppliedSeq`). */
  readonly acked: readonly SeqTagged<T>[];
  /** Inputs still in flight / un-acked (`seq > lastAppliedSeq`) — the replay tail. */
  readonly pending: readonly SeqTagged<T>[];
}

/**
 * Partition a buffer of seq-tagged commands into ACKED and PENDING against the
 * authoritative `lastAppliedSeq`. Pure and total: every item lands in exactly
 * one bucket, input order is preserved within each bucket, and the boundary
 * `seq == lastAppliedSeq` is ACKED (inclusive `<=`). Routing is by `seq` value,
 * not buffer position, so an out-of-order or duplicate-seq buffer partitions
 * correctly. Accepts either an {@link Ack} or a bare `lastAppliedSeq` number, so
 * a caller passes whichever it holds.
 */
export const partitionByAck = <T>(
  buffer: readonly SeqTagged<T>[],
  ackOrSeq: Ack | Seq,
): AckPartition<T> => {
  const lastAppliedSeq =
    typeof ackOrSeq === "number" ? ackOrSeq : ackOrSeq.lastAppliedSeq;
  const acked: SeqTagged<T>[] = [];
  const pending: SeqTagged<T>[] = [];
  for (const item of buffer) {
    if (item.seq <= lastAppliedSeq) {
      acked.push(item);
    } else {
      pending.push(item);
    }
  }
  return { acked, pending };
};

/**
 * The next sequence number to assign: one past the highest `seq` in the buffer,
 * or `0` for an empty buffer. Lets a client mint monotonic seqs from its pending
 * buffer alone — no counter field on the Model — and is tolerant of an unordered
 * buffer (it takes the max, not the last element).
 */
export const nextSeq = <T>(buffer: readonly SeqTagged<T>[]): Seq =>
  buffer.reduce((max, item) => (item.seq > max ? item.seq : max), -1) + 1;

/**
 * The client prediction/reconciliation helper — the Gambetta/Valve
 * authoritative-server loop's reconcile step, generalized (#214, epic #186).
 *
 * Given the latest `authoritativeState` from the server, the server's
 * `lastAppliedSeq` ack, and the client's `pending` buffer of seq-tagged inputs,
 * it returns the corrected predicted state: drop the inputs the server has
 * already applied (`seq <= lastAppliedSeq`) and replay ONLY the un-acked tail
 * (`seq > lastAppliedSeq`) over the authoritative snapshot.
 *
 * It is **composed, not re-derived** (ADR 0006): the drop is {@link partitionByAck}
 * (the ack primitive, #212) and the replay is `foldMsgs` (the pure fold seam,
 * #211) — there is no second copy of the partition logic and no second copy of
 * the fold. `lastAppliedSeq` accepts either an {@link Ack} or a bare `Seq`, so a
 * caller passes whichever it holds, matching `partitionByAck`.
 *
 * Pure and host-agnostic: it takes the `machine` (which `foldMsgs` needs to
 * dispatch `update`) but touches no `Store`, `interpret`, or subscription, and
 * imports nothing from the runtime — so it ships on `@demlik/tea/prediction`
 * and the client-safe `@demlik/tea/pure` umbrella without dragging `run` into a
 * client bundle.
 */
export function reconcile<
  S,
  M extends { type: string },
  C extends Cmd,
  U extends Sub,
  Ctx,
>(
  machine: Machine<S, M, C, U, Ctx>,
  authoritativeState: S,
  lastAppliedSeq: Ack | Seq,
  pending: readonly SeqTagged<M>[],
): S {
  const { pending: unacked } = partitionByAck(pending, lastAppliedSeq);
  return foldMsgs(
    machine,
    authoritativeState,
    unacked.map((tagged) => tagged.value),
  );
}
