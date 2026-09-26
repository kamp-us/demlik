import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JevState } from "@demlik/tea/jev";
import { describe, expect, it } from "vitest";
import { DEFAULTS } from "../src/cli-paths.js";
import { parseSweepArgs, SWEEP_USAGE } from "../src/sweep/cli.js";
import {
  contentHash,
  type FileEvidence,
  gatherEvidence,
} from "../src/sweep/evidence.js";
import type { GraphFacts } from "../src/sweep/graph.js";
import type { SweepQuestions } from "../src/sweep/questions.js";
import {
  EVIDENCE_EXTRACTOR,
  runSweep,
  type SweepRow,
} from "../src/sweep/run.js";
import { loadVocabulary, type Vocabulary } from "../src/vocabulary.js";
import {
  choice,
  commit,
  fixtureVocabulary,
  gitIn,
  repo,
  stubJev,
  write,
} from "./helpers.js";

function jevFor(vocabulary: Vocabulary) {
  const features = Object.keys(vocabulary.features);
  const roles = Object.keys(vocabulary.roles);
  return stubJev<SweepQuestions>(() => ({
    feature: choice("billing", features),
    role: choice("business_rule", roles),
    rule_inside_surface: { type: "noul", noul: 0.1 },
  }));
}

const verdictsIn = () =>
  join(mkdtempSync(join(tmpdir(), "verdicts-")), "out/verdicts.json");

const readRows = (path: string): SweepRow[] =>
  JSON.parse(readFileSync(path, "utf8"));

const fileOf = (state: JevState) => (state as FileEvidence).file;

/**
 * Folder and file names that spell the answer, and sources that reach each other through every
 * import form. No identifier in the code repeats a name, so any hit in the state is a leak.
 */
const TELLING = {
  "zephyr/billing/rules/invoice-limits.ts": [
    'import { z } from "zod";',
    'import { alpha } from "./tax-bands";',
    'import "../../ledger/payout-ledger";',
    'export { beta } from "../dunning/retry-policy";',
    'export * from "./tax-bands";',
    "export const gamma = z.number();",
    'export const delta = () => import("../../ledger/payout-ledger");',
    'const epsilon = require("../dunning/retry-policy");',
  ].join("\n"),
  "zephyr/billing/rules/tax-bands.ts": "export const alpha = 1;",
  "zephyr/billing/dunning/retry-policy.ts": "export const beta = 2;",
  "zephyr/ledger/payout-ledger.tsx": [
    'import { alpha } from "../billing/rules/tax-bands";',
    "export const theta = alpha;",
  ].join("\n"),
  // An installed package: the one specifier `--redact` leaves as written.
  "node_modules/zod/package.json": '{ "name": "zod", "main": "index.js" }',
  "node_modules/zod/index.js": "module.exports = {};",
};

const LEAKS = [
  "zephyr",
  "billing",
  "rules",
  "dunning",
  "ledger",
  "invoice-limits",
  "tax-bands",
  "retry-policy",
  "payout-ledger",
  "checkout-flow",
  "refund-desk",
  "../",
];

const GRAPH = new Map<string, GraphFacts>([
  [
    "zephyr/billing/rules/invoice-limits.ts",
    {
      calledFromFiles: ["checkout-flow.ts ×3", "refund-desk.ts"],
      callsFiles: ["tax-bands.ts ×2"],
      callsLibraries: ["zod"],
      entryPoints: [],
      authChecks: [],
      sideEffects: [],
      callsOtherWorkers: [],
    },
  ],
]);

async function sweepRedacted(verdictsPath = verdictsIn()) {
  const root = repo(TELLING);
  const vocabulary = fixtureVocabulary();
  const jev = jevFor(vocabulary);
  await runSweep({
    root,
    ref: "HEAD",
    scopes: ["zephyr"],
    vocabulary,
    jev,
    verdictsPath,
    graph: GRAPH,
    redact: true,
  });
  return { jev, verdictsPath };
}

