import { describe, expect, it } from "vitest";
import {
  type ArtifactStore,
  memoryArtifactStore,
  runStage,
  type StageArtifact,
} from "../src/lowering/artifact.js";
import type { Judgement } from "../src/lowering/ask.js";
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
  renderAtom,
} from "../src/lowering/lower.js";
import {
  type FunctionSummary,
  type Labeller,
  type LabelRequest,
  renderReturnFact,
  summarize,
} from "../src/lowering/summarize.js";
import { graphOf, lineOf } from "./lowering-lower-fixture.js";

// Every source below is synthetic, written for these tests.

type Label = "rule" | "plumbing";
type Summary = FunctionSummary<Label, Judgement<Label>>;

const limits = [
  "export function loadLimits(org) {",
  "  if (!flags.isOn('seat-limits')) return null;",
  "  return limitsTable.get(org.plan);",
  "}",
].join("\n");

const invite = [
  "export function canInvite(org, count) {",
  "  const limits = loadLimits(org);",
  "  if (limits === null) return true;",
  "  return org.seats + count <= limits.maxSeats;",
  "}",
  "export function isEven(n) {",
  "  if (n === 0) return true;",
  "  return isOdd(n - 1);",
  "}",
  "export function isOdd(n) {",
  "  if (n === 0) return false;",
  "  return isEven(n - 1);",
  "}",
].join("\n");

const format = [
  "export function formatName(user) {",
  "  if (!user.name) return 'anonymous';",
  "  return user.name;",
  "}",
  "export function greet(user) {",
  "  return formatName(user);",
  "}",
].join("\n");

const LIMITS = "src/gates/limits.ts";
const INVITE = "src/gates/invite.ts";
const FORMAT = "src/text/format.ts";

function graph(sources: Readonly<Record<string, string>>): LoweringGraph {
  const at = (file: string, snippet: string) =>
    lineOf(sources[file] ?? "", snippet);
  return {
    functions: [
      ...graphOf(LIMITS, sources[LIMITS] ?? ""),
      ...graphOf(INVITE, sources[INVITE] ?? "", {
        canInvite: [
          {
            calleeId: `${LIMITS}:loadLimits`,
            line: at(INVITE, "loadLimits(org)"),
          },
        ],
        isEven: [
          { calleeId: `${INVITE}:isOdd`, line: at(INVITE, "isOdd(n - 1)") },
        ],
        isOdd: [
          { calleeId: `${INVITE}:isEven`, line: at(INVITE, "isEven(n - 1)") },
        ],
      }),
      ...graphOf(FORMAT, sources[FORMAT] ?? "", {
        greet: [
          {
            calleeId: `${FORMAT}:formatName`,
            line: at(FORMAT, "formatName(user);"),
          },
        ],
      }),
    ],
  };
}

const lexicon = parseLexicon({
  entries: { "flags.isOn": { kind: "flag", concept: "seat-limits" } },
});

interface Stores {
  readonly lower: ArtifactStore<LoweredBranch>;
  readonly resolve: ArtifactStore<ResolvedBranch>;
  readonly summary: ArtifactStore<Summary>;
}

const freshStores = (): Stores => ({
  lower: memoryArtifactStore(),
  resolve: memoryArtifactStore(),
  summary: memoryArtifactStore(),
});

/** A stub stage 5: labels every branch `rule` at 0.9, except the ids it abstains on. */
function stubLabeller(
  events: string[],
  abstain: ReadonlySet<string> = new Set(),
) {
  const asked: LabelRequest<Label, Judgement<Label>>[] = [];
  const labeller: Labeller<Label, Judgement<Label>> = {
    stage: "branch-label",
    floor: 0.8,
    identity: { question: "stub", floor: 0.8 },
    label: async (requests) => {
      asked.push(...requests);
      events.push(...requests.map((r) => `label ${r.id}`));
      return requests.map((r) =>
        abstain.has(r.id)
          ? {
              _tag: "labelled" as const,
              id: r.id,
              span: r.span,
              label: { _tag: "unknown" as const, reason: "abstained" as const },
              answer: { label: "plumbing" as const, confidence: 0.4 },
              rounds: 1,
            }
          : {
              _tag: "labelled" as const,
              id: r.id,
              span: r.span,
              label: {
                _tag: "known" as const,
                value: "rule" as const,
                basis: {
                  _tag: "promoted" as const,
                  confidence: 0.9,
                  floor: 0.8,
                  round: 0,
                },
              },
              answer: { label: "rule" as const, confidence: 0.9 },
              rounds: 0,
            },
      );
    },
  };
  return Object.assign(labeller, { asked });
}

