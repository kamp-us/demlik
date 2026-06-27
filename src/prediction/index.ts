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
 */

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
