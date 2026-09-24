import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JevState } from "@demlik/tea/jev";
import { describe, expect, it } from "vitest";
import {
  PAIR_VERDICTS,
  type PairQuestions,
  type PairVerdict,
} from "../src/pairs/questions.js";
import {
  actionFor,
  countVerdicts,
  type PairRow,
  renderMarkdown,
} from "../src/pairs/report.js";
import { runPairs } from "../src/pairs/run.js";
import { choice, repo, stubJev } from "./helpers.js";

const SOURCES = {
  "svc/src/a.ts": "export function canEdit(u) {\n  return u.owner;\n}\n",
  "svc/src/b.ts": "export function mayEdit(u) {\n  return u.owner;\n}\n",
  "svc/src/c.ts": "export function mapRow(r) {\n  return { id: r.id };\n}\n",
  "svc/src/d.ts": "export function toRow(r) {\n  return { id: r.id };\n}\n",
};

/** The shape `code-graph svc --collapse --json` writes, trimmed to one candidate per pair. */
function candidate(a: string, aFn: string, b: string, bFn: string) {
  return {
    aId: `${a}:${aFn}`,
    aFile: a,
    aStartLine: 1,
    aEndLine: 3,
    bId: `${b}:${bFn}`,
    bFile: b,
    bStartLine: 1,
    bEndLine: 3,
    signals: [{ signal: "shape", strength: 0.9, detail: "same size" }],
    confidence: 0.8,
    cost: 1,
    rank: 1,
  };
}

function collapseReport(): string {
  const path = join(mkdtempSync(join(tmpdir(), "collapse-")), "svc.json");
  writeFileSync(
    path,
    JSON.stringify({
      settings: {},
      consideredFunctions: 4,
      pairsScored: 3,
      skippedBlocks: [],
      candidates: [
        candidate("src/a.ts", "canEdit", "src/b.ts", "mayEdit"),
        candidate("src/c.ts", "mapRow", "src/d.ts", "toRow"),
        candidate("src/a.ts", "canEdit", "src/c.ts", "mapRow"),
      ],
      clusters: [],
      partialTwins: [],
    }),
  );
  return path;
}

/** Jev's answer per pair, keyed by the two function names it was shown. */
const SCRIPT: Record<string, PairVerdict> = {
  "canEdit|mayEdit": "same_decision",
  "mapRow|toRow": "shared_helper",
  "canEdit|mapRow": "look_alike",
};

const jev = () =>
  stubJev<PairQuestions>((state: JevState) => {
    const { a, b } = state as {
      a: { function: string };
      b: { function: string };
    };
    const verdict = SCRIPT[`${a.function}|${b.function}`];
    if (verdict === undefined)
      throw new Error(`unscripted pair ${a.function}|${b.function}`);
    return {
      verdict: choice(verdict, PAIR_VERDICTS),
      business_rule: {
        type: "noul",
        noul: verdict === "same_decision" ? 0.9 : 0.1,
      },
    };
  });

describe("runPairs", () => {
  it("maps each Jev answer on a code-graph collapse pair onto the verdict union", async () => {
    const root = repo(SOURCES);
    const outPath = join(mkdtempSync(join(tmpdir(), "pairs-")), "pairs.json");
    const { rows } = await runPairs({
      root,
      ref: "HEAD",
      targets: [{ scope: "svc", collapsePath: collapseReport() }],
      jev: jev(),
      outPath,
    });

    const verdictOf = (row: PairRow) => [
      row.a.function,
      row.b.function,
      row.answers.verdict.choice,
    ];
    expect(rows.map(verdictOf).sort()).toEqual([
      ["canEdit", "mapRow", "look_alike"],
      ["canEdit", "mayEdit", "same_decision"],
      ["mapRow", "toRow", "shared_helper"],
    ]);
    expect(rows.every((r) => r.a.path.startsWith("svc/src/"))).toBe(true);
    expect(countVerdicts(rows)).toEqual({
      same_decision: 1,
      look_alike: 1,
      shared_helper: 1,
    });
    expect(JSON.parse(readFileSync(outPath, "utf8"))).toHaveLength(3);
    const markdown = renderMarkdown(rows);
    for (const verdict of PAIR_VERDICTS) {
      expect(markdown).toContain(`| ${verdict} | 1 | ${actionFor(verdict)} |`);
    }
  });

  it("reuses an answer already on file for the same two bodies", async () => {
    const root = repo(SOURCES);
    const outPath = join(mkdtempSync(join(tmpdir(), "pairs-")), "pairs.json");
    const collapsePath = collapseReport();
    const targets = [{ scope: "svc", collapsePath }];
    await runPairs({ root, ref: "HEAD", targets, jev: jev(), outPath });
    const again = jev();
    const { rows } = await runPairs({
      root,
      ref: "HEAD",
      targets,
      jev: again,
      outPath,
    });
    expect(again.asked).toHaveLength(0);
    expect(rows).toHaveLength(3);
  });
});

describe("the verdict union", () => {
  it("is the three verdicts, each with its own action", () => {
    expect([...PAIR_VERDICTS].sort()).toEqual([
      "look_alike",
      "same_decision",
      "shared_helper",
    ]);
    expect(PAIR_VERDICTS.map(actionFor)).toEqual([
      "collapse into one function",
      "keep apart",
      "extract a shared helper",
    ]);
  });
});
