import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JevState } from "@demlik/tea/jev";
import { describe, expect, it } from "vitest";
import { parseSweepArgs, SWEEP_USAGE, summaryLine } from "../src/sweep/cli.js";
import type { FileEvidence } from "../src/sweep/evidence.js";
import { currentFeature, graphNominator } from "../src/sweep/nominate.js";
import type { SweepQuestions } from "../src/sweep/questions.js";
import {
  runSweep,
  type SweepRow,
  type SweepSelection,
} from "../src/sweep/run.js";
import type { Vocabulary } from "../src/vocabulary.js";
import { choice, fixtureVocabulary, repo, stubJev } from "./helpers.js";

function jevFor(vocabulary: Vocabulary) {
  const features = Object.keys(vocabulary.features);
  const roles = Object.keys(vocabulary.roles);
  return stubJev<SweepQuestions>(() => ({
    feature: choice("billing", features),
    role: choice("business_rule", roles),
    rule_inside_surface: { type: "noul", noul: 0.1 },
  }));
}

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

const verdictsIn = () =>
  join(mkdtempSync(join(tmpdir(), "verdicts-")), "out/verdicts.json");

const fileOf = (state: JevState) => (state as FileEvidence).file;

const lines = (...body: string[]) => `${body.join("\n")}\n`;

/**
 * Feature folders `billing` and `identity` under one tsconfig. `seats.ts` sits in billing but every
 * import it makes is into identity; `lib/money.ts` sits in no feature folder and is imported only
 * from billing. Every other file's pull matches its folder, or it has neither folder nor pull.
 */
const TREE = {
  "svc/tsconfig.json": JSON.stringify({
    compilerOptions: { module: "ESNext", moduleResolution: "Bundler" },
    include: ["src"],
  }),
  "svc/src/billing/invoice.ts": lines(
    'import { rate } from "./tax";',
    'import { plan } from "./plan";',
    'import { money } from "../lib/money";',
    "export const invoice = () => money(rate * plan);",
  ),
  "svc/src/billing/tax.ts": lines("export const rate = 0.2;"),
  "svc/src/billing/plan.ts": lines("export const plan = 10;"),
  "svc/src/billing/seats.ts": lines(
    'import { session } from "../identity/session";',
    'import { user } from "../identity/user";',
    'import { token } from "../identity/token";',
    "export const seats = () => [session, user, token].length;",
  ),
  "svc/src/identity/session.ts": lines(
    'import { user } from "./user";',
    'import { token } from "./token";',
    "export const session = { user, token };",
  ),
  "svc/src/identity/user.ts": lines(
    'import { token } from "./token";',
    "export const user = { token };",
  ),
  "svc/src/identity/token.ts": lines('export const token = "t";'),
  "svc/src/lib/money.ts": lines(
    "export const money = (n: number) => n.toFixed(2);",
  ),
  "svc/src/util/format.ts": lines("export const format = String;"),
};

async function sweep(
  root: string,
  selection: SweepSelection,
  options: {
    nominated?: boolean;
    redact?: boolean;
    verdictsPath?: string;
  } = {},
) {
  const vocabulary = fixtureVocabulary();
  const jev = jevFor(vocabulary);
  const verdictsPath = options.verdictsPath ?? verdictsIn();
  const log: string[] = [];
  const result = await runSweep({
    root,
    ref: "HEAD",
    ...selection,
    vocabulary,
    jev,
    verdictsPath,
    redact: options.redact,
    ...(options.nominated === true
      ? { nominate: graphNominator(root, vocabulary, selection) }
      : {}),
    log: (line) => log.push(line),
  });
  return { jev, verdictsPath, result, log };
}