/** A store that records the order summaries are written in. */
function recording<V>(
  store: ArtifactStore<V>,
  events: string[],
): ArtifactStore<V> {
  return {
    get: (key) => store.get(key),
    put: (artifact) => {
      events.push(...artifact.facts.map((f) => `summary ${f.id}`));
      store.put(artifact);
    },
  };
}

async function pipeline(
  sources: Readonly<Record<string, string>>,
  stores: Stores,
  options: {
    readonly events?: string[];
    readonly abstain?: ReadonlySet<string>;
  } = {},
) {
  const events = options.events ?? [];
  const g = graph(sources);
  const stage2: Record<string, string> = {};
  const resolved: StageArtifact<ResolvedBranch>[] = [];
  for (const [file, source] of Object.entries(sources)) {
    const lowered = await runStage(
      stores.lower,
      lowerStage,
      loweringInput({ file, source, functions: g.functions }),
    );
    stage2[file] = lowered._tag;
    const run = await runStage(
      stores.resolve,
      resolveStage,
      resolveInput(lexicon, lowered.artifact),
    );
    resolved.push(run.artifact);
  }
  const labeller = stubLabeller(events, options.abstain);
  const result = await summarize({
    graph: g,
    resolved,
    labeller,
    store: recording(stores.summary, events),
  });
  const runOf = (fn: string) =>
    result.sccs.find((s) => s.members.includes(fn))?.run._tag ?? "missing";
  return { result, labeller, events, stage2, runOf };
}

const sources = { [LIMITS]: limits, [INVITE]: invite, [FORMAT]: format };

describe("stage 4: the SCC walk", () => {
  it("writes every callee's summary before any of its callers' branches is labelled", async () => {
    const { events } = await pipeline(sources, freshStores());
    const at = (event: string) => {
      const i = events.indexOf(event);
      if (i < 0) throw new Error(`no event ${event} in ${events.join(", ")}`);
      return i;
    };
    const firstLabel = (fn: string) =>
      events.findIndex((e) => e.startsWith(`label ${fn}@`));
    expect(at(`summary ${LIMITS}:loadLimits`)).toBeLessThan(
      firstLabel(`${INVITE}:canInvite`),
    );
    expect(at(`summary ${FORMAT}:formatName`)).toBeLessThan(
      firstLabel(`${FORMAT}:greet`),
    );
    for (const [callee, caller] of [
      [`${LIMITS}:loadLimits`, `${INVITE}:canInvite`],
      [`${FORMAT}:formatName`, `${FORMAT}:greet`],
    ] as const)
      for (const e of events.filter((e) => e.startsWith(`label ${caller}@`)))
        expect(at(`summary ${callee}`)).toBeLessThan(at(e));
  });

  it("summarizes a mutually recursive pair as one unit", async () => {
    const { result } = await pipeline(sources, freshStores());
    const pair = result.sccs.filter(
      (s) =>
        s.members.includes(`${INVITE}:isEven`) ||
        s.members.includes(`${INVITE}:isOdd`),
    );
    expect(pair).toHaveLength(1);
    expect(pair[0]?.members).toEqual([`${INVITE}:isEven`, `${INVITE}:isOdd`]);
    expect(pair[0]?.run.artifact.facts.map((f) => f.id)).toEqual([
      `${INVITE}:isEven`,
      `${INVITE}:isOdd`,
    ]);
  });

  it("walks the condensation leaves-first", async () => {
    const { result } = await pipeline(sources, freshStores());
    const position = (fn: string) =>
      result.sccs.findIndex((s) => s.members.includes(fn));
    expect(position(`${LIMITS}:loadLimits`)).toBeLessThan(
      position(`${INVITE}:canInvite`),
    );
    expect(position(`${FORMAT}:formatName`)).toBeLessThan(
      position(`${FORMAT}:greet`),
    );
  });
});

describe("return-value facts", () => {
  it("summarizes a callee's returns as returns <value> ⇐ <condition>, with its resolved concepts", async () => {
    const { result } = await pipeline(sources, freshStores());
    const summary = result.summaries.get(`${LIMITS}:loadLimits`);
    if (summary?.value._tag !== "known") throw new Error("expected a summary");
    expect(summary.value.value.returns.map(renderReturnFact)).toEqual([
      'returns null ⇐ ¬(flags.isOn("seat-limits"))',
      'returns limitsTable.get(v0.plan) ⇐ flags.isOn("seat-limits")',
    ]);
    expect(summary.value.value.returns[0]?.resolutions).toContainEqual({
      _tag: "resolved",
      identifier: "flags.isOn",
      site: "condition",
      kind: "flag",
      concept: "seat-limits",
    });
  });

  it("resolves a caller's === null check on the callee's result to the callee's condition: the flag being off", async () => {
    const { labeller } = await pipeline(sources, freshStores());
    const check = labeller.asked.find((r) => r.id === `${INVITE}:canInvite@0`);
    expect(check?.branch.branch.path.map(renderAtom)).toEqual(["v2 === null"]);
    expect(check?.returns).toHaveLength(1);
    const [resolution] = check?.returns ?? [];
    expect(resolution?.callee).toBe(`${LIMITS}:loadLimits`);
    expect(resolution?.returns.map(renderReturnFact)).toEqual([
      'returns null ⇐ ¬(flags.isOn("seat-limits"))',
    ]);
    expect(
      resolution?.returns[0]?.resolutions.map(
        (r) => r._tag === "resolved" && r.kind,
      ),
    ).toEqual(["flag"]);
    const otherwise = labeller.asked.find(
      (r) => r.id === `${INVITE}:canInvite@1`,
    );
    expect(otherwise?.returns[0]?.returns.map(renderReturnFact)).toEqual([
      'returns limitsTable.get(v0.plan) ⇐ flags.isOn("seat-limits")',
    ]);
  });
});

