import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULTS } from "../src/cli-paths.js";
import { PROPOSE_USAGE } from "../src/propose/cli.js";
import {
  type History,
  overlay,
  plateauOf,
  type RefineRow,
  type RefineRun,
  recordRun,
  refine,
  type SweptRow,
} from "../src/propose/refine.js";
import { refineCommand } from "../src/propose/refine-cli.js";
import { readChangeSets } from "../src/score/history.js";
import { scoreCoChange } from "../src/score/score.js";
import type { SweepQuestions } from "../src/sweep/questions.js";
import { runSweep } from "../src/sweep/run.js";
import { loadVocabulary, type Vocabulary } from "../src/vocabulary.js";
import { choice, commit, repo, stubJev, write } from "./helpers.js";

const VOCABULARY = {
  product: "a shop",
  features: {
    cart: "The basket.",
    pay: "Taking payment.",
    ship: "Getting parcels out.",
  },
  roles: {
    rule: { description: "Decides.", dir: "rules" },
    glue: { description: "Plumbing.", dir: "lib", shared: true },
  },
};

const touch = (root: string, subject: string, paths: readonly string[]) => {
  write(
    root,
    Object.fromEntries(paths.map((p) => [p, `export const v = "${subject}";`])),
  );
  commit(root, subject);
};

/**
 * cart {a b}, pay {c d s}, ship {e f g h}; o names a feature the vocabulary dropped, s was judged
 * under another vocabulary.
 *   a b    inside cart          a c, b d   cart × pay       c d   inside pay
 *   a e    cart × ship          f g, e h   inside ship
 */
function fixture() {
  const root = realpathSync(repo({ "README.md": "a shop\n" }));
  touch(root, "one (#1)", ["app/cart/a.ts", "app/cart/b.ts"]);
  touch(root, "two (#2)", ["app/cart/a.ts", "app/pay/c.ts"]);
  touch(root, "three (#3)", ["app/cart/b.ts", "app/pay/d.ts"]);
  touch(root, "four (#4)", ["app/pay/c.ts", "app/pay/d.ts"]);
  touch(root, "five (#5)", ["app/cart/a.ts", "app/ship/e.ts"]);
  touch(root, "six (#6)", ["app/ship/f.ts", "app/ship/g.ts"]);
  touch(root, "seven (#7)", ["app/ship/e.ts", "app/ship/h.ts"]);
  touch(root, "eight (#8)", ["app/pay/s.ts"]);
  touch(root, "nine (#9)", ["app/old/o.ts"]);
  write(root, {
    [DEFAULTS.proposedConfig]: JSON.stringify(VOCABULARY, null, 1),
  });
  const vocabulary = loadVocabulary(join(root, DEFAULTS.proposedConfig));
  const row = (path: string, feature: string, fingerprint?: string) => ({
    path,
    scope: "app",
    vocabulary: fingerprint ?? vocabulary.fingerprint,
    answers: { feature: { choice: feature, confidence: 0.9 } },
  });
  const verdicts: RefineRow[] = [
    row("app/cart/a.ts", "cart"),
    row("app/cart/b.ts", "cart"),
    row("app/pay/c.ts", "pay"),
    row("app/pay/d.ts", "pay"),
    row("app/pay/s.ts", "pay", "0000000000000000"),
    row("app/ship/e.ts", "ship"),
    row("app/ship/f.ts", "ship"),
    row("app/ship/g.ts", "ship"),
    row("app/ship/h.ts", "ship"),
    row("app/old/o.ts", "legacy"),
  ];
  write(root, { [DEFAULTS.verdicts]: JSON.stringify(verdicts) });
  return { root, vocabulary, verdicts };
}

const swept = (
  vocabulary: Vocabulary,
  path: string,
  scope: string,
  probabilities: Record<string, number>,
  fingerprint = vocabulary.fingerprint,
): SweptRow => {
  const [top] = Object.entries(probabilities).sort(([, x], [, y]) => y - x);
  return {
    path,
    scope,
    vocabulary: fingerprint,
    answers: {
      feature: {
        choice: top?.[0] ?? "",
        confidence: top?.[1] ?? 0,
        probabilities,
      },
    },
  };
};

function run(
  f: ReturnType<typeof fixture>,
  extra: Partial<Parameters<typeof refine>[0]> = {},
): RefineRun {
  return refine({
    vocabulary: f.vocabulary,
    verdicts: f.verdicts,
    changeSets: readChangeSets(f.root),
    maxFiles: 40,
    history: [],
    threshold: 0.005,
    patience: 2,
    sampleSize: 64,
    sweepable: () => true,
    ...extra,
  });
}

