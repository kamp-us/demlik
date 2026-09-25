import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { consolidateCommand } from "../src/consolidate/cli.js";
import {
  type ClusterRow,
  type ConsolidationPlan,
  extractProposals,
  type HelperPairRow,
  mergeProposals,
} from "../src/consolidate/plan.js";
import type { PairVerdict } from "../src/pairs/questions.js";
import { gitIn, repo, write } from "./helpers.js";

/** `n` non-blank lines, with blank lines between them that must not count. */
const lines = (n: number) =>
  Array.from({ length: n }, (_, i) => `export const v${i} = ${i};\n\n`).join(
    "",
  );

const verdict = (path: string, feature: string, role: string): ClusterRow => ({
  path,
  scope: "app/src",
  answers: { feature: { choice: feature }, role: { choice: role } },
});

const pair = (a: string, b: string, choice: PairVerdict): HelperPairRow => {
  const fn = (key: string) => {
    const [path = "", fnName = ""] = key.split(":");
    return { path, function: fnName };
  };
  return {
    scope: "app/src",
    a: fn(a),
    b: fn(b),
    answers: { verdict: { choice } },
  };
};

const FILES = {
  "app/src/f/at-limit.ts": lines(40),
  "app/src/f/tiny.ts": lines(3),
  "app/src/f/one.ts": lines(1),
  "app/src/f/over-limit.ts": lines(41),
  "app/src/f/s1.ts": lines(2),
  "app/src/f/s2.ts": lines(2),
  "app/src/g/g1.ts": lines(5),
  "app/src/g/g2.ts": lines(5),
  "app/src/g/g3.ts": lines(41),
};

const VERDICTS = [
  verdict("app/src/f/at-limit.ts", "orders", "ui"),
  verdict("app/src/f/tiny.ts", "orders", "ui"),
  verdict("app/src/f/one.ts", "orders", "ui"),
  verdict("app/src/f/over-limit.ts", "orders", "ui"),
  verdict("app/src/f/gone.ts", "orders", "ui"),
  // same feature, other role, only two files: below --min-cluster
  verdict("app/src/f/s1.ts", "orders", "store"),
  verdict("app/src/f/s2.ts", "orders", "store"),
  // three files, but the third is over the limit, leaving two
  verdict("app/src/g/g1.ts", "billing", "ui"),
  verdict("app/src/g/g2.ts", "billing", "ui"),
  verdict("app/src/g/g3.ts", "billing", "ui"),
];

const PAIRS = [
  pair("a.ts:fetchA", "b.ts:fetchB", "shared_helper"),
  pair("b.ts:fetchB", "c.ts:fetchC", "shared_helper"),
  pair("d.ts:mapD", "e.ts:mapE", "shared_helper"),
  pair("a.ts:fetchA", "x.ts:rule", "same_decision"),
  pair("c.ts:fetchC", "y.ts:alike", "look_alike"),
];

const countsIn = (files: Record<string, string>) => (path: string) => {
  const text = files[path];
  return text === undefined
    ? undefined
    : text.split("\n").filter((l) => l.trim() !== "").length;
};

describe("mergeProposals", () => {
  it("keeps files at the line limit, drops those one over, and needs --min-cluster of them", () => {
    const proposals = mergeProposals(VERDICTS, countsIn(FILES));
    expect(proposals).toEqual([
      {
        scope: "app/src",
        feature: "orders",
        role: "ui",
        files: [
          { path: "app/src/f/at-limit.ts", lines: 40 },
          { path: "app/src/f/one.ts", lines: 1 },
          { path: "app/src/f/tiny.ts", lines: 3 },
        ],
        lines: 44,
      },
    ]);
  });

  it("honours --max-lines and --min-cluster", () => {
    const proposals = mergeProposals(VERDICTS, countsIn(FILES), {
      maxLines: 41,
      minCluster: 2,
    });
    expect(proposals.map((p) => [p.feature, p.role, p.files.length])).toEqual([
      ["orders", "ui", 4],
      ["billing", "ui", 3],
      ["orders", "store", 2],
    ]);
  });
});

