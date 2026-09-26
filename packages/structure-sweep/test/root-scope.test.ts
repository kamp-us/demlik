import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JevState } from "@demlik/tea/jev";
import { describe, expect, it } from "vitest";
import { moveCommand } from "../src/move/cli.js";
import { parsePairsTarget } from "../src/pairs/cli.js";
import {
  PAIR_VERDICTS,
  type PairQuestions,
  type PairVerdict,
} from "../src/pairs/questions.js";
import type { PairRow } from "../src/pairs/report.js";
import { runPairs } from "../src/pairs/run.js";
import { proposeCommand } from "../src/propose/cli.js";
import { sweepSelection } from "../src/sweep/cli.js";
import type { FileEvidence } from "../src/sweep/evidence.js";
import type { SweepQuestions } from "../src/sweep/questions.js";
import { runSweep, type SweepRow } from "../src/sweep/run.js";
import { choice, fixtureVocabulary, repo, stubJev } from "./helpers.js";

/** Two duplicates in two different top-level folders, plus one pair inside `svc`. */
const SOURCES = {
  "package.json": JSON.stringify({ name: "mono", private: true }),
  "svc/src/a.ts": "export function canEdit(u) {\n  return u.owner;\n}\n",
  "svc/src/b.ts": "export function mayEdit(u) {\n  return u.owner;\n}\n",
  "lib/src/e.ts": "export function toBase64(s) {\n  return btoa(s);\n}\n",
  "svc/src/f.ts": "export function encode(s) {\n  return btoa(s);\n}\n",
};

const NOT_INSIDE = /is not a folder inside the repository/;

/** A realpath'd repo, so `resolve(cwd, ".")` and git's toplevel name the same directory. */
const fixture = () => realpathSync(repo(SOURCES));

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
  };
}

/** A collapse report whose candidate paths are relative to the folder it was taken over. */
function collapseReport(candidates: ReturnType<typeof candidate>[]): string {
  const path = join(mkdtempSync(join(tmpdir(), "collapse-")), "report.json");
  writeFileSync(path, JSON.stringify({ candidates }));
  return path;
}

/** What `code-graph . --collapse --json` holds: paths repo-relative, one pair across folders. */
const wholeTree = () =>
  collapseReport([
    candidate("lib/src/e.ts", "toBase64", "svc/src/f.ts", "encode"),
    candidate("svc/src/a.ts", "canEdit", "svc/src/b.ts", "mayEdit"),
  ]);

const pairsJev = () =>
  stubJev<PairQuestions>((_state: JevState) => ({
    verdict: choice<PairVerdict>("same_decision", PAIR_VERDICTS),
    business_rule: { type: "noul", noul: 0.9 },
  }));

const ledgerIn = () =>
  join(mkdtempSync(join(tmpdir(), "pairs-")), "pairs.json");

const readLedger = (path: string): PairRow[] =>
  JSON.parse(readFileSync(path, "utf8"));

describe("the repository root as a scope", () => {
  it("is admitted by pairs and sweep as `.`, from the root and from a subdirectory", () => {
    const root = fixture();
    const sub = join(root, "svc");
    expect(parsePairsTarget(root, root, ".=report.json").scope).toBe(".");
    expect(parsePairsTarget(root, sub, "..=report.json").scope).toBe(".");
    expect(sweepSelection(undefined, ["."], { root, cwd: root })).toEqual({
      scopes: ["."],
    });
    expect(sweepSelection(undefined, [".."], { root, cwd: sub })).toEqual({
      scopes: ["."],
    });
  });

  it("stays refused outside the repository, and by move and propose, while pairs and sweep admit it", () => {
    const root = fixture();
    expect(parsePairsTarget(root, root, ".=r.json").scope).toBe(".");
    expect(sweepSelection(undefined, ["."], { root, cwd: root })).toEqual({
      scopes: ["."],
    });

    expect(() => parsePairsTarget(root, root, "../other=r.json")).toThrow(
      `../other is not a folder inside the repository at ${root}`,
    );
    expect(() =>
      sweepSelection(undefined, ["../other"], { root, cwd: root }),
    ).toThrow(`../other is not a folder inside the repository at ${root}`);
    expect(() =>
      moveCommand(["plan", "--scope", ".", "--feature", "billing"], root),
    ).toThrow(`. is not a folder inside the repository at ${root}`);
    expect(() => proposeCommand(["."], root)).toThrow(NOT_INSIDE);
  });
});

