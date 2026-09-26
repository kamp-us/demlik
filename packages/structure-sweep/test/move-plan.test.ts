import { describe, expect, it } from "vitest";
import type { VerdictRow } from "../src/move/manifest.js";
import { type ImportEdge, planManifest } from "../src/move/plan.js";
import { fixtureVocabulary } from "./helpers.js";

const verdict = (
  path: string,
  choice: string,
  confidence: number,
  role: string,
): VerdictRow => ({
  path,
  answers: { feature: { choice, confidence }, role: { choice: role } },
});

const S = "services/svc";

const edge = (from: string, to: string): ImportEdge => ({
  from: `${S}/src/${from}`,
  to: `${S}/src/${to}`,
});

function plan(
  verdicts: VerdictRow[],
  tree: string[],
  entries: [string, string][] = [],
  edges: ImportEdge[] = [],
  features: string[] = ["audit_runs"],
) {
  return planManifest({
    scope: S,
    vocabulary: fixtureVocabulary(),
    features,
    floor: 0.8,
    verdicts,
    tree,
    entries: new Map(entries),
    edges,
  });
}

describe("planManifest", () => {
  it("maps each role to its folder under the feature, a shared role to src/<dir>", () => {
    const m = plan(
      [
        verdict(`${S}/src/handlers/a.ts`, "audit_runs", 0.9, "api_surface"),
        verdict(`${S}/src/handlers/b.ts`, "audit_runs", 0.9, "persistence"),
        verdict(`${S}/src/x/c.ts`, "audit_runs", 0.9, "plumbing"),
      ],
      [`${S}/src/handlers/a.ts`, `${S}/src/handlers/b.ts`, `${S}/src/x/c.ts`],
      [],
      [edge("handlers/a.ts", "handlers/b.ts"), edge("handlers/b.ts", "x/c.ts")],
    );
    expect(m.moves.map((r) => r.to)).toEqual([
      `${S}/src/audit-runs/api/a.ts`,
      `${S}/src/audit-runs/store/b.ts`,
      `${S}/src/lib/c.ts`,
    ]);
  });

  it("pins an entry file whatever the graph says", () => {
    const m = plan(
      [
        verdict(`${S}/src/index.ts`, "audit_runs", 1, "api_surface"),
        verdict(`${S}/src/run.ts`, "audit_runs", 0.9, "orchestration"),
        verdict(`${S}/src/low.ts`, "audit_runs", 0.1, "orchestration"),
      ],
      [`${S}/src/index.ts`, `${S}/src/run.ts`, `${S}/src/low.ts`],
      [
        [`${S}/src/index.ts`, "wrangler.toml main"],
        [`${S}/src/low.ts`, "package.json bin"],
      ],
      [edge("index.ts", "run.ts")],
    );
    expect(m.pinned).toEqual([
      { path: `${S}/src/index.ts`, entry: "wrangler.toml main" },
      { path: `${S}/src/low.ts`, entry: "package.json bin" },
    ]);
    expect(m.moves.map((r) => r.from)).toEqual([`${S}/src/run.ts`]);
  });

  it("carries a colocated test with its source, to the longest-stem owner", () => {
    const m = plan(
      [
        verdict(`${S}/src/h/run.ts`, "audit_runs", 0.9, "orchestration"),
        verdict(`${S}/src/h/queue.ts`, "audit_runs", 0.1, "orchestration"),
      ],
      [
        `${S}/src/h/run.ts`,
        `${S}/src/h/run.pg.test.ts`,
        `${S}/src/h/run.x.ts`,
        `${S}/src/h/run.x.test.ts`,
        `${S}/src/h/queue.ts`,
      ],
      [],
      [edge("h/run.ts", "h/queue.ts")],
    );
    expect(m.moves.map((r) => [r.from, r.to])).toEqual([
      [`${S}/src/h/run.pg.test.ts`, `${S}/src/audit-runs/flows/run.pg.test.ts`],
      [`${S}/src/h/run.ts`, `${S}/src/audit-runs/flows/run.ts`],
    ]);
  });

  it("disambiguates two sources that would land on one path by their old folder", () => {
    const m = plan(
      [
        verdict(`${S}/src/a/vocabulary.ts`, "audit_runs", 0.9, "business_rule"),
        verdict(`${S}/src/b/vocabulary.ts`, "audit_runs", 0.9, "business_rule"),
      ],
      [`${S}/src/a/vocabulary.ts`, `${S}/src/b/vocabulary.ts`],
      [],
      [edge("a/vocabulary.ts", "b/vocabulary.ts")],
    );
    expect(m.moves.map((r) => r.to)).toEqual([
      `${S}/src/audit-runs/rules/a/vocabulary.ts`,
      `${S}/src/audit-runs/rules/b/vocabulary.ts`,
    ]);
  });

  it("skips a verdict whose file is gone from the tree and one outside the feature filter", () => {
    const m = plan(
      [
        verdict(`${S}/src/gone.ts`, "audit_runs", 0.9, "business_rule"),
        verdict(`${S}/src/other.ts`, "billing", 0.9, "business_rule"),
      ],
      [`${S}/src/other.ts`],
    );
    expect(m.moves).toEqual([]);
    expect(m.review).toEqual([]);
  });

  it("refuses a --feature the vocabulary does not name, and a role it does not know", () => {
    expect(() =>
      planManifest({
        scope: S,
        vocabulary: fixtureVocabulary(),
        features: ["nope"],
        floor: 0.8,
        verdicts: [],
        tree: [],
        entries: new Map(),
        edges: [],
      }),
    ).toThrow(/not in the vocabulary: nope/);
    expect(() =>
      plan(
        [
          verdict(`${S}/src/a.ts`, "audit_runs", 0.9, "wizardry"),
          verdict(`${S}/src/b.ts`, "audit_runs", 0.9, "persistence"),
        ],
        [`${S}/src/a.ts`, `${S}/src/b.ts`],
        [],
        [edge("a.ts", "b.ts")],
      ),
    ).toThrow(/role "wizardry"/);
  });
});

