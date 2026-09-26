import { describe, expect, it } from "vitest";
import {
  derived,
  type Fact,
  sourceSpan,
  unknownValue,
} from "../src/lowering/fact.js";
import type {
  Responsibility,
  ResponsibilityAnswer,
} from "../src/lowering/responsibility.js";
import { rollup } from "../src/lowering/rollup.js";

// Every path, function and feature below is synthetic, written for these tests.

type Verdict = ResponsibilityAnswer | "abstained" | "undetermined";

function fact(
  file: string,
  fn: string,
  feature: string,
  verdict: Verdict,
): Fact<Responsibility> {
  const id = `${file}:${fn}`;
  const record: Responsibility =
    verdict === "undetermined"
      ? { _tag: "undetermined", function: id, feature }
      : {
          _tag: "asked",
          function: id,
          feature,
          verdict:
            verdict === "abstained"
              ? unknownValue("abstained")
              : {
                  _tag: "known",
                  value: verdict,
                  basis: {
                    _tag: "promoted",
                    confidence: 0.95,
                    floor: 0.9,
                    round: 0,
                  },
                },
          answer: {
            label: verdict === "abstained" ? "serves" : verdict,
            confidence: verdict === "abstained" ? 0.4 : 0.95,
          },
          rounds: verdict === "abstained" ? 1 : 0,
        };
  return {
    id: `${id}#${feature}`,
    span: sourceSpan(file, 1, 3),
    value: derived(record),
  };
}

const facts: readonly Fact<Responsibility>[] = [
  fact("src/billing/invoice.ts", "total", "billing", "serves"),
  fact("src/billing/invoice.ts", "total", "projects", "does-not-serve"),
  fact("src/billing/invoice.ts", "send", "billing", "serves"),
  fact("src/billing/invoice.ts", "send", "projects", "abstained"),
  fact("src/billing/plan.ts", "limit", "billing", "serves"),
  fact("src/billing/plan.ts", "limit", "projects", "serves"),
  fact("src/projects/create.ts", "create", "billing", "abstained"),
  fact("src/projects/create.ts", "create", "projects", "serves"),
  fact("src/projects/create.ts", "broken", "billing", "undetermined"),
  fact("src/projects/create.ts", "broken", "projects", "undetermined"),
  fact("main.ts", "start", "billing", "does-not-serve"),
  fact("main.ts", "start", "projects", "does-not-serve"),
];

describe("the rollup", () => {
  it("counts serves, does-not-serve and unknown per feature per file, unknown on its own", () => {
    const { files } = rollup(facts);
    expect(files).toEqual([
      {
        path: "main.ts",
        features: {
          billing: { serves: 0, doesNotServe: 1, unknown: 0 },
          projects: { serves: 0, doesNotServe: 1, unknown: 0 },
        },
      },
      {
        path: "src/billing/invoice.ts",
        features: {
          billing: { serves: 2, doesNotServe: 0, unknown: 0 },
          projects: { serves: 0, doesNotServe: 1, unknown: 1 },
        },
      },
      {
        path: "src/billing/plan.ts",
        features: {
          billing: { serves: 1, doesNotServe: 0, unknown: 0 },
          projects: { serves: 1, doesNotServe: 0, unknown: 0 },
        },
      },
      {
        path: "src/projects/create.ts",
        features: {
          billing: { serves: 0, doesNotServe: 0, unknown: 2 },
          projects: { serves: 1, doesNotServe: 0, unknown: 1 },
        },
      },
    ]);
  });

  it("gives every folder the sum of the files beneath it, up to the root", () => {
    const { files, folders } = rollup(facts);
    expect(folders.map((f) => f.path)).toEqual([
      ".",
      "src",
      "src/billing",
      "src/projects",
    ]);
    for (const folder of folders) {
      const beneath = files.filter(
        (f) => folder.path === "." || f.path.startsWith(`${folder.path}/`),
      );
      for (const feature of ["billing", "projects"])
        for (const field of ["serves", "doesNotServe", "unknown"] as const)
          expect(folder.features[feature]?.[field]).toBe(
            beneath.reduce(
              (sum, f) => sum + (f.features[feature]?.[field] ?? 0),
              0,
            ),
          );
    }
    expect(folders.find((f) => f.path === "src")?.features).toEqual({
      billing: { serves: 3, doesNotServe: 0, unknown: 2 },
      projects: { serves: 2, doesNotServe: 1, unknown: 2 },
    });
  });

  it("writes byte-identical output for the same input, in any order", () => {
    const once = JSON.stringify(rollup(facts));
    expect(JSON.stringify(rollup(facts))).toBe(once);
    expect(JSON.stringify(rollup([...facts].reverse()))).toBe(once);
  });

  it("refuses a (function, feature) pair that appears twice", () => {
    expect(() =>
      rollup([
        ...facts,
        fact("src/billing/plan.ts", "limit", "billing", "serves"),
      ]),
    ).toThrow(/two facts for feature "billing"/);
  });
});
