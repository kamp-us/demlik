import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { JevState } from "@demlik/tea/jev";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  contentHash,
  type FileEvidence,
  gatherEvidence,
  listSources,
  type SourceFile,
} from "../src/sweep/evidence.js";
import type { SweepQuestions } from "../src/sweep/questions.js";
import { EVIDENCE_EXTRACTOR, runSweep } from "../src/sweep/run.js";
import { choice, fixtureVocabulary, repo, stubJev } from "./helpers.js";

/** The argument list of every git subprocess spawned since the last reset. */
const spawned = vi.hoisted(() => [] as string[][]);

vi.mock("node:child_process", async (original) => {
  const real = await original<typeof import("node:child_process")>();
  const record =
    <F extends (...args: never[]) => unknown>(spawn: F) =>
    (...args: Parameters<F>) => {
      const [command, list] = args as unknown as [string, string[]];
      if (command === "git") spawned.push([...list]);
      return spawn(...args);
    };
  return {
    ...real,
    execFileSync: record(real.execFileSync),
    spawnSync: record(real.spawnSync),
  };
});

const source = (path: string, text: string): SourceFile => ({
  path,
  text,
  hash: contentHash(text),
});

const evidenceOf = (files: readonly SourceFile[]) => {
  const evidence = gatherEvidence(files);
  return (path: string) => evidence.get(path)?.file;
};

const fileOf = (state: JevState) => (state as FileEvidence).file;

const jevFor = () => {
  const vocabulary = fixtureVocabulary();
  const features = Object.keys(vocabulary.features);
  const roles = Object.keys(vocabulary.roles);
  const jev = stubJev<SweepQuestions>(() => ({
    feature: choice("billing", features),
    role: choice("business_rule", roles),
    rule_inside_surface: { type: "noul", noul: 0.1 },
  }));
  return { vocabulary, jev };
};

const verdictsIn = () =>
  join(mkdtempSync(join(tmpdir(), "verdicts-")), "verdicts.json");

describe("sweep evidence read by the parser", () => {
  it("(#441) reads a multi-line import whose bindings hold a quoted comment", () => {
    const of = evidenceOf([
      source(
        "svc/a.ts",
        [
          "import {",
          "  alpha, // don't inline",
          "  beta,",
          '} from "./x";',
          "",
          "export const gamma = alpha + beta;",
        ].join("\n"),
      ),
      source("svc/x.ts", "export const alpha = 1;\nexport const beta = 2;"),
    ]);
    expect(of("svc/a.ts")?.imports).toEqual(["./x"]);
    expect(of("svc/a.ts")?.source).toBe("export const gamma = alpha + beta;");
    expect(of("svc/x.ts")?.importedBySiblings).toEqual(["a.ts"]);
  });

  it("(#438) reads non-ASCII export names whole", () => {
    const of = evidenceOf([
      source(
        "svc/odeme.ts",
        "export class ÖdemeServisi {}\nexport const kullanıcıAdı = 1;",
      ),
    ]);
    expect(of("svc/odeme.ts")?.exports).toEqual([
      "ÖdemeServisi",
      "kullanıcıAdı",
    ]);
  });

  it("(#439) credits a barrel as the importer of every file it re-exports", () => {
    const of = evidenceOf([
      source(
        "svc/index.ts",
        [
          'export * from "./a";',
          'export { b } from "./b";',
          'export type { T } from "./t";',
        ].join("\n"),
      ),
      source("svc/a.ts", "export const a = 1;"),
      source("svc/b.ts", "export const b = 1;"),
      source("svc/t.ts", "export type T = 1;"),
    ]);
    expect(of("svc/index.ts")?.imports).toEqual(["./a", "./b", "./t"]);
    for (const path of ["svc/a.ts", "svc/b.ts", "svc/t.ts"])
      expect(of(path)?.importedBySiblings).toEqual(["index.ts"]);
  });

  // The bytes the regex reader left for the same text: a default sweep's source did not move.
  it("takes out each import's line and keeps the lines around it as they were", () => {
    const text = [
      "// header",
      'import { a } from "./a";',
      'import type { B } from "./b";',
      "",
      "export const c: B = a;",
      'import "./late";',
      "export const d = 1;",
    ].join("\n");
    const of = evidenceOf([source("svc/c.ts", text)]);
    expect(of("svc/c.ts")?.source).toBe(
      "// header\n\n\nexport const c: B = a;\n\nexport const d = 1;",
    );
  });
});

describe("(#440) listSources", () => {
  beforeEach(() => {
    spawned.length = 0;
  });

  it.each([2, 40])("reads %i files in one cat-file subprocess", (n) => {
    const root = repo(
      Object.fromEntries(
        Array.from({ length: n }, (_, i) => [
          `svc/m${i}.ts`,
          `export const m${i} = ${i};`,
        ]),
      ),
    );
    spawned.length = 0;
    const sources = listSources(root, "HEAD", "svc");
    expect(sources).toHaveLength(n);
    expect(sources[0]?.text).toBe("export const m0 = 0;");
    expect(spawned.filter((args) => args[0] === "cat-file")).toEqual([
      ["cat-file", "--batch"],
    ]);
    expect(spawned.filter((args) => args[0] === "show")).toEqual([]);
  });

  it("leaves no git show call in src/sweep", () => {
    const dir = join(import.meta.dirname, "../src/sweep");
    for (const name of readdirSync(dir))
      expect(readFileSync(join(dir, name), "utf8")).not.toContain('"show"');
  });
});