describe("sweep --redact", () => {
  it("is a flag listed in the usage and off unless passed", () => {
    expect(SWEEP_USAGE).toContain("--redact");
    expect(parseSweepArgs(["src"]).values.redact).toBe(false);
    expect(parseSweepArgs(["src", "--redact"]).values.redact).toBe(true);
  });

  it("names no path, folder, relative specifier or sibling in any state Jev sees", async () => {
    const { jev } = await sweepRedacted();
    expect(jev.asked).toHaveLength(4);
    const json = JSON.stringify(jev.asked);
    for (const leak of LEAKS) expect(json).not.toContain(leak);
    expect(json).toContain('"zod"');
  });

  it("maps every import form in the source to the same opaque ids", async () => {
    const { jev } = await sweepRedacted();
    const limits = jev.asked
      .map(fileOf)
      .find((f) => f.exports.includes("gamma"));
    const [bands, policy, ledger] = ["alpha", "beta", "theta"].map(
      (name) =>
        jev.asked.map(fileOf).find((f) => f.exports.includes(name))?.path,
    );
    const id = (path = "") => path.replace(/\.tsx?$/, "");
    expect(limits?.imports).toEqual([
      "zod",
      `./${id(bands)}`,
      `./${id(ledger)}`,
      `./${id(policy)}`,
      `./${id(bands)}`,
    ]);
    expect(limits?.source).toContain(`from "./${id(policy)}";`);
    expect(limits?.source).toContain(`export * from "./${id(bands)}";`);
    expect(limits?.source).toContain(`import("./${id(ledger)}")`);
    expect(limits?.source).toContain(`require("./${id(policy)}")`);
    const bandsFile = jev.asked.map(fileOf).find((f) => f.path === bands);
    expect([...(bandsFile?.importedBySiblings ?? [])].sort()).toEqual(
      [limits?.path, limits?.path, ledger].sort(),
    );
  });

  it("keeps graph counts while hiding the file names they count", async () => {
    const { jev } = await sweepRedacted();
    const graph = jev.asked
      .map(fileOf)
      .find((f) => f.exports.includes("gamma"))?.graph;
    expect(graph?.calledFromFiles).toEqual([
      expect.stringMatching(/^g\d+\.ts ×3$/),
      expect.stringMatching(/^g\d+\.ts$/),
    ]);
    expect(graph?.callsFiles).toEqual([expect.stringMatching(/^g\d+\.ts ×2$/)]);
    expect(graph?.callsLibraries).toEqual(["zod"]);
  });

  it("shows an opaque path that keeps the extension, the same on every run", async () => {
    const first = await sweepRedacted();
    const second = await sweepRedacted();
    const paths = first.jev.asked.map((s) => fileOf(s).path).sort();
    expect(paths).toEqual([
      expect.stringMatching(/^f\d+\.ts$/),
      expect.stringMatching(/^f\d+\.ts$/),
      expect.stringMatching(/^f\d+\.ts$/),
      expect.stringMatching(/^f\d+\.tsx$/),
    ]);
    expect(new Set(paths).size).toBe(4);
    expect(second.jev.asked).toEqual(first.jev.asked);
  });

  it("records the real repo path on each redacted row", async () => {
    const { verdictsPath } = await sweepRedacted();
    expect(readRows(verdictsPath).map((r) => [r.path, r.redacted])).toEqual([
      ["zephyr/billing/dunning/retry-policy.ts", true],
      ["zephyr/billing/rules/invoice-limits.ts", true],
      ["zephyr/billing/rules/tax-bands.ts", true],
      ["zephyr/ledger/payout-ledger.tsx", true],
    ]);
  });
});

describe("sweep evidence imports", () => {
  it("reads a bare import as its own statement, and a re-export as an import that stays in the source", () => {
    const path = "zephyr/billing/rules/invoice-limits.ts";
    const text = TELLING[path];
    const file = gatherEvidence([{ path, text, hash: contentHash(text) }]).get(
      path,
    )?.file;
    expect(file?.imports).toEqual([
      "zod",
      "./tax-bands",
      "../../ledger/payout-ledger",
      "../dunning/retry-policy",
      "./tax-bands",
    ]);
    expect(file?.source).toContain(
      'export { beta } from "../dunning/retry-policy";',
    );
  });
});

