import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  JevAnswer,
  JevOk,
  JevQuestionMap,
  JevState,
} from "@demlik/tea/jev";
import { describe, expect, it } from "vitest";
import {
  memoryArtifactStore,
  runStage,
  type StageArtifact,
} from "../src/lowering/artifact.js";
import { gatePolicy } from "../src/lowering/gate.js";
import { evaluate, loadGoldSet } from "../src/lowering/harness.js";
import {
  askBranchLabel,
  BRANCH_LABEL_CRITERIA,
  BRANCH_LABELS,
  type BranchJudgement,
  type BranchLabel,
  type BranchLabelState,
  branchLabeller,
  branchLabelQuestion,
  branchLabelQuestions,
  type Connect,
  evaluateAnchoring,
  evidenceFirst,
  labelBranches,
} from "../src/lowering/label.js";
import {
  parseLexicon,
  type ResolvedBranch,
  resolveInput,
  resolveStage,
} from "../src/lowering/lexicon.js";
import {
  type LoweredBranch,
  type LoweringGraph,
  loweringInput,
  lowerStage,
} from "../src/lowering/lower.js";
import {
  type FunctionSummary,
  type LabelRequest,
  summarize,
} from "../src/lowering/summarize.js";
import { graphOf, lineOf } from "./lowering-lower-fixture.js";

// Every source, state and gold item below is synthetic, written for these tests.

const goldFile = join(
  import.meta.dirname,
  "fixtures/lowering/branch-label-stage5.gold.json",
);
const gold = loadGoldSet(goldFile, BRANCH_LABELS);
const goldOf = new Map(
  gold.items.map((item) => [
    (item.state as BranchLabelState).branch,
    item.gold,
  ]),
);

interface Decision {
  readonly label: BranchLabel;
  readonly confidence: number;
  /** The refs (`a0`, …, `outcome`) the answer rests on. */
  readonly rests: readonly string[];
}

/** A stub Jev over a whole question map: `decide` sees the state and the map it was asked. */
function stubConnect(
  decide: (state: JevState, questions: JevQuestionMap) => Decision,
) {
  const asked: {
    readonly state: JevState;
    readonly questions: JevQuestionMap;
  }[] = [];
  const connect: Connect = (questions) => async (state) => {
    asked.push({ state, questions });
    const decision = decide(state, questions);
    const answers: Record<string, JevAnswer> = {};
    for (const key of Object.keys(questions)) {
      if (key === "verdict")
        answers[key] = {
          type: "choice",
          choice: decision.label,
          confidence: decision.confidence,
          probabilities: Object.fromEntries(
            BRANCH_LABELS.map((l) => [
              l,
              l === decision.label
                ? decision.confidence
                : (1 - decision.confidence) / 3,
            ]),
          ),
        };
      else
        answers[key] = {
          type: "noul",
          noul: decision.rests.includes(key.slice("evidence.".length))
            ? 0.9
            : 0.1,
        };
    }
    return {
      answers,
      model: "jev-stub",
      usage: { input_tokens: 10, output_tokens: 1 },
      source: "port",
    } as JevOk<JevQuestionMap>;
  };
  return Object.assign(connect, { asked });
}

const branchOf = (state: JevState) => (state as BranchLabelState).branch;

/** Knows every gold branch at 0.95, resting on its first atom and its outcome. */
const goldConnect = () =>
  stubConnect((state) => ({
    label: goldOf.get(branchOf(state)) ?? "plumbing",
    confidence: 0.95,
    rests: ["a0", "outcome"],
  }));

const thresholds = { ece: 0.2, flipRate: 0.1 };