describe("extractProposals", () => {
  it("joins shared_helper pairs that share a function and ignores every other verdict", () => {
    expect(extractProposals(PAIRS)).toEqual([
      {
        scope: "app/src",
        members: ["a.ts:fetchA", "b.ts:fetchB", "c.ts:fetchC"],
        pairs: 2,
      },
      { scope: "app/src", members: ["d.ts:mapD", "e.ts:mapE"], pairs: 1 },
    ]);
  });

  it("yields nothing from pairs with no shared_helper verdict", () => {
    expect(
      extractProposals(
        PAIRS.filter((p) => p.answers.verdict.choice !== "shared_helper"),
      ),
    ).toEqual([]);
  });
});

describe("structure-sweep consolidate", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  function fixture(): string {
    const root = repo(FILES);
    // The working copy grows past the limit; sizes are read at --ref, not here.
    write(root, {
      "app/src/f/tiny.ts": lines(100),
      ".structure-sweep/verdicts.json": JSON.stringify(VERDICTS),
      ".structure-sweep/pairs.json": JSON.stringify(PAIRS),
    });
    return root;
  }

  const read = (root: string, path: string) =>
    readFileSync(join(root, path), "utf8");

  it("writes the plan and summary deterministically, with no API key and no other file", () => {
    vi.stubEnv("TYPESAFE_API_KEY", undefined);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const root = fixture();
    consolidateCommand([], root);
    const first = read(root, ".structure-sweep/consolidate.json");
    const plan = JSON.parse(first) as ConsolidationPlan;
    expect(plan).toMatchObject({ ref: "HEAD", maxLines: 40, minCluster: 3 });
    expect(plan.merge?.map((p) => p.lines)).toEqual([44]);
    expect(plan.extract?.map((p) => p.members.length)).toEqual([3, 2]);
    expect(read(root, ".structure-sweep/consolidate.md")).toContain(
      "`app/src/f/at-limit.ts` (40)",
    );

    consolidateCommand([], root);
    expect(read(root, ".structure-sweep/consolidate.json")).toBe(first);
    expect(readdirSync(join(root, ".structure-sweep")).sort()).toEqual([
      "consolidate.json",
      "consolidate.md",
      "pairs.json",
      "verdicts.json",
    ]);
    expect(
      gitIn(root, "status", "--porcelain", "--untracked-files=all")
        .split("\n")
        .filter(Boolean)
        .sort(),
    ).toEqual(
      [
        "?? .structure-sweep/consolidate.json",
        "?? .structure-sweep/consolidate.md",
        "?? .structure-sweep/pairs.json",
        "?? .structure-sweep/verdicts.json",
        " M app/src/f/tiny.ts",
      ].sort(),
    );
  });

  it("honours --out and --report", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const root = fixture();
    consolidateCommand(["--out", "plan.json", "--report", "plan.md"], root);
    expect(JSON.parse(read(root, "plan.json")).merge).toHaveLength(1);
    expect(read(root, "plan.md")).toContain("# Consolidation plan");
  });

  it("skips a proposal kind whose input is missing, naming the file", () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line: string) => {
      errors.push(line);
    });
    const root = fixture();
    consolidateCommand(["--pairs", "nowhere.json"], root);
    const plan = JSON.parse(
      read(root, ".structure-sweep/consolidate.json"),
    ) as ConsolidationPlan;
    expect(plan.extract).toBeNull();
    expect(plan.merge).toHaveLength(1);
    expect(errors.some((e) => e.includes("nowhere.json"))).toBe(true);
  });

  it("fails on a malformed input with its parse error", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const root = fixture();
    write(root, { ".structure-sweep/verdicts.json": "[{" });
    expect(() => consolidateCommand([], root)).toThrow(/verdicts\.json: /);
    write(root, { ".structure-sweep/pairs.json": '[{"scope":1}]' });
    write(root, { ".structure-sweep/verdicts.json": "[]" });
    expect(() => consolidateCommand([], root)).toThrow(/pairs\.json/);
  });
});