describe("sweep --redact over resolved specifiers", () => {
  const ALIASED = {
    "tsconfig.json": JSON.stringify({
      compilerOptions: { baseUrl: ".", paths: { "@app/*": ["src/*"] } },
    }),
    "src/billing/invoice.ts": [
      'import { rate } from "@app/tax/rate";',
      'import { fee } from "../tax/rate";',
      'import { z } from "zod";',
      'import { gone } from "@app/missing";',
      'import { lost } from "not-installed";',
      "export const invoice = rate + fee + gone + lost;",
      'export const lazy = () => import("@app/tax/rate");',
      'export { rate as again } from "@app/tax/rate";',
    ].join("\n"),
    "src/tax/rate.ts": "export const rate = 1;\nexport const fee = 2;",
    "node_modules/zod/package.json": '{ "name": "zod", "main": "index.js" }',
    "node_modules/zod/index.js": "module.exports = {};",
  };

  async function sweep(redact: boolean) {
    const { vocabulary, jev } = jevFor();
    await runSweep({
      root: repo(ALIASED),
      ref: "HEAD",
      scopes: ["src"],
      vocabulary,
      jev,
      verdictsPath: verdictsIn(),
      redact,
    });
    const files = jev.asked.map(fileOf);
    const byExport = (name: string) =>
      files.find((f) => f.exports.includes(name));
    return { json: JSON.stringify(jev.asked), byExport };
  }

  it("names an alias to a swept file by the same id a relative specifier naming it gets", async () => {
    const { json, byExport } = await sweep(true);
    expect(json).not.toContain("@app/");
    expect(json).not.toContain("not-installed");
    expect(json).not.toContain("tax");
    expect(json).toContain('"zod"');
    const rate = `./${byExport("rate")?.path.replace(/\.ts$/, "")}`;
    const invoice = byExport("invoice");
    const [alias, relative, zod, missing, absent, reExport] =
      invoice?.imports ?? [];
    expect([alias, relative, reExport]).toEqual([rate, rate, rate]);
    expect(zod).toBe("zod");
    expect(missing).toMatch(/^\.\/f\d+$/);
    expect(absent).toMatch(/^\.\/f\d+$/);
    expect(new Set([rate, missing, absent]).size).toBe(3);
    expect(invoice?.source).toContain(`import("${rate}")`);
    expect(invoice?.source).toContain(
      `export { rate as again } from "${rate}";`,
    );
  });

  it("gives an alias no importer credit in a default sweep", async () => {
    const { byExport } = await sweep(false);
    expect(byExport("invoice")?.imports).toEqual([
      "@app/tax/rate",
      "../tax/rate",
      "zod",
      "@app/missing",
      "not-installed",
      "@app/tax/rate",
    ]);
    expect(byExport("rate")?.importedBySiblings).toEqual(["invoice.ts"]);
  });

  it("hides every non-relative specifier when no resolver says where it leads", () => {
    const text = 'import { z } from "zod";\nexport const a = z;';
    const evidence = gatherEvidence([source("svc/a.ts", text)], new Map(), {
      redact: true,
    });
    expect(evidence.get("svc/a.ts")?.file.imports).toEqual(["./f2"]);
  });

  it("withholds the source of a file that does not parse", () => {
    const text = 'import { a } from "./secret-folder/a";\nexport const = ;';
    const evidence = gatherEvidence([source("svc/a.ts", text)], new Map(), {
      redact: true,
    });
    expect(JSON.stringify(evidence.get("svc/a.ts"))).not.toContain(
      "secret-folder",
    );
  });
});

describe("sweep verdict cache across evidence extractors", () => {
  const text = "export const a = 1;";

  async function sweepOver(extractor: number | undefined) {
    const { vocabulary, jev } = jevFor();
    const verdictsPath = verdictsIn();
    mkdirSync(dirname(verdictsPath), { recursive: true });
    const row = {
      path: "svc/a.ts",
      scope: "svc",
      hash: contentHash(text),
      vocabulary: vocabulary.fingerprint,
      ...(extractor === undefined ? {} : { extractor }),
      answers: {},
      model: "jev-stub",
      usage: { input_tokens: 10, output_tokens: 1 },
    };
    writeFileSync(verdictsPath, JSON.stringify([row]));
    await runSweep({
      root: repo({ "svc/a.ts": text }),
      ref: "HEAD",
      scopes: ["svc"],
      vocabulary,
      jev,
      verdictsPath,
    });
    return {
      asked: jev.asked.length,
      rows: JSON.parse(readFileSync(verdictsPath, "utf8")),
    };
  }

  it("re-asks a row written under the previous extractor, and records the current one", async () => {
    expect(EVIDENCE_EXTRACTOR).toBe(2);
    const stale = await sweepOver(undefined);
    expect(stale.asked).toBe(1);
    expect(stale.rows[0].extractor).toBe(EVIDENCE_EXTRACTOR);
  });

  it("serves a row written under the current extractor from cache", async () => {
    expect((await sweepOver(EVIDENCE_EXTRACTOR)).asked).toBe(0);
  });
});
