import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { type BoundaryRepo, boundaryRepo } from "../../test-helpers/boundary-repo.js";
import {
  crossingsOf,
  entryLines,
  ledgerOf,
  ledgerText,
  reportOf,
  sorted,
} from "../../test-helpers/library-report.js";
import { SHOP_TSCONFIG, shopManifests } from "../../test-helpers/shop-workspace.js";
import { ledgerTargetOf } from "../ledger.js";
import { MIGRATED_REASON } from "../migrate.js";

const B20 = "test-reaches-composition-root";
const SHOP = "services/shop";
const at = (rel: string): string => `${SHOP}/${rel}`;
const lines = (...source: string[]): string => `${source.join("\n")}\n`;

let repo: BoundaryRepo | null = null;
afterEach(() => repo?.dispose());

function open(files: Record<string, string>, rules: Record<string, unknown>): BoundaryRepo {
  repo?.dispose();
  repo = boundaryRepo(".", { ...shopManifests([SHOP]), ...files }, rules);
  return repo;
}

describe("a repo that loads the whole app from its tests adopts B20 at today's count", () => {
  const FEATURES = ["orders", "billing", "catalog"];
  const HARNESS = at("src/test-support/harness.ts");
  const SERVER = at("src/test-support/server.ts");
  const SCHEMA = at("src/schema.ts");
  const INDEX = at("src/index.ts");
  const RULES = {
    features: { [SHOP]: FEATURES },
    testFiles: ["**/*.test.ts", "**/test-support/**"],
    compositionRoots: ["src/index.ts", "src/schema.ts"],
  };
  const caseNumber = (n: number): string => String(n).padStart(3, "0");
  const featureOf = (n: number): string => FEATURES[Math.floor(n / 40) % FEATURES.length] ?? "";
  const caseFile = (n: number): string =>
    at(`src/${featureOf(n - 1)}/application/case-${caseNumber(n)}.test.ts`);

  function shop(): Record<string, string> {
    const files: Record<string, string> = {
      [INDEX]: lines('import { schema } from "./schema";', "export default schema;"),
      [SCHEMA]: lines(
        ...FEATURES.map((f) => `import { ${f}Use } from "./${f}/index";`),
        `export const schema = [${FEATURES.map((f) => `${f}Use`).join(", ")}];`,
        "export type Schema = typeof schema;",
      ),
      [HARNESS]: lines('import { server } from "./server";', "export const harness = server;"),
      [SERVER]: lines('import { schema } from "../schema";', "export const server = schema;"),
      [at("src/index.test.ts")]: lines('import worker from "./index";', "export const t = worker;"),
      [at("src/lib/boot.ts")]: lines(
        'import { schema } from "../schema";',
        "export const boot = schema;",
      ),
      [at("src/orders/application/type-only.test.ts")]: lines(
        'import type { Schema } from "../../schema";',
        "export type T = Schema;",
      ),
      [at("src/orders/application/inline-type.test.ts")]: lines(
        'import { type Schema } from "../../schema";',
        "export type T = Schema;",
      ),
    };
    for (const f of FEATURES) {
      files[at(`src/${f}/index.ts`)] = `export { ${f}Use } from "./application/use";\n`;
      files[at(`src/${f}/application/use.ts`)] = `export const ${f}Use = () => "${f}";\n`;
    }
    for (let n = 1; n <= 120; n++) {
      files[caseFile(n)] = lines(
        'import { harness } from "../../test-support/harness";',
        "export const t = harness;",
      );
    }
    for (let n = 1; n <= 100; n++) {
      const f = FEATURES[n % FEATURES.length] ?? "";
      files[at(`src/${f}/application/unit-${caseNumber(n)}.test.ts`)] = lines(
        `import { ${f}Use } from "./use";`,
        `export const t = [${f}Use, ${n}];`,
      );
    }
    return files;
  }

  const planted = (): string[][] => [
    ...Array.from({ length: 120 }, (_, i) => [B20, caseFile(i + 1), HARNESS]),
    [B20, HARNESS, SERVER],
    [B20, SERVER, SCHEMA],
    [B20, at("src/index.test.ts"), INDEX],
  ];

  it("lists the 123 tests and helpers that load the app, gates them, and prunes a fixed helper's whole chain", () => {
    const shopRepo = open(shop(), RULES);
    expect(crossingsOf(shopRepo.run({ json: true }))).toEqual(sorted(planted()));

    const failed = shopRepo.run({ ci: true });
    expect(failed.code).toBe(1);
    expect(entryLines(failed.stdout)).toHaveLength(123);
    expect(failed.stdout).toContain("A test drives the one feature under test");

    expect(shopRepo.run({ acceptCrossings: true, reason: "legacy" }).code).toBe(0);
    expect(ledgerOf(shopRepo).entries).toHaveLength(123);
    const seeded = ledgerText(shopRepo);
    expect([shopRepo.run({ ci: true }).code, shopRepo.run({ ci: true }).code]).toEqual([0, 0]);
    expect(ledgerText(shopRepo)).toBe(seeded);

    const newTest = at("src/catalog/application/case-121.test.ts");
    shopRepo.put(
      newTest,
      lines('import { harness } from "../../test-support/harness";', "export const t = harness;"),
    );
    const grown = shopRepo.run({ ci: true });
    expect(grown.code).toBe(1);
    expect(entryLines(grown.stdout)).toEqual([expect.stringContaining(`${newTest} -> ${HARNESS}`)]);

    shopRepo.remove(newTest);
    shopRepo.put(SERVER, lines("export const server = 1;"));
    const fixed = shopRepo.run({ ci: true });
    expect(fixed.code).toBe(0);
    expect(fixed.stdout).toContain(
      "pruned 122 boundary-ledger.json entries whose crossing is gone",
    );
    expect(ledgerOf(shopRepo).entries.map((e) => [e.kind, e.from, ledgerTargetOf(e)])).toEqual([
      [B20, at("src/index.test.ts"), INDEX],
    ]);
  });

  it("is off without compositionRoots: no B20, and nothing new in the report", () => {
    const { compositionRoots: _roots, ...without } = RULES;
    const off = open(shop(), without).run({ json: true });
    expect(crossingsOf(off)).toEqual([]);
    expect(off.stdout).not.toContain("composition");
  });
});

