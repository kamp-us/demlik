import type { JevState } from "@demlik/tea/jev";
import { describe, expect, it } from "vitest";
import { askVerdict } from "../src/lowering/ask.js";
import { type Fact, sourceSpan } from "../src/lowering/fact.js";
import {
  decide,
  type GateItem,
  gate,
  gateAll,
  gatePolicy,
} from "../src/lowering/gate.js";
import {
  type Branch,
  idOf,
  stubBranchJev,
  verdict,
} from "./lowering-fixture.js";

const policy = gatePolicy({ floor: 0.8, maxRounds: 2 });

const item = (id: string, line: number): GateItem => ({
  id,
  span: sourceSpan(`src/${id}.ts`, line, line + 2),
  state: { id, rounds: 0 },
});

const roundsOf = (state: JevState) =>
  (state as { readonly rounds: number }).rounds;

/** Enrichment that records each call and counts rounds into the state it hands back. */
function countingEnrich() {
  const calls: number[] = [];
  const enrich = async (
    _item: GateItem,
    state: JevState,
    retrying: { readonly round: number },
  ) => {
    calls.push(retrying.round);
    return { ...(state as object), rounds: roundsOf(state) + 1 };
  };
  return Object.assign(enrich, { calls });
}

/** How a downstream stage reads one fact: the label, or `unknown` — never a guess. */
const read = (fact: Fact<Branch>): Branch | "unknown" =>
  fact.value._tag === "known" ? fact.value.value : "unknown";

describe("decide", () => {
  it("promotes at or above the floor", () => {
    expect(decide(policy, 0, { label: "gate", confidence: 0.8 })).toEqual({
      _tag: "promoted",
      judgement: { label: "gate", confidence: 0.8 },
      round: 0,
    });
  });

  it("retries below the floor with the round about to run, then abstains after maxRounds", () => {
    const low = { label: "gate", confidence: 0.5 } as const;
    expect(decide(policy, 0, low)).toMatchObject({
      _tag: "retrying",
      round: 1,
    });
    expect(decide(policy, 1, low)).toMatchObject({
      _tag: "retrying",
      round: 2,
    });
    expect(decide(policy, 2, low)).toEqual({
      _tag: "abstained",
      judgement: low,
      rounds: 2,
    });
  });

  it("refuses a policy the gate could not apply", () => {
    expect(() => gatePolicy({ floor: 1.5, maxRounds: 1 })).toThrow(RangeError);
    expect(() => gatePolicy({ floor: 0.8, maxRounds: -1 })).toThrow(RangeError);
    expect(() => gatePolicy({ floor: 0.8, maxRounds: 1.5 })).toThrow(
      RangeError,
    );
  });
});

describe("gate", () => {
  it("promotes a confident first answer without enriching", async () => {
    const jev = stubBranchJev(() => verdict("gate", 0.92));
    const enrich = countingEnrich();
    const settled = await gate(item("a", 1), {
      policy,
      ask: askVerdict(jev),
      enrich,
    });
    expect(settled).toMatchObject({ _tag: "promoted", round: 0 });
    expect(enrich.calls).toEqual([]);
    expect(jev.asked).toHaveLength(1);
  });

  it("enriches a below-floor item and asks again with the enriched state", async () => {
    const jev = stubBranchJev((state) =>
      verdict("gate", roundsOf(state) === 0 ? 0.6 : 0.85),
    );
    const enrich = countingEnrich();
    const settled = await gate(item("a", 1), {
      policy,
      ask: askVerdict(jev),
      enrich,
    });
    expect(settled).toEqual({
      _tag: "promoted",
      judgement: { label: "gate", confidence: 0.85 },
      round: 1,
    });
    expect(enrich.calls).toEqual([1]);
    expect(jev.asked.map(roundsOf)).toEqual([0, 1]);
  });

  it("abstains after maxRounds enrichments, asking 1 + maxRounds times", async () => {
    const jev = stubBranchJev(() => verdict("plumbing", 0.55));
    const enrich = countingEnrich();
    const settled = await gate(item("a", 1), {
      policy,
      ask: askVerdict(jev),
      enrich,
    });
    expect(settled).toEqual({
      _tag: "abstained",
      judgement: { label: "plumbing", confidence: 0.55 },
      rounds: 2,
    });
    expect(enrich.calls).toEqual([1, 2]);
    expect(jev.asked).toHaveLength(3);
  });
});

describe("gateAll", () => {
  it("writes abstained items to the human queue with span and final answer, and they read as unknown downstream", async () => {
    // a is confident, b clears the floor after one enrichment, c never does.
    const jev = stubBranchJev((state) => {
      const id = idOf(state);
      if (id === "a") return verdict("gate", 0.95);
      if (id === "b") return verdict("gate", roundsOf(state) > 0 ? 0.81 : 0.4);
      return verdict("plumbing", 0.5 + roundsOf(state) * 0.1);
    });
    const items = [item("a", 1), item("b", 10), item("c", 20)];
    const { facts, queue } = await gateAll("branch-label", items, {
      policy,
      ask: askVerdict(jev),
      enrich: countingEnrich(),
    });

    expect(queue).toEqual({
      stage: "branch-label",
      floor: 0.8,
      entries: [
        {
          id: "c",
          span: { file: "src/c.ts", startLine: 20, endLine: 22 },
          answer: { label: "plumbing", confidence: 0.7 },
          rounds: 2,
        },
      ],
    });
    expect(facts.map(read)).toEqual(["gate", "gate", "unknown"]);
    expect(facts[2]).toEqual({
      id: "c",
      span: { file: "src/c.ts", startLine: 20, endLine: 22 },
      value: { _tag: "unknown", reason: "abstained" },
    });
    expect(facts[1]?.value).toEqual({
      _tag: "known",
      value: "gate",
      basis: { _tag: "promoted", confidence: 0.81, floor: 0.8, round: 1 },
    });
  });
});