describe("pairs over the whole tree", () => {
  it("keys its rows `.` and paths them repo-relative, reading each side from --ref", async () => {
    const root = fixture();
    const outPath = ledgerIn();
    const jev = pairsJev();
    const { rows } = await runPairs({
      root,
      ref: "HEAD",
      targets: [parsePairsTarget(root, root, `.=${wholeTree()}`)],
      jev,
      outPath,
    });

    expect(rows.map((r) => r.scope)).toEqual([".", "."]);
    const sides = rows.map((r) => [r.a.path, r.b.path].sort().join(" ")).sort();
    expect(sides).toEqual([
      "lib/src/e.ts svc/src/f.ts",
      "svc/src/a.ts svc/src/b.ts",
    ]);
    expect(JSON.stringify(jev.asked)).toContain(
      JSON.stringify(SOURCES["lib/src/e.ts"].trimEnd()),
    );
    expect(readLedger(outPath).map((r) => r.scope)).toEqual([".", "."]);
  });

  it("replaces its own rows on a second root run and leaves another scope's rows alone", async () => {
    const root = fixture();
    const outPath = ledgerIn();
    const svcOnly = collapseReport([
      candidate("src/a.ts", "canEdit", "src/b.ts", "mayEdit"),
    ]);
    await runPairs({
      root,
      ref: "HEAD",
      targets: [parsePairsTarget(root, root, `svc=${svcOnly}`)],
      jev: pairsJev(),
      outPath,
    });
    const svcRows = readLedger(outPath);

    const rootTarget = parsePairsTarget(root, root, `.=${wholeTree()}`);
    await runPairs({
      root,
      ref: "HEAD",
      targets: [rootTarget],
      jev: pairsJev(),
      outPath,
    });
    const narrower = collapseReport([
      candidate("lib/src/e.ts", "toBase64", "svc/src/f.ts", "encode"),
    ]);
    await runPairs({
      root,
      ref: "HEAD",
      targets: [parsePairsTarget(root, root, `.=${narrower}`)],
      jev: pairsJev(),
      outPath,
    });

    const ledger = readLedger(outPath);
    expect(ledger.filter((r) => r.scope === "svc")).toEqual(svcRows);
    expect(
      ledger
        .filter((r) => r.scope === ".")
        .map((r) => [r.a.path, r.b.path].sort()),
    ).toEqual([["lib/src/e.ts", "svc/src/f.ts"]]);
  });
});

describe("sweep over the whole tree", () => {
  it("judges every tracked source under the root and records `.` on its rows", async () => {
    const root = fixture();
    const vocabulary = fixtureVocabulary();
    const features = Object.keys(vocabulary.features);
    const roles = Object.keys(vocabulary.roles);
    const jev = stubJev<SweepQuestions>((state: JevState) => ({
      feature: choice(
        (state as FileEvidence).file.path.startsWith("lib/")
          ? "billing"
          : "audit_runs",
        features,
      ),
      role: choice("business_rule", roles),
      rule_inside_surface: { type: "noul", noul: 0.1 },
    }));
    const verdictsPath = join(
      mkdtempSync(join(tmpdir(), "verdicts-")),
      "verdicts.json",
    );
    await runSweep({
      root,
      ref: "HEAD",
      ...sweepSelection(undefined, ["."], { root, cwd: root }),
      vocabulary,
      jev,
      verdictsPath,
    });

    const rows: SweepRow[] = JSON.parse(readFileSync(verdictsPath, "utf8"));
    expect(rows.map((r) => [r.path, r.scope])).toEqual([
      ["lib/src/e.ts", "."],
      ["svc/src/a.ts", "."],
      ["svc/src/b.ts", "."],
      ["svc/src/f.ts", "."],
    ]);
  });
});
