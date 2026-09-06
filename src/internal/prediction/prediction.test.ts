import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  type Ack,
  type AckPartition,
  ack,
  initAck,
  NO_ACK,
  nextSeq,
  partitionByAck,
  type Seq,
  type SeqTagged,
  tagSeq,
} from "./index";

// A predicted client command is whatever the consumer threads through its Msg;
// here a tiny move payload stands in for it — the primitive is value-agnostic.
type Move = { readonly dx: number; readonly dy: number };
const move = (dx: number, dy: number): Move => ({ dx, dy });

const arbTagged = (): fc.Arbitrary<SeqTagged<Move>> =>
  fc.record({
    seq: fc.nat(),
    value: fc.record({ dx: fc.integer(), dy: fc.integer() }),
  });

describe("tagSeq / SeqTagged", () => {
  it("tags a command with its sequence number", () => {
    const tagged: SeqTagged<Move> = tagSeq(7, move(1, 0));
    expect(tagged.seq).toBe(7);
    expect(tagged.value).toEqual(move(1, 0));
  });
});

describe("ack", () => {
  it("represents the authoritative last-applied-seq", () => {
    const a: Ack = ack(42);
    expect(a.lastAppliedSeq).toBe(42);
  });
});

describe('NO_ACK / initAck — the "nothing applied yet" sentinel', () => {
  it("is -1, strictly below the 0-based seq nextSeq mints for an empty buffer", () => {
    // The seam invariant: seqs start at 0, the ack is inclusive, so the
    // pre-first cursor MUST sit below 0. This pins the exact value.
    expect(NO_ACK).toBe(-1);
    expect(NO_ACK).toBeLessThan(nextSeq<Move>([]));
  });

  it("initAck() is the Ack form of NO_ACK", () => {
    expect(initAck()).toEqual(ack(NO_ACK));
    expect(initAck().lastAppliedSeq).toBe(NO_ACK);
  });

  it("leaves a seq-0 item PENDING — acks nothing against the sentinel (deterministic boundary)", () => {
    // Deterministic counterpart to the stochastic `deliver == 0` fast-check
    // draw: a fresh buffer whose lowest seq is 0 partitions ENTIRELY as pending
    // against NO_ACK. If the sentinel were 0, the inclusive `<=` would falsely
    // ack the seq-0 input before the server ever saw it.
    const buffer: readonly SeqTagged<Move>[] = [tagSeq(0, move(1, 0))];
    const { acked, pending } = partitionByAck(buffer, NO_ACK);
    expect(acked).toEqual([]);
    expect(pending.map((t) => t.seq)).toEqual([0]);
  });

  it("partitions equivalently whether passed the NO_ACK Seq or the initAck() Ack", () => {
    const buffer: readonly SeqTagged<Move>[] = [
      tagSeq(0, move(1, 0)),
      tagSeq(1, move(0, 1)),
    ];
    expect(partitionByAck(buffer, NO_ACK)).toEqual(
      partitionByAck(buffer, initAck()),
    );
  });
});

