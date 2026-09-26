import { join } from "node:path";
import type { JevChoiceAnswer, JevState } from "@demlik/tea/jev";
import { describe, expect, it } from "vitest";
import {
  memoryArtifactStore,
  runStage,
  type StageArtifact,
} from "../src/lowering/artifact.js";
import type { ChoiceQuestions } from "../src/lowering/ask.js";
import { sourceSpan } from "../src/lowering/fact.js";
import { gatePolicy } from "../src/lowering/gate.js";
import { evaluate, loadGoldSet } from "../src/lowering/harness.js";
import type { BranchLabel } from "../src/lowering/label.js";
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
  labelResponsibilities,
  RESPONSIBILITY_ANSWERS,
  type Responsibility,
  type ResponsibilityAnswer,
  type ResponsibilityRequest,
  type ResponsibilityState,
  responsibilityQuestion,
  responsibilityRequests,
  responsibilityStage,
  verdictOf,
} from "../src/lowering/responsibility.js";
import {
  type FunctionSummary,
  type Labeller,
  summarize,
} from "../src/lowering/summarize.js";
import { loadVocabulary } from "../src/vocabulary.js";
import { stubJev } from "./helpers.js";
import { graphOf, lineOf } from "./lowering-lower-fixture.js";

// Every source, state, vocabulary and gold item below is synthetic, written for these tests.

const fixtures = join(import.meta.dirname, "fixtures/lowering");
const vocabulary = loadVocabulary(
  join(fixtures, "responsibility.vocabulary.json"),
);
const gold = loadGoldSet(
  join(fixtures, "responsibility.gold.json"),
  RESPONSIBILITY_ANSWERS,
);
const goldOf = new Map(gold.items.map((item) => [item.id, item.gold]));

const asState = (state: JevState) => state as ResponsibilityState;
const pairOf = (state: JevState) =>
  `${asState(state).function}#${asState(state).feature.key}`;

function answer(
  label: ResponsibilityAnswer,
  confidence: number,
): JevChoiceAnswer<ResponsibilityAnswer> {
  const other: ResponsibilityAnswer =
    label === "serves" ? "does-not-serve" : "serves";
  return {
    type: "choice",
    choice: label,
    confidence,
    probabilities: { [label]: confidence, [other]: 1 - confidence } as Record<
      ResponsibilityAnswer,
      number
    >,
  };
}

/** A stub Jev for every wording: `decide` sees the state and the question it was asked. */
function stubConnect(
  decide: (
    state: ResponsibilityState,
    questions: ChoiceQuestions<ResponsibilityAnswer>,
  ) => JevChoiceAnswer<ResponsibilityAnswer>,
) {
  const clients: ReturnType<
    typeof stubJev<ChoiceQuestions<ResponsibilityAnswer>>
  >[] = [];
  const connect = (questions: ChoiceQuestions<ResponsibilityAnswer>) => {
    const client = stubJev<ChoiceQuestions<ResponsibilityAnswer>>((state) => ({
      verdict: decide(asState(state), questions),
    }));
    clients.push(client);
    return client;
  };
  return Object.assign(connect, {
    asked: () => clients.flatMap((c) => c.asked.map(asState)),
  });
}

/** Knows every gold pair at 0.95. */
const goldConnect = () =>
  stubConnect((state) =>
    answer(goldOf.get(pairOf(state)) ?? "does-not-serve", 0.95),
  );

const thresholds = { ece: 0.2, flipRate: 0.1 };

async function responsibilityPolicy() {
  const evaluation = await evaluate({
    question: responsibilityQuestion,
    gold,
    connect: goldConnect(),
    thresholds,
    target: 0.9,
  });
  if (evaluation.calibration._tag !== "derived")
    throw new Error("expected a derived floor");
  return gatePolicy({ calibration: evaluation.calibration, maxRounds: 1 });
}

describe("the responsibility question", () => {
  it("is a closed choice over exactly two answers", () => {
    expect(responsibilityQuestion.type).toBe("choice");
    expect(Object.keys(responsibilityQuestion.criteria)).toEqual([
      "serves",
      "does-not-serve",
    ]);
  });
});

