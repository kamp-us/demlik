import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { proposeCommand } from "../src/propose/cli.js";
import {
  contentSignals,
  HUB_IMPORTERS,
  identifierWords,
  MAX_CLUSTER_FILES,
  MAX_CLUSTER_TERMS,
  MAX_CLUSTERS,
  MAX_TERMS,
} from "../src/propose/content.js";
import { DEFAULT_ROLES, renderProposePrompt } from "../src/propose/prompt.js";
import { gatherSignals, type ProposeSignals } from "../src/propose/signals.js";
import { contentHash, type SourceFile } from "../src/sweep/evidence.js";
import { repo } from "./helpers.js";

const source = (path: string, text: string): SourceFile => ({
  path,
  text,
  hash: contentHash(text),
});

const promptFor = (signals: ProposeSignals) =>
  renderProposePrompt({
    signals,
    features: 8,
    roles: DEFAULT_ROLES,
    draft: ".structure-sweep/proposed.config.json",
    graphs: [],
  });

/** `pairs` two-file clusters, each exporting words of its own, plus one cluster of `big` files. */
function manyFiles(pairs: number, big: number): SourceFile[] {
  const word = (n: number) =>
    `w${String.fromCharCode(97 + (n % 26))}${String.fromCharCode(97 + Math.floor(n / 26))}`;
  const files = Array.from({ length: pairs }, (_, n) => [
    source(
      `src/p${n}/a.ts`,
      `import { ${word(n)}zBeta } from "./b";\nexport const ${word(n)}Alpha = 1;`,
    ),
    source(`src/p${n}/b.ts`, `export const ${word(n)}zBeta = 2;`),
  ]).flat();
  // One file importing every other: a star, whose leaves each have a single importer.
  const leaves = Array.from({ length: big - 1 }, (_, n) =>
    source(`src/big/m${n + 1}.ts`, `export const big${n + 1} = ${n + 1};`),
  );
  const center = source(
    "src/big/m0.ts",
    `${leaves.map((_, n) => `import { big${n + 1} } from "./m${n + 1}";`).join("\n")}\nexport const big0 = 0;`,
  );
  const chain = [center, ...leaves];
  return [...files, ...chain];
}

describe("identifierWords", () => {
  it("splits camelCase, PascalCase, snake_case and acronyms into lowercase words", () => {
    expect(identifierWords("parseHTTPReply")).toEqual([
      "parse",
      "http",
      "reply",
    ]);
    expect(identifierWords("InvoiceLineItem")).toEqual([
      "invoice",
      "line",
      "item",
    ]);
    expect(identifierWords("MAX_RETRY_COUNT")).toEqual([
      "max",
      "retry",
      "count",
    ]);
    expect(identifierWords("faturaÖdeme_v2")).toEqual([
      "fatura",
      "ödeme",
      "v2",
    ]);
  });
});