// What a test opens when it runs, one snippet per case. The scope has the roots `src/root.ts` and
// `src/test-support/app.ts` (a root that is also a test file), and every case writes `src/a.test.ts`.
const ROOTS = {
  features: { [SHOP]: ["orders"] },
  testFiles: ["**/*.test.ts", "src/test-support/**"],
  compositionRoots: ["src/root.ts", "src/test-support/app.ts"],
};
const BASE: Record<string, string> = {
  "src/orders/index.ts": "export {};\n",
  "src/root.ts": "export const root = 1;\nexport type Root = number;\n",
};
const SUPPORT: Record<string, string> = {
  ...BASE,
  "src/test-support/app.ts": lines('import { root } from "../root";', "export const app = root;"),
  "services/other/src/root.ts": "export const root = 2;\n",
};
const scoped = (files: Record<string, string>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(files).map(([rel, body]) => [rel.startsWith("src/") ? at(rel) : rel, body]),
  );
const scopeSupport = (): Record<string, string> => scoped(SUPPORT);
const TEST = (...imports: string[]): string => lines(...imports, "export const t = 1;");
const STATIC = 'import { root } from "./root";';

type Case = {
  readonly name: string;
  readonly files: Record<string, string>;
  readonly rows: readonly (readonly [from: string, to: string])[];
};

