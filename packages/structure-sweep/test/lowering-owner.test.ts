import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { JevChoiceAnswer, JevState } from "@demlik/tea/jev";
import { describe, expect, it } from "vitest";
import {
  memoryArtifactStore,
  runStage,
  type StageArtifact,
} from "../src/lowering/artifact.js";
import type { ChoiceQuestions } from "../src/lowering/ask.js";
import { type Fact, sourceSpan } from "../src/lowering/fact.js";
import { type GateItem, gatePolicy } from "../src/lowering/gate.js";
import {
  type ClusterRecord,
  GROUP_CONFIRM_STAGE,
  GroupingGraph,
  ruleGroups,
} from "../src/lowering/group.js";
import { evaluate, loadGoldSet } from "../src/lowering/harness.js";
import { BRANCH_LABELS, branchLabelQuestion } from "../src/lowering/label.js";
import {
  askOwner,
  type LayerLookup,
  OWNER_REFS,
  type OwnerQuestionState,
  type OwnerRecord,
  type OwnerRef,
  ownerFacts,
  ownerInput,
  ownerQuestion,
  ownerQueue,
  ownerStage,
} from "../src/lowering/owner.js";
import { deriveRederived, REDERIVED } from "../src/lowering/rederived.js";
import { stubJev } from "./helpers.js";

// Every file, function, layer and gold item below is synthetic, written for these tests.

/** routes → services → rules: a higher rank is a lower layer. `lib/` is outside the stack. */
const layerOf: LayerLookup = (file) => {
  const [, top] = file.split("/");
  const rank = ["routes", "services", "rules"].indexOf(top ?? "");
  return rank < 0 ? null : { name: top as string, rank };
};

const fileOf = (id: string) => id.slice(0, id.lastIndexOf(":"));

/** A confirmed stage-6 artifact holding one rule group per entry, each member one branch. */
async function confirmedOf(
  groups: Readonly<Record<string, readonly string[]>>,
): Promise<StageArtifact<ClusterRecord>> {
  const facts = Object.entries(groups).map(
    ([name, functions]): Fact<ClusterRecord> => {
      const members = functions.map((fn, i) => ({
        branch: `${fn}@0`,
        function: fn,
        span: sourceSpan(fileOf(fn), 2 + i),
        atoms: [`v0.${name}`],
        outcome: "return false",
        bindings: [],
      }));
      const cluster = {
        id: `g-${name}`,
        basis: {
          _tag: "condition" as const,
          key: { atoms: [`v0.${name}`], outcome: "deny" },
        },
        members,
      };
      return {
        id: cluster.id,
        span: members[0]?.span ?? sourceSpan("src/x.ts", 1),
        value: {
          _tag: "known",
          value: {
            cluster,
            verdict: {
              _tag: "known",
              value: "same-rule",
              basis: {
                _tag: "promoted",
                confidence: 0.95,
                floor: 0.9,
                round: 0,
              },
            },
            answer: {
              label: "same-rule",
              confidence: 0.95,
              probabilities: {
                "same-rule": 0.95,
                "related-different": 0.03,
                unrelated: 0.02,
              },
            },
            rounds: 0,
          },
          basis: { _tag: "derived" },
        },
      };
    },
  );
  const run = await runStage(
    memoryArtifactStore<ClusterRecord>(),
    { name: GROUP_CONFIRM_STAGE, version: "test", run: async () => facts },
    { content: JSON.stringify(groups), artifacts: [] },
  );
  return run.artifact;
}

/** A `--graph` JSON: each function's callers, by id. */
const graphOf = (
  calledBy: Readonly<Record<string, readonly string[]>>,
): GroupingGraph =>
  GroupingGraph.parse({
    functions: Object.entries(calledBy).map(([id, callers]) => ({
      id,
      file: fileOf(id),
      edges: {
        calledBy: callers.map((callerId, line) => ({
          callerId,
          line: line + 1,
        })),
      },
    })),
  });

function ownerAnswer(
  ref: OwnerRef,
  confidence: number,
): JevChoiceAnswer<OwnerRef> {
  const rest = (1 - confidence) / (OWNER_REFS.length - 1);
  return {
    type: "choice",
    choice: ref,
    confidence,
    probabilities: Object.fromEntries(
      OWNER_REFS.map((r) => [r, r === ref ? confidence : rest]),
    ) as Record<OwnerRef, number>,
  };
}

const stubOwnerJev = (
  answer: (state: OwnerQuestionState) => JevChoiceAnswer<OwnerRef>,
) =>
  stubJev<ChoiceQuestions<OwnerRef>>((state: JevState) => ({
    verdict: answer(state as OwnerQuestionState),
  }));