describe("the responsibility gold set", () => {
  const functions = new Set(
    gold.items.map((item) => asState(item.state).function),
  );
  const served = (fn: string) =>
    gold.items.filter(
      (i) => asState(i.state).function === fn && i.gold === "serves",
    ).length;

  it("loads through loadGoldSet: at least 20 functions and a rewording", () => {
    expect(gold.stage).toBe("responsibility");
    expect(functions.size).toBeGreaterThanOrEqual(20);
    expect(gold.rewordings.length).toBeGreaterThanOrEqual(1);
  });

  it("asks every function about every vocabulary feature", () => {
    const features = Object.keys(vocabulary.features).sort();
    for (const fn of functions)
      expect(
        gold.items
          .filter((i) => asState(i.state).function === fn)
          .map((i) => asState(i.state).feature.key),
      ).toEqual(features);
  });

  it("holds functions that serve two features and functions that serve none", () => {
    const counts = [...functions].map(served);
    expect(counts.filter((n) => n === 2).length).toBeGreaterThanOrEqual(2);
    expect(counts.filter((n) => n === 0).length).toBeGreaterThanOrEqual(2);
  });

  it("is shaped like the state the stage asks on", () => {
    for (const item of gold.items)
      expect(Object.keys(item.state as object).sort()).toEqual(
        ["branches", "callees", "feature", "function", "product"].sort(),
      );
  });

  it("scores through evaluate with a stubbed Jev and derives the floor with calibrate", async () => {
    const connect = goldConnect();
    const evaluation = await evaluate({
      question: responsibilityQuestion,
      gold,
      connect,
      thresholds,
      target: 0.9,
    });
    expect(evaluation.accuracy).toBe(1);
    expect(evaluation.flipRate).toBe(0);
    expect(evaluation.verdict).toEqual({ _tag: "shippable" });
    expect(evaluation.calibration).toMatchObject({
      _tag: "derived",
      floor: 0.9,
    });
    expect(connect.asked()).toHaveLength(gold.items.length * 2);
  });
});

// ── the state, built from stages 2 to 4 ───────────────────────────────────

const FILE = "src/projects/create.ts";
const source = [
  "export function loadCaps(org) {",
  "  if (!features.isOn('project-caps')) return null;",
  "  return capTable.get(org.tier);",
  "}",
  "export function createProject(org, name) {",
  "  const caps = loadCaps(org);",
  "  if (caps !== null && org.projectCount >= caps.maxProjects) throw new LimitReached();",
  "  return projectStore.insert(org.id, name);",
  "}",
].join("\n");

function graph(): LoweringGraph {
  return {
    functions: graphOf(FILE, source, {
      createProject: [
        {
          calleeId: `${FILE}:loadCaps`,
          line: lineOf(source, "loadCaps(org);"),
        },
      ],
    }),
  };
}

/** Stage 5 as a stub: every branch is plumbing. */
const plumbingLabeller: Labeller<
  BranchLabel,
  { label: BranchLabel; confidence: number }
> = {
  stage: "branch-label",
  floor: 0.9,
  identity: "stub",
  label: async (requests) =>
    requests.map((r) => ({
      _tag: "labelled",
      id: r.id,
      span: r.span,
      label: { _tag: "known", value: "plumbing", basis: { _tag: "derived" } },
      answer: { label: "plumbing", confidence: 0.95 },
      rounds: 0,
    })),
};

async function requestsFromSource(): Promise<readonly ResponsibilityRequest[]> {
  const lowered = await runStage(
    memoryArtifactStore<LoweredBranch>(),
    lowerStage,
    loweringInput({ file: FILE, source, functions: graph().functions }),
  );
  const resolved: StageArtifact<ResolvedBranch>[] = [
    (
      await runStage(
        memoryArtifactStore<ResolvedBranch>(),
        resolveStage,
        resolveInput(
          parseLexicon({
            entries: {
              "features.isOn": { kind: "flag", concept: "project-caps" },
            },
          }),
          lowered.artifact,
        ),
      )
    ).artifact,
  ];
  const { summaries } = await summarize({
    graph: graph(),
    resolved,
    labeller: plumbingLabeller,
    store:
      memoryArtifactStore<
        FunctionSummary<BranchLabel, { label: BranchLabel; confidence: number }>
      >(),
  });
  return responsibilityRequests({ graph: graph(), resolved, summaries });
}