const CASES: readonly Case[] = [
  {
    name: "follows a static import of a root",
    files: { "src/a.test.ts": TEST(STATIC) },
    rows: [["src/a.test.ts", "src/root.ts"]],
  },
  {
    name: "follows an `export … from` barrel, reporting the barrel",
    files: {
      "src/barrel.ts": 'export { root } from "./root";\n',
      "src/a.test.ts": TEST('import { root } from "./barrel";'),
    },
    rows: [["src/a.test.ts", "src/barrel.ts"]],
  },
  {
    name: "follows a dynamic import() of a root",
    files: { "src/a.test.ts": 'export const load = () => import("./root");\n' },
    rows: [["src/a.test.ts", "src/root.ts"]],
  },
  {
    name: "reports the first helper on the way to a root, and not the helper's own import",
    files: {
      "src/helper.ts": lines(STATIC, "export const h = root;"),
      "src/a.test.ts": TEST('import { h } from "./helper";'),
    },
    rows: [["src/a.test.ts", "src/helper.ts"]],
  },
  {
    name: "reports a helper a testFiles glob matches for its own first file, and every test of it",
    files: {
      "src/test-support/helper.ts": lines(
        'import { root } from "../root";',
        "export const h = root;",
      ),
      "src/a.test.ts": TEST('import { h } from "./test-support/helper";'),
    },
    rows: [
      ["src/test-support/helper.ts", "src/root.ts"],
      ["src/a.test.ts", "src/test-support/helper.ts"],
    ],
  },
  {
    name: "reports a root that is also a test file for nothing, and its importers for it",
    files: { "src/a.test.ts": TEST('import { app } from "./test-support/app";') },
    rows: [["src/a.test.ts", "src/test-support/app.ts"]],
  },
  {
    name: "ends on a cycle among helpers, reporting each helper that reaches a root once",
    files: {
      "src/h1.ts": lines('import { h2 } from "./h2";', "export const h1 = h2;"),
      "src/h2.ts": lines('import { h1 } from "./h1";', STATIC, "export const h2 = [h1, root];"),
      "src/a.test.ts": TEST('import { h1 } from "./h1";', 'import { h2 } from "./h2";'),
    },
    rows: [
      ["src/a.test.ts", "src/h1.ts"],
      ["src/a.test.ts", "src/h2.ts"],
    ],
  },
  {
    name: "ends on a cycle that reaches no root, with nothing reported",
    files: {
      "src/c1.ts": lines('import { c2 } from "./c2";', "export const c1 = c2;"),
      "src/c2.ts": lines('import { c1 } from "./c1";', "export const c2 = c1;"),
      "src/a.test.ts": TEST('import { c1 } from "./c1";'),
    },
    rows: [],
  },
  {
    name: "reports a target once when one import of it is type-only and another is not",
    files: { "src/a.test.ts": TEST('import type { Root } from "./root";', STATIC) },
    rows: [["src/a.test.ts", "src/root.ts"]],
  },
  {
    name: "does not follow `import type`",
    files: { "src/a.test.ts": TEST('import type { Root } from "./root";') },
    rows: [],
  },
  {
    name: "does not follow `import { type X }`",
    files: { "src/a.test.ts": TEST('import { type Root } from "./root";') },
    rows: [],
  },
  {
    name: "does not follow `export { type X } from`",
    files: { "src/a.test.ts": 'export { type Root } from "./root";\n' },
    rows: [],
  },
  {
    name: "does not follow a type-position import()",
    files: { "src/a.test.ts": 'export type T = import("./root").Root;\n' },
    rows: [],
  },
  {
    name: "does not follow an import that resolves to no file the scope loads",
    files: { "src/a.test.ts": TEST('import { root } from "../../other/src/root";') },
    rows: [],
  },
  {
    name: "never reports a file that is not a test",
    files: { "src/boot.ts": lines(STATIC, "export const boot = root;") },
    rows: [],
  },
];

describe("B20 reads what a test opens when it runs", () => {
  it.each(CASES)("$name", ({ files, rows }) => {
    const run = open({ ...scopeSupport(), ...scoped(files) }, ROOTS).run({ json: true });
    expect(crossingsOf(run)).toEqual(sorted(rows.map(([from, to]) => [B20, at(from), at(to)])));
  });
});