describe("a default run (no --nominated)", () => {
  it("asks the same states and writes the same verdicts.json bytes and log lines as before --nominated existed", async () => {
    const root = repo(TREE);
    const { jev, verdictsPath, log } = await sweep(root, {
      scopes: ["svc/src/billing", "svc/src/lib"],
    });
    // Digests recorded by running this test against the code before --nominated existed. The
    // verdicts digest was re-recorded once when rows gained `"extractor": 2` (#441); with those
    // lines stripped the bytes hash to the original 55ee277b….
    expect(jev.asked).toHaveLength(5);
    expect(sha(JSON.stringify(jev.asked))).toMatchInlineSnapshot(
      `"c6fed2b2a04db60661860acf42fe02a4c31e0e1e4ad5640ce755ac7e64979cc4"`,
    );
    expect(sha(readFileSync(verdictsPath, "utf8"))).toMatchInlineSnapshot(
      `"99b05c6f0a0397aa9401390b45c8d947013ab1365fc6c15e7339c51771b5f4c6"`,
    );
    expect(log).toMatchInlineSnapshot(`
      [
        "svc/src/billing: 4 files, 4 to ask",
        "svc/src/lib: 1 files, 1 to ask",
      ]
    `);
  });

  it("closes on the summary line sweep printed before --nominated existed", async () => {
    const root = repo(TREE);
    const { result } = await sweep(root, { scopes: ["svc/src/lib"] });
    expect(summaryLine(result, "out.json")).toBe(
      "1 files judged, input tokens 10 → out.json",
    );
  });
});

const nominated = { nominated: true } as const;

const askedPaths = (asked: readonly JevState[]) =>
  asked.map((s) => fileOf(s).path).sort();

/** The state Jev was asked for the file exporting `name` — exports survive redaction. */
const stateOf = (asked: readonly JevState[], name: string) =>
  asked.find((s) => fileOf(s).exports.includes(name));

describe("currentFeature", () => {
  const vocabulary = fixtureVocabulary();

  it("names the feature whose folder is the deepest matching directory segment", () => {
    expect(currentFeature(vocabulary, "svc/src/billing/seats.ts")).toBe(
      "billing",
    );
    expect(currentFeature(vocabulary, "svc/billing/src/identity/user.ts")).toBe(
      "identity",
    );
    expect(currentFeature(vocabulary, "svc/src/audit-runs/queue.ts")).toBe(
      "audit_runs",
    );
  });

  it("is null when no directory segment names a feature, whatever the file is called", () => {
    expect(currentFeature(vocabulary, "svc/src/lib/money.ts")).toBeNull();
    expect(currentFeature(vocabulary, "svc/src/billing.ts")).toBeNull();
    expect(currentFeature(vocabulary, "svc/src/audit_runs/q.ts")).toBeNull();
  });
});