describe("the stage-5 question", () => {
  it("has exactly four criteria keys", () => {
    expect(Object.keys(branchLabelQuestion().criteria)).toEqual([
      "rule",
      "defence",
      "plumbing",
      "could-be-data",
    ]);
    expect(
      Object.keys(branchLabelQuestion({ anchors: false }).criteria),
    ).toEqual(BRANCH_LABELS);
  });

  it("names rederived nowhere in the question or its gold set", () => {
    expect(JSON.stringify(branchLabelQuestion())).not.toMatch(/rederived/);
    expect(JSON.stringify(branchLabelQuestion({ anchors: false }))).not.toMatch(
      /rederived/,
    );
    expect(readFileSync(goldFile, "utf8")).not.toMatch(/rederived/);
  });

  it("gives every criterion a definition and at least one worked anchoring example", () => {
    const { criteria } = branchLabelQuestion();
    for (const label of BRANCH_LABELS) {
      const criterion = BRANCH_LABEL_CRITERIA[label];
      expect(criterion.definition.length).toBeGreaterThan(0);
      expect(criterion.examples.length).toBeGreaterThanOrEqual(1);
      for (const example of criterion.examples) {
        expect(example.branch.length).toBeGreaterThan(0);
        expect(example.why.length).toBeGreaterThan(0);
      }
      expect(criteria[label]).toEqual({
        definition: criterion.definition,
        examples: criterion.examples,
      });
    }
  });

  it("carries the definition alone when asked without anchors", () => {
    const { criteria } = branchLabelQuestion({ anchors: false });
    for (const label of BRANCH_LABELS)
      expect(criteria[label]).toBe(BRANCH_LABEL_CRITERIA[label].definition);
  });
});

describe("the stage-5 gold set", () => {
  it("loads through loadGoldSet with a rewording and covers all four labels", () => {
    expect(gold.stage).toBe("branch-label");
    expect(gold.rewordings.length).toBeGreaterThanOrEqual(1);
    expect(new Set(gold.items.map((i) => i.gold))).toEqual(
      new Set(BRANCH_LABELS),
    );
  });

  it("holds a branch whose label needs a callee's return-value summary", () => {
    const item = gold.items.find((i) => i.id === "caps-switch-off");
    const state = item?.state as BranchLabelState;
    expect(item?.gold).toBe("rule");
    expect(state.returnChecks[0]?.selects).toEqual([
      'returns null ⇐ ¬(features.isOn("project-caps"))',
    ]);
  });

  it("holds a pass-through resolver that mentions an entitlement callee, gold plumbing", () => {
    const item = gold.items.find((i) => i.id === "entitlement-pass-through");
    const state = item?.state as BranchLabelState;
    expect(item?.gold).toBe("plumbing");
    expect(state.atoms).toEqual([]);
    expect(state.concepts[0]?.concept).toMatch(/^entitlement /);
  });

  it("scores through evaluate with a stubbed Jev, evidence first", async () => {
    const connect = goldConnect();
    const evaluation = await evaluate({
      question: branchLabelQuestion(),
      gold,
      connect: evidenceFirst(connect),
      thresholds,
      target: 0.9,
    });
    expect(evaluation.accuracy).toBe(1);
    expect(evaluation.flipRate).toBe(0);
    expect(evaluation.verdict).toEqual({ _tag: "shippable" });
    expect(connect.asked).toHaveLength(gold.items.length * 2);
    for (const { questions } of connect.asked) {
      const keys = Object.keys(questions);
      expect(keys.at(-1)).toBe("verdict");
      expect(keys.slice(0, -1).every((k) => k.startsWith("evidence."))).toBe(
        true,
      );
    }
  });
});

describe("evidence before the verdict", () => {
  const state = gold.items[4]?.state as BranchLabelState;

  it("asks a yes/no per atom and the outcome before the verdict", () => {
    const questions = branchLabelQuestions(state, branchLabelQuestion());
    expect(Object.keys(questions)).toEqual([
      "evidence.a0",
      "evidence.a1",
      "evidence.outcome",
      "verdict",
    ]);
    expect(questions["evidence.a1"]).toMatchObject({ type: "noul" });
  });

  it("records the atoms and spans the label rests on beside the label and confidence", async () => {
    const connect = stubConnect(() => ({
      label: "could-be-data",
      confidence: 0.88,
      rests: ["a1", "outcome"],
    }));
    const answer = await askBranchLabel(connect)(state);
    expect(answer).toEqual({
      label: "could-be-data",
      confidence: 0.88,
      evidence: [
        {
          ref: "a1",
          text: 'v0 === "growth"',
          span: { file: "src/billing/tiers.ts", startLine: 3, endLine: 3 },
          weight: 0.9,
        },
        {
          ref: "outcome",
          text: "return 40",
          span: { file: "src/billing/tiers.ts", startLine: 3, endLine: 3 },
          weight: 0.9,
        },
      ],
    } satisfies BranchJudgement);
  });
});