const ownerGold = loadGoldSet(
  join(import.meta.dirname, "fixtures/lowering/owner.gold.json"),
  OWNER_REFS,
);

const goldOf = new Map(
  ownerGold.items.map((i) => [(i.state as OwnerQuestionState).group, i.gold]),
);

/** Stage 7's policy, from `calibrate` over the stage-7 gold set (through `evaluate`). */
async function stage7Policy() {
  const evaluation = await evaluate({
    question: ownerQuestion(),
    gold: ownerGold,
    connect: () =>
      stubOwnerJev((state) =>
        ownerAnswer(goldOf.get(state.group) ?? "c0", 0.95),
      ),
    thresholds: { ece: 0.2, flipRate: 0.1 },
    target: 0.9,
  });
  if (evaluation.calibration._tag !== "derived")
    throw new Error("expected a derived stage-7 floor");
  return gatePolicy({ calibration: evaluation.calibration, maxRounds: 1 });
}

async function owners(
  groups: Readonly<Record<string, readonly string[]>>,
  calledBy: Readonly<Record<string, readonly string[]>>,
  answer: (state: OwnerQuestionState) => JevChoiceAnswer<OwnerRef> = () =>
    ownerAnswer("c0", 0.95),
) {
  const jev = stubOwnerJev(answer);
  const policy = await stage7Policy();
  const options = {
    policy,
    ask: askOwner(jev),
    enrich: async (_item: GateItem, state: JevState) => state,
  };
  const confirmed = await confirmedOf(groups);
  const graph = graphOf(calledBy);
  const store = memoryArtifactStore<OwnerRecord>();
  const input = ownerInput(confirmed, { graph, layerOf, policy });
  const run = await runStage(store, ownerStage(options), input);
  const records = run.artifact.facts.flatMap((f) =>
    f.value._tag === "known" ? [f.value.value] : [],
  );
  return { jev, run, records, store, options, input, confirmed };
}

describe("the stage-7 gold set", () => {
  it("loads through loadGoldSet and scores through evaluate with a stubbed Jev", async () => {
    expect(ownerGold.items.length).toBeGreaterThanOrEqual(8);
    expect((await stage7Policy()).floor).toBeGreaterThan(0);
  });
});