describe("contentSignals", () => {
  it("clusters files by the relative imports between them and names each by its members", () => {
    const signals = contentSignals(
      [
        source(
          "src/billing/invoice.ts",
          'import { taxRate } from "../tax/rate";\nexport function issueInvoice() {}',
        ),
        source("src/tax/rate.ts", "export const taxRate = 0.2;"),
        source(
          "src/tax/index.ts",
          'import { taxRate } from "./rate";\nexport { taxRate };',
        ),
        source(
          "src/alone.ts",
          'import { z } from "zod";\nexport const z2 = z;',
        ),
      ],
      (path) => path,
    );

    expect(signals.files).toBe(4);
    expect(signals.importClusters).toEqual({
      total: 1,
      listed: [
        {
          size: 3,
          files: [
            "src/billing/invoice.ts",
            "src/tax/index.ts",
            "src/tax/rate.ts",
          ],
          terms: ["invoice", "issue", "rate", "tax"],
        },
      ],
    });
    expect(signals.terms).toContainEqual({ term: "tax", files: 1 });
  });

  it("reads exported names written in any script whole", () => {
    const signals = contentSignals(
      [
        source("src/odeme.ts", "export class ÖdemeServisi {}"),
        source("src/kullanici.ts", "export const kullanıcıAdı = '';"),
        source("src/sehir.ts", "export function getŞehirListesi() {}"),
      ],
      (path) => path,
    );
    const terms = signals.terms.map((t) => t.term);
    for (const term of [
      "ödeme",
      "servisi",
      "kullanıcı",
      "adı",
      "şehir",
      "listesi",
    ])
      expect(terms).toContain(term);
  });

  it.each([
    'export * from "./a";',
    'export { a } from "./a";',
    'export * as ns from "./a";',
    'export type { T } from "./a";',
  ])("counts `%s` as an edge from the barrel", (reExport) => {
    const signals = contentSignals(
      [
        source("src/app.ts", 'import { a } from "./feature";'),
        source("src/feature/index.ts", reExport),
        source("src/feature/a.ts", "export const a = 1;"),
      ],
      (path) => path,
    );
    expect(signals.importClusters.listed.map((c) => c.files)).toEqual([
      ["src/app.ts", "src/feature/a.ts", "src/feature/index.ts"],
    ]);
  });

  it("joins a feature reached only through its index barrel into one cluster", () => {
    const signals = contentSignals(
      [
        source(
          "src/app.ts",
          'import { a, b } from "./feature";\nexport const app = a + b;',
        ),
        source(
          "src/feature/index.ts",
          'export * from "./a";\nexport { b } from "./b";',
        ),
        source("src/feature/a.ts", "export const a = 1;"),
        source("src/feature/b.ts", "export const b = 2;"),
      ],
      (path) => path,
    );
    expect(signals.importClusters.total).toBe(1);
    expect(signals.importClusters.listed[0]?.files).toEqual([
      "src/app.ts",
      "src/feature/a.ts",
      "src/feature/b.ts",
      "src/feature/index.ts",
    ]);
  });

  it("adds no edge for a re-export of a package, even one named like a swept file", () => {
    const signals = contentSignals(
      [
        source(
          "src/index.ts",
          'export * from "pkg";\nexport { z } from "zod";',
        ),
        source("src/pkg.ts", "export const pkg = 1;"),
        source("src/zod.ts", "export const z = 1;"),
      ],
      (path) => path,
    );
    expect(signals.importClusters.total).toBe(0);
  });

  it("does not join a hub's re-exporters through it", () => {
    const reExporters = Array.from({ length: HUB_IMPORTERS + 1 }, (_, n) =>
      source(`src/u${n}.ts`, 'export * from "./shared";'),
    );
    const signals = contentSignals(
      [...reExporters, source("src/shared.ts", "export const shared = 1;")],
      (path) => path,
    );
    expect(signals.importClusters.total).toBe(0);

    const underHub = contentSignals(
      [
        ...reExporters.slice(0, HUB_IMPORTERS),
        source("src/shared.ts", "export const shared = 1;"),
      ],
      (path) => path,
    );
    expect(underHub.importClusters.total).toBe(1);
  });

  it("does not join a hub's importers through it", () => {
    const importers = Array.from({ length: HUB_IMPORTERS + 1 }, (_, n) =>
      source(
        `src/u${n}.ts`,
        `import { shared } from "./shared";\nexport const u${n} = shared;`,
      ),
    );
    const signals = contentSignals(
      [...importers, source("src/shared.ts", "export const shared = 1;")],
      (path) => path,
    );
    expect(signals.importClusters.total).toBe(0);
  });

  it("caps every list, so more files than the caps give output of the same size", () => {
    const over = contentSignals(
      manyFiles(MAX_CLUSTERS + 5, MAX_CLUSTER_FILES + 5),
      (p) => p,
    );
    const twice = contentSignals(
      manyFiles(2 * MAX_CLUSTERS, 2 * MAX_CLUSTER_FILES),
      (p) => p,
    );

    expect(over.files).toBe(2 * (MAX_CLUSTERS + 5) + MAX_CLUSTER_FILES + 5);
    expect(over.terms).toHaveLength(MAX_TERMS);
    expect(over.importClusters.total).toBe(MAX_CLUSTERS + 6);
    expect(over.importClusters.listed).toHaveLength(MAX_CLUSTERS);
    const [largest] = over.importClusters.listed;
    expect(largest?.size).toBe(MAX_CLUSTER_FILES + 5);
    expect(largest?.files).toHaveLength(MAX_CLUSTER_FILES);
    for (const cluster of over.importClusters.listed)
      expect(cluster.terms.length).toBeLessThanOrEqual(MAX_CLUSTER_TERMS);

    const lines = (signals: typeof over) =>
      promptFor({
        ref: "HEAD",
        scopes: ["src"],
        blind: true,
        graph: null,
        content: signals,
      }).split("\n").length;
    expect(lines(twice)).toBe(lines(over));
  });
});