describe("planManifest: the graph nominates, Jev verifies", () => {
  const BOTH = ["audit_runs", "billing"];
  const SUBJECT = `${S}/src/x/subject.ts`;
  const files = [
    "subject.ts",
    "runs-a.ts",
    "runs-b.ts",
    "runs-c.ts",
    "bill-a.ts",
    "bill-b.ts",
  ].map((f) => `${S}/src/x/${f}`);
  const anchors = [
    verdict(`${S}/src/x/runs-a.ts`, "audit_runs", 0.3, "orchestration"),
    verdict(`${S}/src/x/runs-b.ts`, "audit_runs", 0.3, "orchestration"),
    verdict(`${S}/src/x/runs-c.ts`, "audit_runs", 0.3, "orchestration"),
    verdict(`${S}/src/x/bill-a.ts`, "billing", 0.3, "business_rule"),
    verdict(`${S}/src/x/bill-b.ts`, "billing", 0.3, "business_rule"),
  ];
  const subjectRow = (m: ReturnType<typeof plan>) => ({
    move: m.moves.find((r) => r.from === SUBJECT),
    review: m.review.find((r) => r.path === SUBJECT),
  });
  // Two edges out and one in to audit_runs files, one each way to billing: 3 of 5 pull to audit_runs.
  const pulledToRuns = [
    edge("x/subject.ts", "x/runs-a.ts"),
    edge("x/subject.ts", "x/runs-b.ts"),
    edge("x/runs-c.ts", "x/subject.ts"),
    edge("x/subject.ts", "x/bill-a.ts"),
    edge("x/bill-b.ts", "x/subject.ts"),
  ];

  it("moves a file when its pull and Jev's confident feature agree", () => {
    const m = plan(
      [verdict(SUBJECT, "audit_runs", 0.9, "orchestration"), ...anchors],
      files,
      [],
      pulledToRuns,
      BOTH,
    );
    expect(subjectRow(m).move).toMatchObject({
      to: `${S}/src/audit-runs/flows/subject.ts`,
      feature: "audit_runs",
      confidence: 0.9,
    });
    expect(subjectRow(m).review).toBeUndefined();
  });

  it("sends a file to review with both opinions when pull and Jev name different features", () => {
    const m = plan(
      [verdict(SUBJECT, "billing", 0.95, "business_rule"), ...anchors],
      files,
      [],
      pulledToRuns,
      BOTH,
    );
    expect(subjectRow(m).move).toBeUndefined();
    expect(subjectRow(m).review).toEqual({
      path: SUBJECT,
      feature: "billing",
      role: "business_rule",
      confidence: 0.95,
      graph: { feature: "audit_runs", share: 0.6, edges: 5 },
    });
  });

  it("sends a file with a pull but Jev under the floor to review", () => {
    const m = plan(
      [verdict(SUBJECT, "audit_runs", 0.5, "orchestration"), ...anchors],
      files,
      [],
      pulledToRuns,
      BOTH,
    );
    expect(subjectRow(m).move).toBeUndefined();
    expect(subjectRow(m).review).toMatchObject({
      feature: "audit_runs",
      confidence: 0.5,
      graph: { feature: "audit_runs", share: 0.6, edges: 5 },
    });
  });

  it("sends a confident Jev verdict with no pull to review", () => {
    const m = plan(
      [verdict(SUBJECT, "audit_runs", 0.9, "orchestration"), ...anchors],
      files,
      [],
      [],
      BOTH,
    );
    expect(subjectRow(m).move).toBeUndefined();
    expect(subjectRow(m).review).toMatchObject({
      feature: "audit_runs",
      confidence: 0.9,
      graph: { feature: null, edges: 0 },
    });
  });

  it("lists a file in neither moves nor review when neither side says move", () => {
    const m = plan(
      [verdict(SUBJECT, "audit_runs", 0.5, "orchestration"), ...anchors],
      files,
      [],
      [],
      BOTH,
    );
    expect(subjectRow(m)).toEqual({ move: undefined, review: undefined });
  });

  it("gives a file whose edges tie between two features no pull", () => {
    const m = plan(
      [verdict(SUBJECT, "audit_runs", 0.9, "orchestration"), ...anchors],
      files,
      [],
      [
        edge("x/subject.ts", "x/runs-a.ts"),
        edge("x/runs-b.ts", "x/subject.ts"),
        edge("x/subject.ts", "x/bill-a.ts"),
        edge("x/bill-b.ts", "x/subject.ts"),
      ],
      BOTH,
    );
    expect(subjectRow(m).move).toBeUndefined();
    expect(subjectRow(m).review).toMatchObject({
      graph: { feature: null, edges: 4 },
    });
  });

  it("counts only edges to neighbours Jev put in a named feature, each edge once", () => {
    const m = plan(
      [
        verdict(SUBJECT, "audit_runs", 0.9, "orchestration"),
        ...anchors,
        verdict(`${S}/src/x/other.ts`, "identity", 0.99, "persistence"),
      ],
      [...files, `${S}/src/x/other.ts`, `${S}/src/x/unjudged.ts`],
      [],
      [
        edge("x/subject.ts", "x/runs-a.ts"),
        edge("x/subject.ts", "x/runs-a.ts"),
        edge("x/subject.ts", "x/subject.ts"),
        edge("x/subject.ts", "x/other.ts"),
        edge("x/subject.ts", "x/unjudged.ts"),
        edge("x/other.ts", "x/subject.ts"),
      ],
      BOTH,
    );
    expect(subjectRow(m).move).toMatchObject({ feature: "audit_runs" });
  });
});