describe("sweep --redact id order", () => {
  it("numbers files by code-unit order, never the host locale's collation", () => {
    const files = ["svc/a.ts", "svc/B.ts"].map((path) => {
      const text = "export const x = 1;";
      return { path, text, hash: contentHash(text) };
    });
    const evidence = gatherEvidence(files, new Map(), { redact: true });
    expect("a".localeCompare("B", "en")).toBeLessThan(0);
    expect(evidence.get("svc/B.ts")?.file.path).toBe("f1.ts");
    expect(evidence.get("svc/a.ts")?.file.path).toBe("f2.ts");
  });
});

describe("sweep cache across redaction modes", () => {
  const root = () => repo({ "svc/src/a.ts": "export const a = 1;" });

  async function sweep(
    at: { root: string; verdictsPath: string },
    redact: boolean,
  ) {
    const vocabulary = fixtureVocabulary();
    const jev = jevFor(vocabulary);
    await runSweep({
      root: at.root,
      ref: "HEAD",
      scopes: ["svc"],
      vocabulary,
      jev,
      verdictsPath: at.verdictsPath,
      redact,
    });
    return jev.asked.length;
  }

  it("never serves a default row to a redacted run, nor a redacted row to a default run", async () => {
    const at = { root: root(), verdictsPath: verdictsIn() };
    expect(await sweep(at, false)).toBe(1);
    expect(await sweep(at, true)).toBe(1);
    expect(await sweep(at, false)).toBe(1);
  });

  it("serves a redacted re-run over unchanged files entirely from cache", async () => {
    const at = { root: root(), verdictsPath: verdictsIn() };
    expect(await sweep(at, true)).toBe(1);
    expect(await sweep(at, true)).toBe(0);
  });

  it("leaves a default run's states and verdict bytes exactly as they were", async () => {
    const at = {
      root: repo({
        "svc/src/billing/price.ts":
          'import { a } from "../a";\nexport const price = a;',
        "svc/src/a.ts": "export const a = 1;",
      }),
      verdictsPath: verdictsIn(),
    };
    const vocabulary = fixtureVocabulary();
    const jev = jevFor(vocabulary);
    await runSweep({
      root: at.root,
      ref: "HEAD",
      scopes: ["svc"],
      vocabulary,
      jev,
      verdictsPath: at.verdictsPath,
    });

    expect(jev.asked).toEqual([
      {
        file: {
          path: "svc/src/a.ts",
          exports: ["a"],
          imports: [],
          importedBySiblings: ["price.ts"],
          source: "export const a = 1;",
        },
      },
      {
        file: {
          path: "svc/src/billing/price.ts",
          exports: ["price"],
          imports: ["../a"],
          importedBySiblings: [],
          source: "export const price = a;",
        },
      },
    ]);
    const answers = {
      feature: choice("billing", Object.keys(vocabulary.features)),
      role: choice("business_rule", Object.keys(vocabulary.roles)),
      rule_inside_surface: { type: "noul", noul: 0.1 },
    };
    const row = (path: string, hash: string) => ({
      path,
      scope: "svc",
      hash,
      vocabulary: vocabulary.fingerprint,
      extractor: EVIDENCE_EXTRACTOR,
      answers,
      model: "jev-stub",
      usage: { input_tokens: 10, output_tokens: 1 },
    });
    expect(readFileSync(at.verdictsPath, "utf8")).toBe(
      `${JSON.stringify(
        [
          row("svc/src/a.ts", "683314ed22112e8d"),
          row("svc/src/billing/price.ts", "6676a33b283be42a"),
        ],
        null,
        1,
      )}\n`,
    );
  });
});

