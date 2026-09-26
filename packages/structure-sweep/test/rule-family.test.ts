import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { JevOk } from "@demlik/tea/jev";
import { afterEach, describe, expect, it, vi } from "vitest";
import { consolidateCommand } from "../src/consolidate/cli.js";
import {
  type ConsolidationPlan,
  DEFAULT_COLLAPSE_FLOOR,
} from "../src/consolidate/plan.js";
import {
  type AnchorJev,
  type AnchorQuestions,
  type AnchorRef,
  sameRuleId,
} from "../src/pairs/anchor.js";
import { type PairsJevs, pairsCommand } from "../src/pairs/cli.js";
import type { PairRow } from "../src/pairs/report.js";
import { repo } from "./helpers.js";

/**
 * One business rule, "an archived document is frozen; otherwise its owner or an admin may edit it",
 * written several ways, beside a look-alike that decides who may view instead. `three/` holds three
 * copies, `four/` a fourth copy that code-graph pairs with one copy only, so its family is split
 * across two anchors' requests, and `pasted/` three byte-identical copies in three files. The three
 * folders hold the same bodies, so the folders' pairs share ids across scopes as well. Each
 * `<folder>.collapse.json` is code-graph's own output over that folder, regenerated with:
 *
 *   code-graph test/fixtures/rule-family/<folder> --collapse --json \
 *     --collapse-config test/fixtures/rule-family/thresholds.json
 *
 * The thresholds only lower `minLoc` and `minComplexity` so functions this short are considered.
 */
const FIXTURE = join(import.meta.dirname, "fixtures/rule-family");

const COPIES = new Set([
  "canEditDocument",
  "mayModifyDoc",
  "isEditAllowed",
  "mayModifyDocument",
]);
const LOOK_ALIKE = "canViewDocument";

const FOLDERS = ["three", "four", "pasted"] as const;

/** The fixture's sources, committed into a fresh repository under their folder names. */
function fixtureRepo(): string {
  const files: Record<string, string> = {};
  for (const folder of FOLDERS)
    for (const name of readdirSync(join(FIXTURE, folder)))
      files[`${folder}/${name}`] = readFileSync(
        join(FIXTURE, folder, name),
        "utf8",
      );
  return realpathSync(repo(files));
}

/** One request the stand-in was asked: its anchor and candidates as `path:function`, candidates sorted. */
interface Asked {
  readonly anchor: string;
  readonly candidates: readonly string[];
}

/** The requests asked over one folder, by anchor, so the pool's call order does not matter. */
const askedIn = (asked: readonly Asked[], folder: string) =>
  asked
    .filter((a) => a.anchor.startsWith(`${folder}/`))
    .sort((x, y) => (x.anchor < y.anchor ? -1 : 1));

/**
 * A Jev stand-in for the fixture: yes at 0.9 when the anchor and the candidate are both copies of
 * the rule, `lookAlikeYes` when one is the look-alike, and 0.1 otherwise. It judges each candidate
 * by its own `same_rule` question, as the real service is asked to.
 */
function ruleJev(lookAlikeYes: number) {
  const asked: Asked[] = [];
  const ask: AnchorJev = async (questions, state) => {
    const read = state as unknown as {
      anchor: { path: string; function: string };
      candidates: { ref: AnchorRef; path: string; function: string }[];
    };
    asked.push({
      anchor: `${read.anchor.path}:${read.anchor.function}`,
      candidates: read.candidates.map((c) => `${c.path}:${c.function}`).sort(),
    });
    const yes = (candidate: string) => {
      const pair = [read.anchor.function, candidate];
      if (pair.every((fn) => COPIES.has(fn))) return 0.9;
      if (pair.includes(LOOK_ALIKE)) return lookAlikeYes;
      return 0.1;
    };
    const answers: JevOk<AnchorQuestions>["answers"] = {
      ...Object.fromEntries(
        read.candidates.map((c) => [
          sameRuleId(c.ref),
          { type: "noul", noul: yes(c.function) },
        ]),
      ),
      business_rule: { type: "noul", noul: 0.9 },
    };
    expect(Object.keys(answers).sort()).toEqual(Object.keys(questions).sort());
    return {
      answers,
      model: "jev-stub",
      usage: { input_tokens: 10, output_tokens: 1 },
      source: "port",
    };
  };
  return Object.assign(ask, { asked });
}

const jevsOf = (anchor: AnchorJev): PairsJevs => ({
  anchor: () => anchor,
  pairwise: () => {
    throw new Error("the default mode is anchor mode");
  },
});

const read = (root: string, path: string) =>
  readFileSync(join(root, path), "utf8");

/** `pairs` over both folders' collapse reports, then `consolidate`, both as the bin runs them. */
async function pairsThenConsolidate(
  jev: AnchorJev,
  consolidateArgs: readonly string[] = [],
) {
  const root = fixtureRepo();
  await pairsCommand(
    FOLDERS.map((f) => `${f}=${join(FIXTURE, `${f}.collapse.json`)}`),
    root,
    jevsOf(jev),
  );
  consolidateCommand(consolidateArgs, root);
  return {
    rows: JSON.parse(read(root, ".structure-sweep/pairs.json")) as PairRow[],
    plan: JSON.parse(
      read(root, ".structure-sweep/consolidate.json"),
    ) as ConsolidationPlan,
    report: read(root, ".structure-sweep/consolidate.md"),
  };
}

const inScope = (plan: ConsolidationPlan, scope: string) =>
  (plan.collapse ?? []).filter((p) => p.scope === scope);