describe("the state the stage asks on", () => {
  it("is built from lowered branches, their resolutions and callee summaries, never the raw source", async () => {
    const policy = await responsibilityPolicy();
    const connect = stubConnect(() => answer("serves", 0.95));
    await labelResponsibilities({
      requests: await requestsFromSource(),
      stage: responsibilityStage({
        vocabulary,
        policy,
        connect,
        enrich: async (_item, state) => state,
      }),
      store: memoryArtifactStore<Responsibility>(),
    });
    const states = connect.asked();
    expect(states).toHaveLength(2 * 3);
    for (const state of states) {
      const text = JSON.stringify(state);
      expect(text).not.toMatch(
        /export function|const caps|caps !== null|org\.projectCount|org\.tier|\(org, name\)/,
      );
    }
    const caller = states.find(
      (s) =>
        s.function === `${FILE}:createProject` && s.feature.key === "projects",
    );
    expect(caller).toEqual({
      function: `${FILE}:createProject`,
      product: "A synthetic team task tracker, written for these tests.",
      feature: {
        key: "projects",
        description:
          "Creating, renaming, archiving and exporting projects, their members and their tasks.",
      },
      branches: [
        {
          branch: `${FILE}:createProject@0`,
          condition: ["¬(v2 === null)", "v0.projectCount >= v2.maxProjects"],
          outcome: "throw new LimitReached()",
          bindings: ["v2 = loadCaps(v0)"],
          concepts: [
            {
              identifier: "LimitReached",
              site: "outcome",
              concept: "unresolved",
            },
            { identifier: "loadCaps", site: "binding", concept: "unresolved" },
          ],
        },
        {
          branch: `${FILE}:createProject@1`,
          condition: ["(v2 === null ∨ ¬(v0.projectCount >= v2.maxProjects))"],
          outcome: "return projectStore.insert(v0.id, v1)",
          bindings: ["v2 = loadCaps(v0)"],
          concepts: expect.any(Array),
        },
      ],
      callees: [
        {
          callee: `${FILE}:loadCaps`,
          returns: [
            'returns null ⇐ ¬(features.isOn("project-caps"))',
            'returns capTable.get(v0.tier) ⇐ features.isOn("project-caps")',
          ],
          labels: [
            { branch: `${FILE}:loadCaps@0`, label: "plumbing" },
            { branch: `${FILE}:loadCaps@1`, label: "plumbing" },
          ],
        },
      ],
    } satisfies ResponsibilityState);
  });
});

// ── the facts, the queue and the cache ────────────────────────────────────

const request = (fn: string): ResponsibilityRequest => ({
  span: sourceSpan(`src/${fn}.ts`, 1, 4),
  evidence: {
    _tag: "lowered",
    function: `src/${fn}.ts:${fn}`,
    branches: [
      {
        branch: `src/${fn}.ts:${fn}@0`,
        condition: [],
        outcome: `return ${fn}Store.read(v0)`,
        bindings: [],
        concepts: [],
      },
    ],
    callees: [],
  },
});

/** `invite` serves projects and notifications, `retry` serves nothing, `charge` abstains on notifications. */
const decide = (state: ResponsibilityState) => {
  const fn = state.function.slice(state.function.indexOf(":") + 1);
  const feature = state.feature.key;
  if (fn === "charge" && feature === "notifications")
    return answer("serves", 0.4);
  const serves =
    (fn === "invite" && feature !== "billing") ||
    (fn === "charge" && feature === "billing");
  return answer(serves ? "serves" : "does-not-serve", 0.95);
};

async function runOver(store = memoryArtifactStore<Responsibility>()) {
  const connect = stubConnect(decide);
  const policy = await responsibilityPolicy();
  const result = await labelResponsibilities({
    requests: [request("invite"), request("retry"), request("charge")],
    stage: responsibilityStage({
      vocabulary,
      policy,
      connect,
      enrich: async (_item, state) => state,
    }),
    store,
  });
  return { result, connect, policy };
}

const table = (facts: readonly { id: string; value: unknown }[]) =>
  Object.fromEntries(
    facts.map((fact) => {
      const record = (fact.value as { value: Responsibility }).value;
      const verdict = verdictOf(record);
      return [
        fact.id,
        verdict._tag === "known" ? verdict.value : verdict.reason,
      ];
    }),
  );

