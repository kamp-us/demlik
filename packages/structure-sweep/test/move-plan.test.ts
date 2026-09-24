import { describe, expect, it } from "vitest";
import type { VerdictRow } from "../src/move/manifest.js";
import { planManifest } from "../src/move/plan.js";
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

function plan(
  verdicts: VerdictRow[],
  tree: string[],
  entries: [string, string][] = [],
) {
  return planManifest({
    scope: S,
    vocabulary: fixtureVocabulary(),
    features: ["audit_runs"],
    floor: 0.8,
    verdicts,
    tree,
    entries: new Map(entries),
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
    );
    expect(m.moves.map((r) => r.to)).toEqual([
      `${S}/src/audit-runs/api/a.ts`,
      `${S}/src/audit-runs/store/b.ts`,
      `${S}/src/lib/c.ts`,
    ]);
  });

  it("sends a file below the floor to review and pins an entry file", () => {
    const m = plan(
      [
        verdict(`${S}/src/low.ts`, "audit_runs", 0.6, "business_rule"),
        verdict(`${S}/src/index.ts`, "audit_runs", 1, "api_surface"),
      ],
      [`${S}/src/low.ts`, `${S}/src/index.ts`],
      [[`${S}/src/index.ts`, "wrangler.toml main"]],
    );
    expect(m.moves).toEqual([]);
    expect(m.review.map((r) => r.path)).toEqual([`${S}/src/low.ts`]);
    expect(m.pinned).toEqual([
      { path: `${S}/src/index.ts`, entry: "wrangler.toml main" },
    ]);
  });

  it("carries a colocated test with its source, to the longest-stem owner", () => {
    const m = plan(
      [verdict(`${S}/src/h/run.ts`, "audit_runs", 0.9, "orchestration")],
      [
        `${S}/src/h/run.ts`,
        `${S}/src/h/run.pg.test.ts`,
        `${S}/src/h/run.x.ts`,
        `${S}/src/h/run.x.test.ts`,
      ],
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
      }),
    ).toThrow(/not in the vocabulary: nope/);
    expect(() =>
      plan(
        [verdict(`${S}/src/a.ts`, "audit_runs", 0.9, "wizardry")],
        [`${S}/src/a.ts`],
      ),
    ).toThrow(/role "wizardry"/);
  });
});