describe("sweep --nominated", () => {
  it("is a flag listed in the usage, off unless passed", () => {
    expect(SWEEP_USAGE).toContain("--nominated");
    expect(parseSweepArgs(["src"]).values.nominated).toBe(false);
    expect(parseSweepArgs(["--nominated", "src"]).values.nominated).toBe(true);
  });

  it("asks only about files whose import pull disagrees with the feature folder they sit in", async () => {
    const root = repo(TREE);
    const { jev, result, log } = await sweep(
      root,
      { scopes: ["svc/src"] },
      nominated,
    );
    // seats.ts: in billing, pulled to identity. money.ts: in no feature, pulled to billing.
    // invoice/tax/plan and the identity files: pull matches folder. format.ts: neither.
    expect(askedPaths(jev.asked)).toEqual([
      "svc/src/billing/seats.ts",
      "svc/src/lib/money.ts",
    ]);
    expect(result.scopes).toEqual([
      {
        scope: "svc/src",
        files: 9,
        cached: 0,
        asked: 2,
        failed: [],
        skipped: 7,
      },
    ]);
    expect(log).toEqual([
      "svc/src: 9 files, 2 to ask, 7 skipped (not nominated)",
    ]);
    expect(summaryLine(result, "out.json")).toBe(
      "2 files judged, input tokens 20 → out.json; 7 Jev calls skipped (not nominated)",
    );
  });

  it("counts as skipped only files that were neither nominated nor cached", async () => {
    const root = repo(TREE);
    const first = await sweep(root, {
      scopes: ["svc/src/billing", "svc/src/identity"],
    });
    const { jev, result, log } = await sweep(
      root,
      { scopes: ["svc/src"] },
      { ...nominated, verdictsPath: first.verdictsPath },
    );
    // Every billing and identity file is cached; money.ts is asked; format.ts is skipped.
    expect(askedPaths(jev.asked)).toEqual(["svc/src/lib/money.ts"]);
    expect(result.scopes[0]).toMatchObject({
      files: 9,
      cached: 7,
      asked: 1,
      skipped: 1,
    });
    expect(log).toEqual([
      "svc/src: 9 files, 1 to ask, 1 skipped (not nominated)",
    ]);
    expect(summaryLine(result, "out.json")).toMatch(
      /; 1 Jev calls skipped \(not nominated\)$/,
    );
  });

  it("asks nothing over a tree with no feature folders", async () => {
    const root = repo({
      "app/tsconfig.json": TREE["svc/tsconfig.json"],
      "app/src/a.ts": lines('import { b } from "./b";', "export const a = b;"),
      "app/src/b.ts": lines("export const b = 1;"),
    });
    const { jev, result } = await sweep(
      root,
      { scopes: ["app/src"] },
      nominated,
    );
    expect(jev.asked).toEqual([]);
    expect(result.scopes[0]).toMatchObject({ files: 2, asked: 0, skipped: 2 });
  });

  it("with --redact sends each nominated file the redacted state a default run sends it, and asks nothing else", async () => {
    const root = repo(TREE);
    const plain = (await sweep(root, { scopes: ["svc/src"] }, { redact: true }))
      .jev.asked;
    const { jev, verdictsPath } = await sweep(
      root,
      { scopes: ["svc/src"] },
      { ...nominated, redact: true },
    );
    expect(jev.asked).toHaveLength(2);
    for (const name of ["seats", "money"]) {
      const state = stateOf(jev.asked, name);
      expect(state).toBeDefined();
      expect(state).toEqual(stateOf(plain, name));
      expect(fileOf(state as JevState).path).toMatch(/^f\d+\.ts$/);
    }
    expect(JSON.stringify(jev.asked)).not.toMatch(
      /svc|billing|identity|\.\.\//,
    );
    const rows: SweepRow[] = JSON.parse(readFileSync(verdictsPath, "utf8"));
    expect(rows.map((r) => [r.path, r.redacted])).toEqual([
      ["svc/src/billing/seats.ts", true],
      ["svc/src/lib/money.ts", true],
    ]);
  });

  it("with --files judges only the listed files that are nominated, over the nearest tsconfig scope's graph", async () => {
    const root = repo(TREE);
    const { jev, result, log } = await sweep(
      root,
      {
        files: [
          "svc/src/billing/seats.ts",
          "svc/src/billing/invoice.ts",
          "svc/src/lib/money.ts",
        ],
      },
      nominated,
    );
    // money.ts's only neighbour is billing/invoice.ts, outside its own folder: only a graph over
    // svc/, where tsconfig.json sits, pulls it to billing and so nominates it.
    expect(askedPaths(jev.asked)).toEqual([
      "svc/src/billing/seats.ts",
      "svc/src/lib/money.ts",
    ]);
    expect(result.scopes).toEqual([
      {
        scope: "svc/src/billing",
        files: 2,
        cached: 0,
        asked: 1,
        failed: [],
        skipped: 1,
      },
      {
        scope: "svc/src/lib",
        files: 1,
        cached: 0,
        asked: 1,
        failed: [],
        skipped: 0,
      },
    ]);
    expect(log).toEqual([
      "svc/src/billing: 2 files, 1 to ask, 1 skipped (not nominated)",
      "svc/src/lib: 1 files, 1 to ask, 0 skipped (not nominated)",
    ]);
  });

  it("over a folder, reads only that folder's graph", async () => {
    const root = repo(TREE);
    const { jev } = await sweep(root, { scopes: ["svc/src/lib"] }, nominated);
    expect(jev.asked).toEqual([]);
  });

  it("refuses a listed file with no tsconfig.json at or above it, naming its folder", async () => {
    const root = repo({ "pkg/src/billing/a.ts": lines("export const a = 1;") });
    await expect(
      sweep(root, { files: ["pkg/src/billing/a.ts"] }, nominated),
    ).rejects.toThrow(/none sits at or above pkg\/src\/billing/);
  });
});