describe("refine", () => {
  const f = fixture();

  it("scores the non-orphaned rows through scoreCoChange", () => {
    const { report } = run(f);
    const { features: _, ...expected } = scoreCoChange(
      f.verdicts.filter((r) => r.path !== "app/old/o.ts"),
      readChangeSets(f.root),
    );
    expect(report.score).toEqual(expected);
    expect(report.rows).toEqual({
      total: 10,
      scored: 9,
      stale: 1,
      orphaned: 1,
    });
    expect(report.staleFiles).toEqual(["app/pay/s.ts"]);
    expect(report.orphanedFiles).toEqual(["app/old/o.ts"]);
  });

  it("carries per-feature cohesion for every feature in the vocabulary", () => {
    const { report } = run(f);
    expect(report.features.map((c) => [c.feature, c.files])).toEqual([
      ["cart", 2],
      ["pay", 3],
      ["ship", 4],
    ]);
  });

  it("ranks merge candidates by the share of co-change crossing between the pair", () => {
    // cart touches 4 pairs, pay 3, ship 3; cart × pay crosses 2, cart × ship 1.
    expect(run(f).report.merge).toEqual([
      {
        features: ["cart", "pay"],
        crossPairs: 2,
        touchingPairs: 5,
        coupling: 0.4,
      },
      {
        features: ["cart", "ship"],
        crossPairs: 1,
        touchingPairs: 6,
        coupling: 1 / 6,
      },
    ]);
  });

  it("names split candidates only at 4 or more files, lowest cohesion first", () => {
    // ship: e f g h active, 6 same-scope pairs, 2 changed together.
    expect(run(f).report.split).toEqual([
      expect.objectContaining({ feature: "ship", files: 4, cohesion: 2 / 6 }),
    ]);
  });

  it("says co-change only without a sweep, and reads Jev's top-2 confusion with one", () => {
    expect(run(f).report.signals).toEqual({ basis: "co-change" });
    const { report } = run(f, {
      swept: [
        swept(f.vocabulary, "app/cart/a.ts", "app/cart", {
          cart: 0.5,
          pay: 0.4,
          ship: 0.1,
        }),
        swept(f.vocabulary, "app/pay/s.ts", "app/pay", {
          pay: 0.6,
          cart: 0.3,
          ship: 0.1,
        }),
        swept(f.vocabulary, "app/ship/e.ts", "app/ship", {
          ship: 0.85,
          cart: 0.1,
          pay: 0.05,
        }),
        swept(
          f.vocabulary,
          "app/ship/f.ts",
          "app/ship",
          { ship: 0.9, pay: 0.1, cart: 0 },
          "0000000000000000",
        ),
      ],
    });
    expect(report.signals).toEqual({
      basis: "co-change and jev",
      jev: {
        rows: 3,
        features: [
          {
            feature: "cart",
            confidence: { confident: 0, rows: 1, share: 0 },
          },
          {
            feature: "pay",
            confidence: { confident: 0, rows: 1, share: 0 },
          },
          {
            feature: "ship",
            confidence: { confident: 1, rows: 1, share: 1 },
          },
        ],
        confusion: [
          { features: ["cart", "pay"], rows: 2 },
          { features: ["cart", "ship"], rows: 1 },
        ],
      },
    });
    // s is re-judged under this vocabulary; f's swept row, judged under another, makes it stale.
    expect(report.staleFiles).toEqual(["app/ship/f.ts"]);
    expect(report.score.f1).toBe(run(f).report.score.f1);
  });

  it("lays a swept row's judgement over the verdict's, keeping the verdict's scope", () => {
    const [row] = overlay(f.verdicts, [
      swept(f.vocabulary, "app/pay/s.ts", "app/pay", { pay: 0.9, cart: 0.1 }),
    ]).filter((r) => r.path === "app/pay/s.ts");
    expect(row).toMatchObject({
      scope: "app",
      vocabulary: f.vocabulary.fingerprint,
    });
  });

  it("samples every orphaned file first, then a slice per feature with stale files first", () => {
    const { sample, report } = run(f, { sampleSize: 3 });
    expect(sample[0]).toBe("app/old/o.ts");
    expect(sample).toHaveLength(4);
    expect(sample).toContain("app/pay/s.ts");
    expect(report.sample).toEqual({
      files: 4,
      perFeature: 1,
      orphaned: 1,
      stale: 1,
      unsweepable: 0,
    });
    expect(
      run(f, { sampleSize: 3, sweepable: (p) => p !== "app/old/o.ts" }).sample,
    ).not.toContain("app/old/o.ts");
  });
});