describe("stage 7: owner selection", () => {
  it("settles by layer with no Jev call: the lowest layer every caller reaches", async () => {
    const { jev, records } = await owners(
      {
        cap: ["src/services/pay.ts:chargeCheck", "src/rules/pay.ts:canCharge"],
      },
      {
        "src/services/pay.ts:chargeCheck": ["src/routes/pay.ts:post"],
        "src/rules/pay.ts:canCharge": ["src/services/billing.ts:run"],
      },
    );
    expect(jev.asked).toHaveLength(0);
    const [record] = records;
    expect(record?.settledBy).toBe("layer");
    expect(record?.owner).toMatchObject({
      _tag: "known",
      value: { member: "src/rules/pay.ts:canCharge@0" },
      basis: { _tag: "derived" },
    });
  });

  it("breaks a layer tie by fan-in, with no Jev call", async () => {
    const { jev, records } = await owners(
      { cap: ["src/rules/a.ts:fromA", "src/rules/b.ts:fromB"] },
      {
        "src/rules/a.ts:fromA": [
          "src/services/x.ts:one",
          "src/services/x.ts:two",
          "src/services/y.ts:three",
        ],
        "src/rules/b.ts:fromB": ["src/services/z.ts:four"],
      },
    );
    expect(jev.asked).toHaveLength(0);
    const [record] = records;
    expect(record?.settledBy).toBe("fan-in");
    expect(record?.candidates.map((c) => [c.function, c.fanIn])).toEqual([
      ["src/rules/a.ts:fromA", 3],
      ["src/rules/b.ts:fromB", 1],
    ]);
    expect(record?.owner._tag === "known" && record.owner.value.function).toBe(
      "src/rules/a.ts:fromA",
    );
  });

  it("asks Jev through gateAll only on a tie fan-in does not break", async () => {
    const { jev, records } = await owners(
      { tie: ["src/rules/a.ts:fromA", "src/rules/b.ts:fromB"] },
      {
        "src/rules/a.ts:fromA": ["src/services/x.ts:one"],
        "src/rules/b.ts:fromB": ["src/services/y.ts:two"],
      },
      () => ownerAnswer("c1", 0.95),
    );
    expect(jev.asked).toHaveLength(1);
    const state = jev.asked[0] as OwnerQuestionState;
    expect(state.candidates.map((c) => c.function)).toEqual(["fromA", "fromB"]);
    const [record] = records;
    expect(record?.settledBy).toBe("jev");
    expect(record?.asked?.tied).toEqual([
      "src/rules/a.ts:fromA",
      "src/rules/b.ts:fromB",
    ]);
    expect(record?.owner).toMatchObject({
      _tag: "known",
      value: { function: "src/rules/b.ts:fromB" },
      basis: { _tag: "promoted", confidence: 0.95 },
    });
  });

  it("asks on a group with an unlayered member, and an abstained owner is unknown plus a queue entry", async () => {
    const { jev, run, records } = await owners(
      { loose: ["src/lib/util.ts:helper", "src/rules/b.ts:fromB"] },
      {
        "src/lib/util.ts:helper": [],
        "src/rules/b.ts:fromB": [],
      },
      () => ownerAnswer("c0", 0.1),
    );
    // Asked, then asked again once after enrichment, then abstained.
    expect(jev.asked).toHaveLength(2);
    const [record] = records;
    expect(record?.candidates.map((c) => c.layer)).toEqual([
      null,
      { name: "rules", rank: 2 },
    ]);
    expect(record?.owner).toEqual({ _tag: "unknown", reason: "abstained" });
    const [fact] = ownerFacts(run.artifact.facts);
    expect(fact?.value).toEqual({ _tag: "unknown", reason: "abstained" });
    const queue = ownerQueue(run.artifact.facts);
    expect(queue.entries).toHaveLength(1);
    expect(queue.entries[0]).toMatchObject({
      id: "g-loose",
      answer: { label: "c0", confidence: 0.1 },
      rounds: 1,
    });
  });

  it("leaves a group no caller reaches without an upward edge unknown, unasked", async () => {
    const { jev, records } = await owners(
      { up: ["src/routes/a.ts:fromA", "src/services/b.ts:fromB"] },
      {
        "src/routes/a.ts:fromA": ["src/rules/z.ts:deep"],
        "src/services/b.ts:fromB": [],
      },
    );
    expect(jev.asked).toHaveLength(0);
    expect(records[0]?.owner).toEqual({
      _tag: "unknown",
      reason: "undetermined",
    });
  });

  it("writes one fact per group: its id, the owner member and the owner's span", async () => {
    const { run } = await owners(
      {
        cap: ["src/services/pay.ts:chargeCheck", "src/rules/pay.ts:canCharge"],
      },
      {},
    );
    expect(ownerFacts(run.artifact.facts)).toEqual([
      {
        id: "g-cap",
        span: { file: "src/rules/pay.ts", startLine: 3, endLine: 3 },
        value: {
          _tag: "known",
          value: {
            group: "g-cap",
            member: "src/rules/pay.ts:canCharge@0",
            function: "src/rules/pay.ts:canCharge",
            span: { file: "src/rules/pay.ts", startLine: 3, endLine: 3 },
          },
          basis: { _tag: "derived" },
        },
      },
    ]);
  });

  it("answers a repeat run off the store with no Jev call", async () => {
    const { jev, store, options, input } = await owners(
      { tie: ["src/rules/a.ts:fromA", "src/rules/b.ts:fromB"] },
      {},
    );
    const asked = jev.asked.length;
    const again = await runStage(store, ownerStage(options), input);
    expect(again._tag).toBe("hit");
    expect(jev.asked).toHaveLength(asked);
  });
});

describe("rederived, derived", () => {
  it("marks non-owner members rederived, the owner not, and an unsettled group's members unknown", async () => {
    const { run, confirmed } = await owners(
      {
        cap: ["src/services/pay.ts:chargeCheck", "src/rules/pay.ts:canCharge"],
        loose: ["src/lib/util.ts:helper", "src/rules/b.ts:fromB"],
      },
      {},
      () => ownerAnswer("c0", 0.1),
    );
    const facts = deriveRederived(
      ruleGroups(confirmed.facts),
      ownerFacts(run.artifact.facts),
    );
    expect(facts.map((f) => [f.id, f.value])).toEqual([
      ["src/lib/util.ts:helper@0", { _tag: "unknown", reason: "undetermined" }],
      ["src/rules/b.ts:fromB@0", { _tag: "unknown", reason: "undetermined" }],
      [
        "src/rules/pay.ts:canCharge@0",
        { _tag: "known", value: false, basis: { _tag: "derived" } },
      ],
      [
        "src/services/pay.ts:chargeCheck@0",
        { _tag: "known", value: true, basis: { _tag: "derived" } },
      ],
    ]);
  });

  it("stays out of stage 5's question and gold set", () => {
    expect(BRANCH_LABELS).not.toContain(REDERIVED);
    expect(Object.keys(branchLabelQuestion().criteria)).not.toContain(
      REDERIVED,
    );
    expect(
      readFileSync(
        join(
          import.meta.dirname,
          "fixtures/lowering/branch-label-stage5.gold.json",
        ),
        "utf8",
      ),
    ).not.toMatch(/rederived/);
  });
});