describe("the #410 comparison", () => {
  it("evaluates the same gold file with and without the anchoring examples in one call", async () => {
    // A stub that answers the gold label when the criteria carry examples and flips a rule to
    // defence under a rewording when they do not: the comparison surfaces the difference.
    const connect = stubConnect((state, questions) => {
      const verdict = questions.verdict as ReturnType<
        typeof branchLabelQuestion
      >;
      const anchored = typeof verdict.criteria.rule === "object";
      const reworded =
        verdict.instructions !== branchLabelQuestion().instructions;
      const label = goldOf.get(branchOf(state)) ?? "plumbing";
      return {
        label: !anchored && reworded && label === "rule" ? "defence" : label,
        confidence: 0.9,
        rests: ["outcome"],
      };
    });
    const { anchored, bare } = await evaluateAnchoring({
      gold,
      connect,
      thresholds,
      target: 0.8,
    });
    expect(anchored.flipRate).toBe(0);
    expect(bare.flipRate).toBe(2 / gold.items.length);
    expect(connect.asked).toHaveLength(gold.items.length * 2 * 2);
  });
});

// ── the stage run: the state it asks on, and the gate ─────────────────────

const FILE = "src/projects/create.ts";
const source = [
  "export function loadCaps(org) {",
  "  if (!features.isOn('project-caps')) return null;",
  "  return capTable.get(org.tier);",
  "}",
  "export function canCreateProject(org) {",
  "  const caps = loadCaps(org);",
  "  if (caps === null) return true;",
  "  return org.projectCount < caps.maxProjects;",
  "}",
].join("\n");

function graph(): LoweringGraph {
  return {
    functions: graphOf(FILE, source, {
      canCreateProject: [
        {
          calleeId: `${FILE}:loadCaps`,
          line: lineOf(source, "loadCaps(org);"),
        },
      ],
    }),
  };
}

async function resolvedArtifacts(): Promise<StageArtifact<ResolvedBranch>[]> {
  const lowered = await runStage(
    memoryArtifactStore<LoweredBranch>(),
    lowerStage,
    loweringInput({ file: FILE, source, functions: graph().functions }),
  );
  const lexicon = parseLexicon({
    entries: { "features.isOn": { kind: "flag", concept: "project-caps" } },
  });
  const resolved = await runStage(
    memoryArtifactStore<ResolvedBranch>(),
    resolveStage,
    resolveInput(lexicon, lowered.artifact),
  );
  return [resolved.artifact];
}

async function stage5Policy() {
  const evaluation = await evaluate({
    question: branchLabelQuestion(),
    gold,
    connect: evidenceFirst(goldConnect()),
    thresholds,
    target: 0.9,
  });
  if (evaluation.calibration._tag !== "derived")
    throw new Error("expected a derived floor");
  return gatePolicy({ calibration: evaluation.calibration, maxRounds: 1 });
}