describe("a label below the floor", () => {
  it("reaches the callers' summaries as unknown, never as a label, and queues for a human", async () => {
    const { labeller, result } = await pipeline(sources, freshStores(), {
      abstain: new Set([`${LIMITS}:loadLimits@0`]),
    });
    const caller = labeller.asked.find((r) => r.id === `${INVITE}:canInvite@0`);
    const callee = caller?.callees.find(
      (c) => c.callee === `${LIMITS}:loadLimits`,
    );
    if (callee?.summary._tag !== "known")
      throw new Error("expected the callee's summary");
    const labels = callee.summary.value.branches.map((b) => [
      b.id,
      b._tag === "labelled" ? b.label : null,
    ]);
    expect(labels).toEqual([
      [`${LIMITS}:loadLimits@0`, { _tag: "unknown", reason: "abstained" }],
      [
        `${LIMITS}:loadLimits@1`,
        {
          _tag: "known",
          value: "rule",
          basis: { _tag: "promoted", confidence: 0.9, floor: 0.8, round: 0 },
        },
      ],
    ]);
    expect(JSON.stringify(labels[0])).not.toMatch(/"(rule|plumbing)"/);
    expect(result.queue).toMatchObject({
      stage: "branch-label",
      floor: 0.8,
      entries: [{ id: `${LIMITS}:loadLimits@0`, rounds: 1 }],
    });
  });
});

describe("the SCC artifact key", () => {
  it("cites the callees' summary digests: a changed leaf re-runs its ancestors and leaves an unrelated subtree a hit", async () => {
    const stores = freshStores();
    const first = await pipeline(sources, stores);
    expect(first.result.sccs.every((s) => s.run._tag === "computed")).toBe(
      true,
    );

    const again = await pipeline(sources, stores);
    expect(again.result.sccs.every((s) => s.run._tag === "hit")).toBe(true);

    const changed = await pipeline(
      { ...sources, [LIMITS]: limits.replace("seat-limits", "seat-caps") },
      stores,
    );
    expect(changed.stage2).toEqual({
      [LIMITS]: "computed",
      [INVITE]: "hit",
      [FORMAT]: "hit",
    });
    expect(changed.runOf(`${LIMITS}:loadLimits`)).toBe("computed");
    expect(changed.runOf(`${INVITE}:canInvite`)).toBe("computed");
    expect(changed.runOf(`${INVITE}:isEven`)).toBe("hit");
    expect(changed.runOf(`${FORMAT}:formatName`)).toBe("hit");
    expect(changed.runOf(`${FORMAT}:greet`)).toBe("hit");
    expect(changed.labeller.asked.map((r) => r.id.split("@")[0])).toEqual([
      `${LIMITS}:loadLimits`,
      `${LIMITS}:loadLimits`,
      `${INVITE}:canInvite`,
      `${INVITE}:canInvite`,
    ]);
  });

  it("re-labels when the labeller's question or policy changes", async () => {
    const stores = freshStores();
    await pipeline(sources, stores);
    const g = graph(sources);
    const resolved: StageArtifact<ResolvedBranch>[] = [];
    for (const [file, source] of Object.entries(sources)) {
      const lowered = await runStage(
        stores.lower,
        lowerStage,
        loweringInput({ file, source, functions: g.functions }),
      );
      resolved.push(
        (
          await runStage(
            stores.resolve,
            resolveStage,
            resolveInput(lexicon, lowered.artifact),
          )
        ).artifact,
      );
    }
    const labeller = {
      ...stubLabeller([]),
      identity: { question: "stub", floor: 0.7 },
    };
    const result = await summarize({
      graph: g,
      resolved,
      labeller,
      store: stores.summary,
    });
    expect(result.sccs.every((s) => s.run._tag === "computed")).toBe(true);
  });
});