describe("pairs then consolidate over one rule written several ways", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("proposes the three copies as ONE collapse group, without the look-alike, every link at the default floor", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const jev = ruleJev(0.1);
    const { rows, plan, report } = await pairsThenConsolidate(jev);

    expect(plan.floor).toBe(DEFAULT_COLLAPSE_FLOOR);
    expect(inScope(plan, "three")).toEqual([
      {
        scope: "three",
        members: [
          "three/allowed.ts:isEditAllowed",
          "three/edit.ts:canEditDocument",
          "three/modify.ts:mayModifyDoc",
        ],
        pairs: 3,
        confidence: 0.9,
      },
    ]);
    // Every link that joined the group is a same_decision at or above the floor.
    const family = rows.filter(
      (r) =>
        r.scope === "three" &&
        COPIES.has(r.a.function) &&
        COPIES.has(r.b.function),
    );
    expect(family).toHaveLength(3);
    for (const row of family)
      expect(row.answers.verdict).toEqual({
        choice: "same_decision",
        confidence: 0.9,
      });
    // The copies' three pairs were asked from two anchors, not one.
    expect(askedIn(jev.asked, "three")).toEqual([
      {
        anchor: "three/allowed.ts:isEditAllowed",
        candidates: [
          "three/edit.ts:canEditDocument",
          "three/modify.ts:mayModifyDoc",
          "three/view.ts:canViewDocument",
        ],
      },
      {
        anchor: "three/edit.ts:canEditDocument",
        candidates: [
          "three/modify.ts:mayModifyDoc",
          "three/view.ts:canViewDocument",
        ],
      },
      {
        anchor: "three/modify.ts:mayModifyDoc",
        candidates: ["three/view.ts:canViewDocument"],
      },
    ]);
    expect(report).toContain("## Collapse copies of one rule");
    expect(report).toContain("`three/modify.ts:mayModifyDoc`");
    expect(report).not.toContain("three/view.ts:canViewDocument");
  });

  it("joins a four-copy family whose pairs sit on two anchors' candidate lists", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const jev = ruleJev(0.1);
    const { plan } = await pairsThenConsolidate(jev);

    // code-graph pairs the fourth copy with mayModifyDoc only, so mayModifyDoc is in the most pairs
    // and anchors first; the isEditAllowed × canEditDocument link is asked from the next anchor.
    expect(askedIn(jev.asked, "four")).toEqual([
      {
        anchor: "four/allowed.ts:isEditAllowed",
        candidates: [
          "four/edit.ts:canEditDocument",
          "four/view.ts:canViewDocument",
        ],
      },
      {
        anchor: "four/edit.ts:canEditDocument",
        candidates: ["four/view.ts:canViewDocument"],
      },
      {
        anchor: "four/modify.ts:mayModifyDoc",
        candidates: [
          "four/allowed.ts:isEditAllowed",
          "four/document.ts:mayModifyDocument",
          "four/edit.ts:canEditDocument",
          "four/view.ts:canViewDocument",
        ],
      },
    ]);
    expect(inScope(plan, "four")).toEqual([
      {
        scope: "four",
        members: [
          "four/allowed.ts:isEditAllowed",
          "four/document.ts:mayModifyDocument",
          "four/edit.ts:canEditDocument",
          "four/modify.ts:mayModifyDoc",
        ],
        pairs: 4,
        confidence: 0.9,
      },
    ]);
  });

  it("keeps a row per byte-identical copy, so three pasted copies are one group of three", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { rows, plan } = await pairsThenConsolidate(ruleJev(0.1));
    const pasted = rows.filter(
      (r) => r.scope === "pasted" && r.b.function !== LOOK_ALIKE,
    );
    // The three pairs hash to one id, since every copy's body is the same text.
    expect(new Set(pasted.map((r) => r.id)).size).toBe(1);
    expect(pasted).toHaveLength(3);
    expect(inScope(plan, "pasted")).toEqual([
      {
        scope: "pasted",
        members: [
          "pasted/billing.ts:canEditDocument",
          "pasted/editor.ts:canEditDocument",
          "pasted/sharing.ts:canEditDocument",
        ],
        pairs: 3,
        confidence: 0.9,
      },
    ]);
    // Every scope keeps its own rows though the folders repeat each other's bodies.
    expect(new Set(rows.map((r) => r.scope))).toEqual(new Set(FOLDERS));
  });

  it("serves every pasted copy's own answer from the ledger on a second run", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const root = fixtureRepo();
    const args = FOLDERS.map(
      (f) => `${f}=${join(FIXTURE, `${f}.collapse.json`)}`,
    );
    await pairsCommand(args, root, jevsOf(ruleJev(0.1)));
    const first = read(root, ".structure-sweep/pairs.json");
    const again = ruleJev(0.1);
    await pairsCommand(args, root, jevsOf(again));
    expect(again.asked).toEqual([]);
    expect(read(root, ".structure-sweep/pairs.json")).toBe(first);
  });

  it("keeps a look-alike Jev only weakly calls the same rule out of the group, and --floor can let it in", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const weak = await pairsThenConsolidate(ruleJev(0.65));
    const lookAlikeRows = weak.rows.filter(
      (r) =>
        r.scope === "three" &&
        [r.a.function, r.b.function].includes(LOOK_ALIKE),
    );
    expect(lookAlikeRows.map((r) => r.answers.verdict)).toEqual(
      Array(3).fill({ choice: "same_decision", confidence: 0.65 }),
    );
    expect(inScope(weak.plan, "three").map((p) => p.members.length)).toEqual([
      3,
    ]);

    const loose = await pairsThenConsolidate(ruleJev(0.65), ["--floor", "0.6"]);
    expect(inScope(loose.plan, "three")).toEqual([
      expect.objectContaining({
        members: expect.arrayContaining(["three/view.ts:canViewDocument"]),
        confidence: 0.65,
      }),
    ]);
  });
});