describe("the refine history", () => {
  const rule = { threshold: 0.005, patience: 2 };
  const entry = (vocabulary: string, f1: number | null) => ({
    vocabulary,
    f1,
  });

  it("replaces the last entry when the vocabulary is unchanged, and appends otherwise", () => {
    const history: History = [entry("a", 0.5), entry("b", 0.6)];
    expect(recordRun(history, entry("b", 0.61))).toEqual([
      entry("a", 0.5),
      entry("b", 0.61),
    ]);
    expect(recordRun(history, entry("c", 0.62))).toHaveLength(3);
  });

  it("plateaus when |ΔF1| stays under the threshold for patience runs", () => {
    expect(plateauOf([entry("a", 0.5)], rule)).toEqual({
      ...rule,
      state: "first-run",
    });
    expect(
      plateauOf([entry("a", 0.5), entry("b", 0.6), entry("c", 0.601)], rule),
    ).toMatchObject({ state: "improving", streak: 1 });
    expect(
      plateauOf([entry("a", 0.5), entry("b", 0.502), entry("c", 0.503)], rule),
    ).toMatchObject({ state: "plateaued", streak: 2 });
    expect(
      plateauOf([entry("a", 0.5), entry("b", null), entry("c", 0.5)], rule),
    ).toMatchObject({ state: "improving", streak: 0, delta: null });
  });
});

describe("refineCommand", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  const outputs = (root: string) =>
    [
      DEFAULTS.refineReport,
      DEFAULTS.refinePrompt,
      DEFAULTS.refineSample,
      DEFAULTS.refineHistory,
    ].map((p) => readFileSync(join(root, p), "utf8"));

  it("is listed in the propose usage", () => {
    expect(PROPOSE_USAGE).toContain("structure-sweep propose refine");
  });

  it("runs with no credentials and no network", () => {
    vi.stubEnv("TYPESAFE_API_KEY", undefined);
    const fetch = vi.fn(() => {
      throw new Error("refine opened a network connection");
    });
    vi.stubGlobal("fetch", fetch);
    const { root } = fixture();
    refineCommand([], root);
    expect(fetch).not.toHaveBeenCalled();
    const [report] = outputs(root);
    expect(JSON.parse(report ?? "")).toMatchObject({
      signals: { basis: "co-change" },
    });
  });

  it("writes byte-identical report, prompt and sample list over the same inputs", () => {
    const { root } = fixture();
    refineCommand([], root);
    const first = outputs(root);
    refineCommand([], root);
    expect(outputs(root)).toEqual(first);
    expect(JSON.parse(first[3] ?? "")).toHaveLength(1);
    const [, prompt] = first;
    expect(prompt).not.toContain(root);
    expect(prompt).toContain("co-change only");
    expect(prompt).toContain("`cart` + `pay`: coupling 0.4000");
    expect(prompt).toContain("`ship`: cohesion 0.3333");
    expect(prompt).toContain(
      `structure-sweep sweep --files ${DEFAULTS.refineSample} --config ${DEFAULTS.proposedConfig} --out ${DEFAULTS.refineSweep}`,
    );
  });

  it("writes a sample list sweep --files judges", async () => {
    const { root, vocabulary } = fixture();
    refineCommand([], root);
    const files = readFileSync(join(root, DEFAULTS.refineSample), "utf8")
      .split("\n")
      .filter(Boolean);
    expect(files).toContain("app/old/o.ts");
    expect(files).toContain("app/pay/s.ts");
    const keys = Object.keys(vocabulary.features);
    const roles = Object.keys(vocabulary.roles);
    const result = await runSweep({
      root,
      ref: "HEAD",
      files,
      vocabulary,
      jev: stubJev<SweepQuestions>(() => ({
        feature: choice("cart", keys),
        role: choice("rule", roles),
        rule_inside_surface: { type: "noul", noul: 0.1 },
      })),
      verdictsPath: join(root, DEFAULTS.refineSweep),
    });
    expect(result.rows.map((r) => r.path).sort()).toEqual([...files].sort());

    refineCommand(["--sweep", DEFAULTS.refineSweep], root);
    const report = JSON.parse(
      readFileSync(join(root, DEFAULTS.refineReport), "utf8"),
    );
    expect(report.signals.basis).toBe("co-change and jev");
    expect(report.rows.orphaned).toBe(0);
  });

  it("says stop once the loop has plateaued", () => {
    const { root } = fixture();
    refineCommand([], root);
    const { f1 } = JSON.parse(
      readFileSync(join(root, DEFAULTS.refineReport), "utf8"),
    ).score;
    write(root, {
      [DEFAULTS.refineHistory]: JSON.stringify([
        { vocabulary: "x", f1 },
        { vocabulary: "y", f1 },
      ]),
    });
    refineCommand([], root);
    const prompt = readFileSync(join(root, DEFAULTS.refinePrompt), "utf8");
    expect(prompt).toContain("Stop. The loop has plateaued");
    expect(prompt).not.toContain("Sweep the sample");
  });
});