/** Folder segments and package names that no file's content holds. */
const HIDDEN = [
  "zorblax",
  "quimpet",
  "vornish",
  "plimsy",
  "@grendle/trask",
  "grendle",
  "trask",
  "snoffle",
];

const blindFixture = () =>
  realpathSync(
    repo({
      "package.json": JSON.stringify({ name: "snoffle" }),
      "app/package.json": JSON.stringify({ name: "@grendle/trask" }),
      "app/zorblax/plimsy.ts":
        'import { refundCharge } from "../quimpet/vornish";\nexport function issueInvoice() {}',
      "app/quimpet/vornish.ts": "export const refundCharge = () => 1;",
      "app/quimpet/index.tsx": "export const PaymentForm = () => null;",
    }),
  );

describe("propose --blind", () => {
  const read = (root: string) => [
    readFileSync(join(root, ".structure-sweep/signals.json"), "utf8"),
    readFileSync(join(root, ".structure-sweep/propose-prompt.md"), "utf8"),
  ];

  it("leaves out folders, packages and clusters, and names no hidden folder, package or file", () => {
    const root = blindFixture();
    proposeCommand(["app", "--blind"], root);
    const [json = "", prompt = ""] = read(root);

    const signals = JSON.parse(json);
    expect(Object.keys(signals)).toEqual([
      "ref",
      "scopes",
      "blind",
      "graph",
      "content",
    ]);
    expect(signals.content.importClusters.listed).toEqual([
      {
        size: 2,
        files: ["f2.ts", "f3.ts"],
        terms: ["charge", "invoice", "issue", "refund"],
      },
    ]);
    for (const text of [json, prompt])
      for (const hidden of HIDDEN)
        expect(text.toLowerCase()).not.toContain(hidden);
    expect(prompt).not.toContain("### Folders under");
    expect(prompt).not.toContain("### Workspace packages");
    expect(prompt).toContain("withheld on purpose");
    expect(prompt).toContain("### Terms in exported names");
    expect(prompt).toContain("### Files that import each other");
    expect(prompt).toContain("### Cross-runtime calls");
    expect(prompt).toContain("--redact");
  });

  it("gives byte-identical files on two runs over one checkout", () => {
    const root = blindFixture();
    proposeCommand(["app", "--blind"], root);
    const first = read(root);
    proposeCommand(["app", "--blind", "--force"], root);
    expect(read(root)).toEqual(first);
  });

  it("numbers files in code-unit order of path, not locale order", () => {
    const root = repo({
      "app/Za.ts": 'import { b } from "./Zb";\nexport const upperA = b;',
      "app/Zb.ts": "export const upperB = 1;",
      "app/aa.ts": 'import { b } from "./ab";\nexport const lowerA = b;',
      "app/ab.ts": "export const lowerB = 1;",
    });
    const signals = gatherSignals({
      root,
      ref: "HEAD",
      scopes: ["app"],
      depth: 3,
      graphs: [],
      blind: true,
    });
    const filesOf = (term: string) =>
      signals.content.importClusters.listed.find((c) => c.terms.includes(term))
        ?.files;
    expect(filesOf("upper")).toEqual(["f1.ts", "f2.ts"]);
    expect(filesOf("lower")).toEqual(["f3.ts", "f4.ts"]);
  });
});

describe("propose without --blind", () => {
  it("names the content signals' files by repo-relative path", () => {
    const root = blindFixture();
    const signals = gatherSignals({
      root,
      ref: "HEAD",
      scopes: ["app"],
      depth: 3,
      graphs: [],
    });
    expect(signals.content.importClusters.listed[0]?.files).toEqual([
      "app/quimpet/vornish.ts",
      "app/zorblax/plimsy.ts",
    ]);
    expect(promptFor(signals)).toContain("`app/zorblax/plimsy.ts`");
  });
});