describe("the responsibility stage", () => {
  it("writes one fact per (function, feature): two features, none, and an abstained unknown", async () => {
    const { result, policy } = await runOver();
    expect(table(result.facts)).toEqual({
      "src/invite.ts:invite#billing": "does-not-serve",
      "src/invite.ts:invite#notifications": "serves",
      "src/invite.ts:invite#projects": "serves",
      "src/retry.ts:retry#billing": "does-not-serve",
      "src/retry.ts:retry#notifications": "does-not-serve",
      "src/retry.ts:retry#projects": "does-not-serve",
      "src/charge.ts:charge#billing": "serves",
      "src/charge.ts:charge#notifications": "abstained",
      "src/charge.ts:charge#projects": "does-not-serve",
    });
    const serves = result.facts.find(
      (f) => f.id === "src/invite.ts:invite#projects",
    );
    expect(serves?.value).toMatchObject({
      value: {
        _tag: "asked",
        function: "src/invite.ts:invite",
        feature: "projects",
        verdict: {
          _tag: "known",
          value: "serves",
          basis: { _tag: "promoted", confidence: 0.95, floor: policy.floor },
        },
      },
    });
    expect(result.queue).toMatchObject({
      stage: "responsibility",
      floor: policy.floor,
      entries: [
        {
          id: "src/charge.ts:charge#notifications",
          answer: { label: "serves", confidence: 0.4 },
          rounds: 1,
        },
      ],
    });
  });

  it("asks one closed two-answer question per feature through the gate", async () => {
    const { connect } = await runOver();
    const asked = connect.asked();
    // Nine pairs, and the one below the floor is asked again after its enrichment round.
    expect(asked).toHaveLength(9 + 1);
    expect(
      asked
        .filter((s) => s.function === "src/retry.ts:retry")
        .map((s) => s.feature.key),
    ).toEqual(["billing", "notifications", "projects"]);
  });

  it("is a hit on a second run over unchanged functions and makes no Jev call", async () => {
    const store = memoryArtifactStore<Responsibility>();
    const first = await runOver(store);
    expect(first.result.runs.map((r) => r.run._tag)).toEqual([
      "computed",
      "computed",
      "computed",
    ]);
    const second = await runOver(store);
    expect(second.result.runs.map((r) => r.run._tag)).toEqual([
      "hit",
      "hit",
      "hit",
    ]);
    expect(second.connect.asked()).toHaveLength(0);
    expect(second.result.facts).toEqual(first.result.facts);
    expect(second.result.queue).toEqual(first.result.queue);
  });

  it("re-asks a function whose evidence changed, and only that one", async () => {
    const store = memoryArtifactStore<Responsibility>();
    await runOver(store);
    const policy = await responsibilityPolicy();
    const connect = stubConnect(decide);
    const changed = request("retry");
    const result = await labelResponsibilities({
      requests: [
        request("invite"),
        {
          ...changed,
          evidence: {
            ...changed.evidence,
            branches: [],
          } as ResponsibilityRequest["evidence"],
        },
      ],
      stage: responsibilityStage({
        vocabulary,
        policy,
        connect,
        enrich: async (_item, state) => state,
      }),
      store,
    });
    expect(result.runs.map((r) => r.run._tag)).toEqual(["hit", "computed"]);
    expect(connect.asked().map((s) => s.function)).toEqual([
      "src/retry.ts:retry",
      "src/retry.ts:retry",
      "src/retry.ts:retry",
    ]);
  });

  it("never asks about a function stage 2 could not lower: every feature is unknown", async () => {
    const policy = await responsibilityPolicy();
    const connect = stubConnect(decide);
    const result = await labelResponsibilities({
      requests: [
        {
          span: sourceSpan("src/broken.ts", 1, 3),
          evidence: { _tag: "undetermined", function: "src/broken.ts:broken" },
        },
      ],
      stage: responsibilityStage({
        vocabulary,
        policy,
        connect,
        enrich: async (_item, state) => state,
      }),
      store: memoryArtifactStore<Responsibility>(),
    });
    expect(connect.asked()).toHaveLength(0);
    expect(table(result.facts)).toEqual({
      "src/broken.ts:broken#billing": "undetermined",
      "src/broken.ts:broken#notifications": "undetermined",
      "src/broken.ts:broken#projects": "undetermined",
    });
    expect(result.queue.entries).toEqual([]);
  });
});