describe("sweep --redact resolves aliases only against a working tree that matches --ref", () => {
  const ALIASED = {
    "tsconfig.json": JSON.stringify({
      compilerOptions: { baseUrl: ".", paths: { "@app/*": ["src/*"] } },
    }),
    "src/billing/invoice.ts": [
      'import { rate } from "@app/tax/rate";',
      "export const invoice = rate;",
    ].join("\n"),
    "src/tax/rate.ts": "export const rate = 1;",
  };

  const sweep = async (root: string, ref: string) => {
    const vocabulary = fixtureVocabulary();
    const jev = jevFor(vocabulary);
    const run = runSweep({
      root,
      ref,
      scopes: ["src"],
      vocabulary,
      jev,
      verdictsPath: verdictsIn(),
      redact: true,
    });
    return { run, jev };
  };

  it("resolves the alias to the swept file's id when the working tree matches --ref", async () => {
    const root = repo(ALIASED);
    // A source edit moves no resolution, so it does not count as a divergence.
    write(root, {
      "src/billing/invoice.ts": `${ALIASED["src/billing/invoice.ts"]}\nexport const total = 2;`,
    });
    const { run, jev } = await sweep(root, "HEAD");
    await run;
    const files = jev.asked.map(fileOf);
    const rate = files.find((f) => f.exports.includes("rate"));
    const invoice = files.find((f) => f.exports.includes("invoice"));
    expect(rate?.path).toMatch(/^f\d+\.ts$/);
    expect(invoice?.imports).toEqual([`./${rate?.path.replace(/\.ts$/, "")}`]);
  });

  it("refuses, naming the tsconfig, when --ref maps the alias differently", async () => {
    const root = repo(ALIASED);
    const ref = gitIn(root, "rev-parse", "HEAD").trim();
    write(root, {
      "tsconfig.json": JSON.stringify({
        compilerOptions: { baseUrl: ".", paths: { "@app/*": ["lib/*"] } },
      }),
      "lib/tax/rate.ts": "export const rate = 2;",
    });
    commit(root, "move the alias");
    const { run, jev } = await sweep(root, ref);
    await expect(run).rejects.toThrow(
      new RegExp(
        `differs from ${ref} in 2 path\\(s\\)[^]*added lib/tax/rate\\.ts\\n  modified tsconfig\\.json`,
      ),
    );
    expect(jev.asked).toEqual([]);
  });

  it("refuses, naming the file, when the aliased file exists at --ref but not on disk", async () => {
    const root = repo(ALIASED);
    rmSync(join(root, "src/tax/rate.ts"));
    const { run, jev } = await sweep(root, "HEAD");
    await expect(run).rejects.toThrow(/deleted src\/tax\/rate\.ts/);
    expect(jev.asked).toEqual([]);
  });

  it("refuses, naming the symlink, when a tracked symlink the alias resolves through points elsewhere", async () => {
    const root = repo({
      "tsconfig.json": ALIASED["tsconfig.json"],
      "src/billing/invoice.ts": ALIASED["src/billing/invoice.ts"],
      "rates/a/rate.ts": "export const rate = 1;",
      "rates/b/rate.ts": "export const rate = 2;",
    });
    // `@app/tax/rate` resolves through `src/tax`, which --ref points at `rates/a`.
    symlinkSync("../rates/a", join(root, "src/tax"));
    commit(root, "link the tax rates");
    rmSync(join(root, "src/tax"));
    symlinkSync("../rates/b", join(root, "src/tax"));
    expect(gitIn(root, "diff", "--name-status", "HEAD")).toBe("M\tsrc/tax\n");
    const { run, jev } = await sweep(root, "HEAD");
    await expect(run).rejects.toThrow(
      /in 1 path\(s\)[\s\S]*\n {2}retargeted src\/tax\n/,
    );
    expect(jev.asked).toEqual([]);
  });

  /** The alias `invoice` imports, read off the state Jev saw: `./fN` when it resolved. */
  const aliasOf = (jev: { asked: readonly JevState[] }) => {
    const files = jev.asked.map(fileOf);
    const rate = files.find((f) => f.exports.includes("rate"));
    const invoice = files.find((f) => f.exports.includes("invoice"));
    return { rate: rate?.path, imports: invoice?.imports };
  };

  it("runs twice over its own untracked outputs and the proposed config it reads", async () => {
    const root = repo(ALIASED);
    // Nothing ignores `.structure-sweep/`: `propose` wrote the config there, and the first run
    // writes its verdicts beside it at the default `--out`.
    write(root, {
      [DEFAULTS.proposedConfig]: readFileSync(
        join(import.meta.dirname, "fixtures/saas-audit.config.json"),
        "utf8",
      ),
    });
    const vocabularyPath = join(root, DEFAULTS.proposedConfig);
    const verdictsPath = join(root, DEFAULTS.verdicts);
    const run = async () => {
      const vocabulary = loadVocabulary(vocabularyPath);
      const jev = jevFor(vocabulary);
      await runSweep({
        root,
        ref: "HEAD",
        scopes: ["src"],
        vocabulary,
        vocabularyPath,
        jev,
        verdictsPath,
        redact: true,
      });
      return jev;
    };

    const first = aliasOf(await run());
    expect(first.rate).toMatch(/^f\d+\.ts$/);
    expect(first.imports).toEqual([`./${first.rate?.replace(/\.ts$/, "")}`]);
    expect(gitIn(root, "status", "--porcelain")).toContain(
      "?? .structure-sweep/",
    );

    // A committed source edit sends `invoice` back to Jev, so the second run resolves the alias
    // again; `.structure-sweep/` stays untracked.
    write(root, {
      "src/billing/invoice.ts": `${ALIASED["src/billing/invoice.ts"]}\nexport const total = 2;`,
    });
    gitIn(root, "add", "src/billing/invoice.ts");
    gitIn(root, "commit", "-q", "-m", "edit invoice");
    const second = await run();
    expect(second.asked).toHaveLength(1);
    const { imports } = aliasOf(second);
    expect(imports).toEqual([`./${first.rate?.replace(/\.ts$/, "")}`]);
    expect(readRows(verdictsPath).map((r) => [r.path, r.redacted])).toEqual([
      ["src/billing/invoice.ts", true],
      ["src/tax/rate.ts", true],
    ]);
  });

  it("reads an edit to the vocabulary config or to a JSON file resolution never reads as no divergence", async () => {
    const root = repo({
      ...ALIASED,
      [DEFAULTS.config]: readFileSync(
        join(import.meta.dirname, "fixtures/saas-audit.config.json"),
        "utf8",
      ),
      "src/tax/bands.json": "[1, 2]",
    });
    write(root, {
      [DEFAULTS.config]: readFileSync(
        join(import.meta.dirname, "fixtures/saas-audit.config.json"),
        "utf8",
      ).replace(/\n$/, "\n\n"),
      "src/tax/bands.json": "[1, 2, 3]",
    });
    const vocabularyPath = join(root, DEFAULTS.config);
    const vocabulary = loadVocabulary(vocabularyPath);
    const jev = jevFor(vocabulary);
    await runSweep({
      root,
      ref: "HEAD",
      scopes: ["src"],
      vocabulary,
      vocabularyPath,
      jev,
      verdictsPath: verdictsIn(),
      redact: true,
    });
    const { rate, imports } = aliasOf(jev);
    expect(imports).toEqual([`./${rate?.replace(/\.ts$/, "")}`]);
  });

  it("refuses on an edit to a tsconfig the chain extends, or to a package.json", async () => {
    const root = repo({
      ...ALIASED,
      "tsconfig.json": JSON.stringify({ extends: "./configs/base.json" }),
      "configs/base.json": JSON.stringify({
        compilerOptions: { baseUrl: "..", paths: { "@app/*": ["src/*"] } },
      }),
      "package.json": '{ "name": "app" }',
    });
    write(root, {
      "configs/base.json": JSON.stringify({
        compilerOptions: { baseUrl: "..", paths: { "@app/*": ["lib/*"] } },
      }),
      "package.json": '{ "name": "app", "imports": {} }',
    });
    const { run, jev } = await sweep(root, "HEAD");
    await expect(run).rejects.toThrow(
      /in 2 path\(s\)[\s\S]*modified configs\/base\.json\n {2}modified package\.json/,
    );
    expect(jev.asked).toEqual([]);
  });
});