describe("partitionByAck", () => {
  const buf: readonly SeqTagged<Move>[] = [
    tagSeq(1, move(1, 0)),
    tagSeq(2, move(0, 1)),
    tagSeq(3, move(-1, 0)),
    tagSeq(4, move(0, -1)),
  ];

  it("partitions acked (seq <= lastAppliedSeq) from pending (seq > lastAppliedSeq)", () => {
    const { acked, pending } = partitionByAck(buf, ack(2));
    expect(acked.map((t) => t.seq)).toEqual([1, 2]);
    expect(pending.map((t) => t.seq)).toEqual([3, 4]);
  });

  it("treats the boundary seq == lastAppliedSeq as ACKED (inclusive <=)", () => {
    const { acked, pending } = partitionByAck(buf, ack(3));
    expect(acked.map((t) => t.seq)).toContain(3);
    expect(pending.map((t) => t.seq)).not.toContain(3);
  });

  it("accepts a bare lastAppliedSeq number equivalently to an Ack", () => {
    expect(partitionByAck(buf, 2)).toEqual(partitionByAck(buf, ack(2)));
  });

  it("handles an empty buffer — both buckets empty", () => {
    const { acked, pending } = partitionByAck<Move>([], ack(99));
    expect(acked).toEqual([]);
    expect(pending).toEqual([]);
  });

  it("acks nothing when lastAppliedSeq is below every seq", () => {
    const { acked, pending } = partitionByAck(buf, ack(0));
    expect(acked).toEqual([]);
    expect(pending).toHaveLength(4);
  });

  it("acks everything when lastAppliedSeq is at or above every seq", () => {
    const { acked, pending } = partitionByAck(buf, ack(4));
    expect(acked).toHaveLength(4);
    expect(pending).toEqual([]);
  });

  it("partitions out-of-order seqs by value, not buffer position, preserving input order per bucket", () => {
    const scrambled: readonly SeqTagged<Move>[] = [
      tagSeq(4, move(0, -1)),
      tagSeq(1, move(1, 0)),
      tagSeq(3, move(-1, 0)),
      tagSeq(2, move(0, 1)),
    ];
    const { acked, pending } = partitionByAck(scrambled, ack(2));
    // order within each bucket follows the input buffer, not seq order
    expect(acked.map((t) => t.seq)).toEqual([1, 2]);
    expect(pending.map((t) => t.seq)).toEqual([4, 3]);
  });

  it("routes duplicate seqs by the same boundary rule (both copies land together)", () => {
    const dupes: readonly SeqTagged<Move>[] = [
      tagSeq(2, move(1, 0)),
      tagSeq(2, move(2, 0)),
      tagSeq(3, move(3, 0)),
      tagSeq(3, move(4, 0)),
    ];
    const { acked, pending } = partitionByAck(dupes, ack(2));
    expect(acked.map((t) => t.value.dx)).toEqual([1, 2]); // both seq==2 acked
    expect(pending.map((t) => t.value.dx)).toEqual([3, 4]); // both seq==3 pending
  });

  it("property: every item lands in exactly one bucket, split on seq <= lastAppliedSeq", () => {
    fc.assert(
      fc.property(fc.array(arbTagged()), fc.nat(), (buffer, last) => {
        const { acked, pending } = partitionByAck(buffer, last);
        // total partition — no loss, no duplication
        expect(acked.length + pending.length).toBe(buffer.length);
        // the defining boundary holds on both sides
        expect(acked.every((t) => t.seq <= last)).toBe(true);
        expect(pending.every((t) => t.seq > last)).toBe(true);
        // concatenating the buckets reproduces the kept items in input order
        const reassembled = [...acked, ...pending];
        const expected = [
          ...buffer.filter((t) => t.seq <= last),
          ...buffer.filter((t) => t.seq > last),
        ];
        expect(reassembled).toEqual(expected);
      }),
    );
  });
});

describe("nextSeq", () => {
  it("starts at 0 for an empty buffer", () => {
    expect(nextSeq<Move>([])).toBe(0);
  });

  it("returns one past the highest seq, regardless of buffer order", () => {
    const scrambled: readonly SeqTagged<Move>[] = [
      tagSeq(3, move(0, 0)),
      tagSeq(7, move(0, 0)),
      tagSeq(1, move(0, 0)),
    ];
    expect(nextSeq(scrambled)).toBe(8);
  });

  it("property: the minted seq is strictly greater than every seq in the buffer", () => {
    fc.assert(
      fc.property(fc.array(arbTagged()), (buffer) => {
        const next = nextSeq(buffer);
        expect(buffer.every((t) => next > t.seq)).toBe(true);
      }),
    );
  });
});

// Type-level guard (compiled, not run): the partition result is parameterized
// by the command type and stays a SeqTagged buffer on both sides.
const _typecheck = (p: AckPartition<Move>): Seq =>
  p.acked.length + p.pending.length;
void _typecheck;