describe("a B20 entry is keyed by the test and its first file", () => {
  const HELPERS = (helpers: readonly string[]): Record<string, string> => ({
    ...Object.fromEntries(
      helpers.map((h) => [at(`src/${h}.ts`), lines(STATIC, `export const ${h} = root;`)]),
    ),
    [at("src/a.test.ts")]: TEST(...helpers.map((h) => `import { ${h} } from "./${h}";`)),
  });

  it("gives a test with two routes two entries, and each route change touches only its own", () => {
    const run = open({ ...scopeSupport(), ...HELPERS(["h1", "h2"]) }, ROOTS);
    expect(run.run({ acceptCrossings: true, reason: "two routes" }).code).toBe(0);
    expect(ledgerOf(run).entries.map(ledgerTargetOf)).toEqual([at("src/h1.ts"), at("src/h2.ts")]);

    run.put(at("src/h2.ts"), "export const h2 = 1;\n");
    const pruned = run.run({ ci: true });
    expect(pruned.code).toBe(0);
    expect(pruned.stdout).toContain("pruned 1 boundary-ledger.json entry whose crossing is gone");
    expect(ledgerOf(run).entries.map(ledgerTargetOf)).toEqual([at("src/h1.ts")]);

    for (const [rel, body] of Object.entries(HELPERS(["h1", "h3"]))) run.put(rel, body);
    const grown = run.run({ ci: true });
    expect(grown.code).toBe(1);
    expect(entryLines(grown.stdout)).toEqual([
      expect.stringContaining(`${at("src/a.test.ts")} -> ${at("src/h3.ts")}`),
    ]);
  });
});

describe("compositionRoots matches as testFiles does", () => {
  const files = (): Record<string, string> =>
    scoped({
      ...BASE,
      "src/a.test.ts": TEST(STATIC),
    });
  const rows = [[B20, at("src/a.test.ts"), at("src/root.ts")]];

  it.each([
    ["a scope-relative path", "src/root.ts"],
    ["a repo-relative path", "services/*/src/root.ts"],
  ])("matches %s in a worker scope", (_, glob) => {
    const run = open(files(), { ...ROOTS, compositionRoots: [glob] }).run({ json: true });
    expect(crossingsOf(run)).toEqual(rows);
  });

  it("reads the two as one path at scope `.`", () => {
    repo?.dispose();
    repo = boundaryRepo(
      ".",
      {
        "tsconfig.json": SHOP_TSCONFIG,
        "src/orders/index.ts": "export {};\n",
        "src/root.ts": "export const root = 1;\n",
        "src/a.test.ts": TEST(STATIC),
      },
      {
        features: { ".": ["orders"] },
        testFiles: ["**/*.test.ts"],
        compositionRoots: ["src/root.ts"],
      },
    );
    expect(crossingsOf(repo.run({ json: true }))).toEqual([[B20, "src/a.test.ts", "src/root.ts"]]);
  });
});

describe("the report and the migration carry B20 like the kinds before it", () => {
  it("prints the plain view as the rule, the test, the first file and the specifier as written", () => {
    const run = open({ ...scopeSupport(), [at("src/a.test.ts")]: TEST(STATIC) }, ROOTS);
    expect(run.run().stdout).toContain(
      `  B20 ${B20} ${at("src/a.test.ts")} -> ${at("src/root.ts")}  ("./root")`,
    );
    const [violation] = reportOf(run.run({ json: true })).scopes.flatMap((s) => s.violations);
    expect(violation).toMatchObject({ kind: B20, specifier: "./root", typeOnly: false });
  });

  it("seeds a B20 crossing with the grandfathered reason where a counted kind would refuse", () => {
    const run = open({ ...scopeSupport(), [at("src/a.test.ts")]: TEST(STATIC) }, ROOTS);
    fs.writeFileSync(run.legacyFile, JSON.stringify({ default: 0, scopes: {} }));
    expect(run.run({ migrateCeilings: true }).code).toBe(0);
    expect(ledgerOf(run).entries).toEqual([
      expect.objectContaining({ kind: B20, reason: MIGRATED_REASON }),
    ]);
    expect(fs.existsSync(run.legacyFile)).toBe(false);
    expect(run.run({ ci: true }).code).toBe(0);
  });
});