describe("stage 5 in the walk", () => {
  it("asks on the lowered branch with its concepts and callee summaries, never the raw source", async () => {
    const policy = await stage5Policy();
    const connect = stubConnect(() => ({
      label: "rule",
      confidence: 0.95,
      rests: ["a0"],
    }));
    await summarize({
      graph: graph(),
      resolved: await resolvedArtifacts(),
      labeller: branchLabeller({
        policy,
        ask: askBranchLabel(connect),
        enrich: async (_item, state) => state,
      }),
      store:
        memoryArtifactStore<FunctionSummary<BranchLabel, BranchJudgement>>(),
    });
    const states = connect.asked.map((a) => a.state as BranchLabelState);
    for (const state of states) {
      const text = JSON.stringify(state);
      expect(text).not.toMatch(
        /export function|const caps|caps === null|org\.tier/,
      );
      expect(Object.keys(state).sort()).toEqual(
        [
          "atoms",
          "bindings",
          "branch",
          "callees",
          "concepts",
          "outcome",
          "returnChecks",
        ].sort(),
      );
    }
    const check = states.find((s) => s.branch === `${FILE}:canCreateProject@0`);
    expect(check).toEqual({
      branch: `${FILE}:canCreateProject@0`,
      atoms: [
        {
          ref: "a0",
          text: "v1 === null",
          span: { file: FILE, startLine: 7, endLine: 7 },
        },
      ],
      outcome: {
        text: "return true",
        span: { file: FILE, startLine: 7, endLine: 7 },
      },
      bindings: ["v1 = loadCaps(v0)"],
      concepts: [
        { identifier: "loadCaps", site: "binding", concept: "unresolved" },
      ],
      callees: [
        {
          callee: `${FILE}:loadCaps`,
          returns: [
            'returns null ⇐ ¬(features.isOn("project-caps"))',
            'returns capTable.get(v0.tier) ⇐ features.isOn("project-caps")',
          ],
          labels: [
            { branch: `${FILE}:loadCaps@0`, label: "rule" },
            { branch: `${FILE}:loadCaps@1`, label: "rule" },
          ],
        },
      ],
      returnChecks: [
        {
          atom: "v1 === null",
          callee: `${FILE}:loadCaps`,
          selects: ['returns null ⇐ ¬(features.isOn("project-caps"))'],
        },
      ],
    } satisfies BranchLabelState);
  });

  it("shows a callee label that settled below the floor as unknown", async () => {
    const policy = await stage5Policy();
    const connect = stubConnect((state) => ({
      label: "rule",
      confidence: branchOf(state) === `${FILE}:loadCaps@0` ? 0.3 : 0.95,
      rests: [],
    }));
    const result = await summarize({
      graph: graph(),
      resolved: await resolvedArtifacts(),
      labeller: branchLabeller({
        policy,
        ask: askBranchLabel(connect),
        enrich: async (_item, state) => state,
      }),
      store:
        memoryArtifactStore<FunctionSummary<BranchLabel, BranchJudgement>>(),
    });
    const caller = connect.asked
      .map((a) => a.state as BranchLabelState)
      .find((s) => s.branch === `${FILE}:canCreateProject@0`);
    expect(caller?.callees[0]?.labels).toEqual([
      { branch: `${FILE}:loadCaps@0`, label: "unknown" },
      { branch: `${FILE}:loadCaps@1`, label: "rule" },
    ]);
    expect(result.queue.entries.map((e) => e.id)).toEqual([
      `${FILE}:loadCaps@0`,
    ]);
    expect(result.queue.entries[0]?.answer).toMatchObject({
      label: "rule",
      confidence: 0.3,
    });
  });
});

describe("stage 5 gating", () => {
  const request = (
    id: string,
    text: string,
  ): LabelRequest<BranchLabel, BranchJudgement> => ({
    id,
    span: { file: "src/a.ts", startLine: 2, endLine: 2 },
    branch: {
      branch: {
        function: "src/a.ts:f",
        path: [
          {
            kind: "truthy",
            subject: { kind: "free", path: text },
            polarity: true,
            span: { file: "src/a.ts", startLine: 1, endLine: 1 },
          },
        ],
        outcome: { kind: "return", value: { kind: "literal", raw: "false" } },
        bindings: [],
      },
      resolutions: [],
    },
    callees: [],
    returns: [],
  });

  it("gates through gateAll under a gatePolicy built from its calibration: an abstained branch is unknown and queued", async () => {
    const policy = await stage5Policy();
    const connect = stubConnect((state) =>
      branchOf(state) === "src/a.ts:f@1"
        ? { label: "defence", confidence: 0.4, rests: ["a0"] }
        : { label: "rule", confidence: 0.95, rests: ["a0", "outcome"] },
    );
    const { records, gated } = await labelBranches(
      [
        request("src/a.ts:f@0", "limits.enforced"),
        request("src/a.ts:f@1", "input.ok"),
      ],
      {
        policy,
        ask: askBranchLabel(connect),
        enrich: async (_item, state) => state,
      },
    );
    expect(gated.facts.map((f) => f.value._tag)).toEqual(["known", "unknown"]);
    expect(gated.facts[1]?.value).toEqual({
      _tag: "unknown",
      reason: "abstained",
    });
    expect(gated.queue).toMatchObject({
      stage: "branch-label",
      floor: policy.floor,
      entries: [{ id: "src/a.ts:f@1", rounds: 1 }],
    });
    expect(gated.queue.entries[0]?.answer.evidence.map((e) => e.ref)).toEqual([
      "a0",
    ]);
    expect(records[0]).toMatchObject({
      _tag: "labelled",
      label: { _tag: "known", value: "rule" },
      answer: { label: "rule", confidence: 0.95 },
      rounds: 0,
    });
    expect(
      records[0]?.answer.evidence.map((e) => [e.ref, e.span.startLine]),
    ).toEqual([
      ["a0", 1],
      ["outcome", 2],
    ]);
  });
});
