import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type BoundaryRepo, boundaryRepo } from "../../test-helpers/boundary-repo.js";
import {
  crossingsOf,
  entryLines,
  ledgerOf,
  ledgerText,
  reportOf,
  sorted,
} from "../../test-helpers/library-report.js";
import {
  SHOP_CROSSINGS,
  SHOP_PACKAGES,
  SHOP_RULES,
  SHOP_SOURCES,
  SHOP_TSCONFIG,
  shopManifests,
} from "../../test-helpers/shop-workspace.js";
import { ledgerTargetOf } from "../ledger.js";
import { MIGRATED_REASON } from "../migrate.js";

function shop(): BoundaryRepo {
  return boundaryRepo(
    ".",
    { ...shopManifests([...SHOP_PACKAGES, "services/api"]), ...SHOP_SOURCES },
    SHOP_RULES,
  );
}

describe("a repo laid out as libraries of declared types gates every rule of them", () => {
  let repo: BoundaryRepo;
  beforeEach(() => {
    repo = shop();
  });
  afterEach(() => repo.dispose());

  it("lists exactly the twelve planted crossings, and the clean files produce nothing", () => {
    const failed = repo.run({ ci: true });
    expect(failed.code).toBe(1);
    expect(entryLines(failed.stdout)).toHaveLength(12);
    expect(failed.stdout).toContain(
      "packages  B11 library-undeclared  packages/scratch -> scratch\n",
    );
    expect(failed.stdout).toContain(
      "packages/orders-contract  B12 library-imports-up  packages/orders-contract/src/index.ts" +
        ' -> packages/domain-kernel  ("@shop/domain-kernel")',
    );
    expect(failed.stdout).toContain(
      "packages/string-util  B12 library-imports-up  packages/string-util/src/x.ts" +
        ' -> packages/orders-contract  ("@shop/orders-contract/schema")',
    );
    expect(failed.stdout).toContain(
      "packages/orders-contract  B13 impure-library  packages/orders-contract/src/clock.ts -> Date.now\n",
    );
    expect(failed.stdout).toContain(
      "services/api  B14 adapter-library-imported-outside-driven  services/api/src/main.ts" +
        ' -> packages/clock-adapter  ("@shop/clock-adapter")',
    );
    expect(failed.stdout).toContain("Declare every package under a library root");
    expect(fs.existsSync(repo.ledgerFile)).toBe(false);
  });

  it("reports the same twelve with the plain view and --json, and counts the libraries", () => {
    const human = repo.run();
    expect(human.code).toBe(0);
    expect(human.stdout.split("\n").filter((line) => /^ {2}B\d+ /.test(line))).toHaveLength(12);
    expect(human.stdout).toContain(
      "libraries: 7 declared (adapter 2, contract 2, kernel 1, ui 1, util 1), 1 undeclared, " +
        "1 import left unjudged",
    );
    expect(human.stdout).toContain("  adapter: packages/clock-adapter, packages/db-adapter");
    expect(human.stdout).toContain("  undeclared: packages/scratch");
    expect(human.stdout).toContain("packages/design-ui/src/theme.ts -> packages/clock-adapter");
    expect(human.stdout).toMatch(
      /theme\.ts -> packages\/clock-adapter {2}\("[^"]+"\) {2}\[type-only\]/,
    );

    const json = repo.run({ json: true });
    expect(json.code).toBe(0);
    expect(crossingsOf(json)).toEqual(sorted(SHOP_CROSSINGS));
    expect(reportOf(json).libraries).toEqual({
      types: {
        adapter: ["packages/clock-adapter", "packages/db-adapter"],
        contract: ["packages/billing-contract", "packages/orders-contract"],
        kernel: ["packages/domain-kernel"],
        ui: ["packages/design-ui"],
        util: ["packages/string-util"],
      },
      undeclared: ["packages/scratch"],
      unjudgedImports: 1,
    });
  });

  it("records them, gates green byte for byte, fails on one new edge, and prunes as one is fixed", () => {
    const reason = "adopting library types";
    expect(repo.run({ acceptCrossings: true, reason }).code).toBe(0);
    const entries = ledgerOf(repo).entries;
    expect(entries).toHaveLength(12);
    expect(entries.every((entry) => entry.reason === reason)).toBe(true);
    expect(sorted(entries.map((e) => [e.kind, e.from, ledgerTargetOf(e)]))).toEqual(
      sorted(SHOP_CROSSINGS),
    );

    const seeded = ledgerText(repo);
    const first = repo.run({ ci: true });
    const second = repo.run({ ci: true });
    expect([first.code, second.code]).toEqual([0, 0]);
    expect(second.stdout).toBe(first.stdout);
    expect(first.stdout).toContain("12 recorded crossing(s), none new");
    expect(ledgerText(repo)).toBe(seeded);

    repo.put(
      "packages/string-util/src/y.ts",
      'import { k } from "@shop/domain-kernel";\nexport const y = k;\n',
    );
    const grown = repo.run({ ci: true });
    expect(grown.code).toBe(1);
    expect(entryLines(grown.stdout)).toEqual([
      "  packages/string-util  B12 library-imports-up  packages/string-util/src/y.ts" +
        ' -> packages/domain-kernel  ("@shop/domain-kernel")',
    ]);
    expect(ledgerText(repo)).toBe(seeded);

    expect(repo.run({ acceptCrossings: true, reason: "y reads the kernel until #1" }).code).toBe(0);
    expect(ledgerOf(repo).entries).toHaveLength(13);

    repo.put(
      "packages/orders-contract/src/index.ts",
      [
        'import { b } from "@shop/billing-contract";',
        'import { u } from "@shop/string-util";',
        'import { z } from "zod";',
        "export const o = [b, u, z];",
        "",
      ].join("\n"),
    );
    const shrunk = repo.run({ ci: true });
    expect(shrunk.code).toBe(0);
    expect(shrunk.stdout).toContain("pruned 1 boundary-ledger.json entry whose crossing is gone:");
    expect(entryLines(shrunk.stdout)).toEqual([
      "  packages/orders-contract  B12 library-imports-up  packages/orders-contract/src/index.ts" +
        ' -> packages/domain-kernel  ("@shop/domain-kernel")  — adopting library types',
    ]);
    expect(ledgerOf(repo).entries).toHaveLength(12);
    const pruned = ledgerText(repo);
    expect(repo.run({ ci: true }).code).toBe(0);
    expect(ledgerText(repo)).toBe(pruned);
  });

  it("adds the library advice only when a library kind fails", () => {
    repo.put("packages/orders-contract/src/index.ts", "export const o = 1;\n");
    expect(repo.run({ acceptCrossings: true, reason: "all of it" }).code).toBe(0);
    repo.put(
      "services/api/src/orders/application/bad.ts",
      "import '../adapters/driven/clock.js';\n",
    );
    const featureOnly = repo.run({ ci: true });
    expect(featureOnly.code).toBe(1);
    expect(featureOnly.stdout).toContain("B6 application-imports-adapter");
    expect(featureOnly.stdout).toContain("In a hexagonal feature");
    expect(featureOnly.stdout).not.toContain("Declare every package");
  });
});

describe("a repo that declares libraries and no features is judged", () => {
  let repo: BoundaryRepo;
  beforeEach(() => {
    const { libraryRoots, libraryTypes, libraries, worldLibraries } = SHOP_RULES;
    repo = boundaryRepo(
      ".",
      { ...shopManifests([...SHOP_PACKAGES, "services/api"]), ...SHOP_SOURCES },
      { libraryRoots, libraryTypes, libraries, worldLibraries },
    );
  });
  afterEach(() => repo.dispose());

  it("lists the library crossings instead of answering that there is nothing to check", () => {
    const run = repo.run();
    expect(run.code).toBe(0);
    expect(run.stdout).not.toContain("nothing to check");
    expect(crossingsOf(repo.run({ json: true }))).toEqual(
      sorted(SHOP_CROSSINGS.filter(([kind]) => kind !== "adapter-library-imported-outside-driven")),
    );
  });

  it("says a path with no feature or library scope has nothing to check", () => {
    const run = repo.run({ at: "services/api" });
    expect(run.stdout).toContain('no feature or library scope declared at or under "services/api"');
  });
});

describe("a run pointed at part of the repo measures what lies under it", () => {
  let repo: BoundaryRepo;
  beforeEach(() => {
    repo = shop();
    expect(repo.run({ acceptCrossings: true, reason: "all of it" }).code).toBe(0);
  });
  afterEach(() => repo.dispose());

  const scopesOf = (at: string): string[] =>
    reportOf(repo.run({ at, json: true })).scopes.map((s) => s.scope);

  it("measures one library, and leaves every other scope's ledger entries alone", () => {
    expect(scopesOf("packages/string-util")).toEqual(["packages/string-util"]);
    repo.put("packages/orders-contract/src/index.ts", "export const o = 1;\n");
    repo.put("packages/string-util/src/log.ts", "export const log = 1;\n");
    const before = ledgerOf(repo).entries.length;
    const run = repo.run({ at: "packages/string-util", ci: true });
    expect(run.code).toBe(0);
    expect(entryLines(run.stdout).map((line) => line.trim().split(" ")[0])).toEqual([
      "packages/string-util",
    ]);
    expect(ledgerOf(repo).entries).toHaveLength(before - 1);
    expect(
      ledgerOf(repo).entries.some((e) => e.from === "packages/orders-contract/src/index.ts"),
    ).toBe(true);
    expect(repo.run({ ci: true }).code).toBe(0);
    expect(ledgerOf(repo).entries).toHaveLength(before - 2);
  });

  it("measures every library under a library root, and under the repo root", () => {
    expect(scopesOf("packages")).toEqual([
      "packages",
      ...SHOP_PACKAGES.filter((dir) => dir !== "packages/scratch").sort(),
    ]);
    expect(scopesOf(".")).toEqual([
      "packages",
      ...SHOP_PACKAGES.filter((dir) => dir !== "packages/scratch").sort(),
      "services/api",
    ]);
  });
});

describe("--migrate-ceilings seeds the library kinds without counting them", () => {
  let repo: BoundaryRepo;
  beforeEach(() => {
    repo = shop();
    fs.writeFileSync(repo.legacyFile, JSON.stringify({ default: 0, scopes: {} }));
  });
  afterEach(() => repo.dispose());

  it("measures library scopes too and seeds all four kinds, where a count of 0 would refuse a B12", () => {
    const migrated = repo.run({ migrateCeilings: true });
    expect(migrated.errors).toEqual([]);
    expect(migrated.code).toBe(0);
    const entries = ledgerOf(repo).entries;
    expect(entries).toHaveLength(12);
    expect(entries.every((entry) => entry.reason === MIGRATED_REASON)).toBe(true);
    expect(new Set(entries.map((entry) => entry.kind))).toEqual(
      new Set([
        "library-undeclared",
        "library-imports-up",
        "impure-library",
        "adapter-library-imported-outside-driven",
      ]),
    );
    expect(fs.existsSync(repo.legacyFile)).toBe(false);
    expect(repo.run({ ci: true }).code).toBe(0);
  });

  it("still holds a scope's B1-B4, B6 and B8 import crossings against its ceiling", () => {
    repo.put(
      "services/api/src/orders/application/bad.ts",
      "import '../adapters/driven/clock.js';\n",
    );
    const refused = repo.run({ migrateCeilings: true });
    expect(refused.code).toBe(2);
    expect(refused.errors.join("\n")).toContain(
      "services/api: 1 crossing(s) against a recorded ceiling of 0",
    );
    expect(fs.existsSync(repo.ledgerFile)).toBe(false);

    fs.writeFileSync(
      repo.legacyFile,
      JSON.stringify({ default: 0, scopes: { "services/api": 1 } }),
    );
    expect(repo.run({ migrateCeilings: true }).code).toBe(0);
    expect(ledgerOf(repo).entries).toHaveLength(13);
  });
});

describe("a library nested in another is judged once, as its own scope", () => {
  it("leaves a nested library's files out of the enclosing library's scope", () => {
    const types = { util: { imports: ["util"], pure: true } };
    const repo = boundaryRepo(
      ".",
      {
        "tsconfig.json": SHOP_TSCONFIG,
        ...shopManifests(["packages/ui", "packages/ui/icons"]),
        "packages/ui/src/index.ts": "export const ui = 1;\n",
        "packages/ui/icons/src/now.ts": "export const now = Date.now();\n",
      },
      {
        libraryTypes: types,
        libraries: { "packages/ui": "util", "packages/ui/icons": "util" },
      },
    );
    try {
      expect(crossingsOf(repo.run({ json: true }))).toEqual([
        ["impure-library", "packages/ui/icons/src/now.ts", "Date.now"],
      ]);
      repo.run({ acceptCrossings: true, reason: "nested" });
      expect(ledgerOf(repo).entries.map((entry) => entry.scope)).toEqual(["packages/ui/icons"]);
    } finally {
      repo.dispose();
    }
  });
});

describe("the repo root is not a library root's neighbour", () => {
  it("never reads a scope's files when the scope is only a library root", () => {
    const repo = boundaryRepo(
      ".",
      {
        ...shopManifests(["packages/loose"]),
        "packages/loose/src/index.ts": "export const loose = 1;\n",
      },
      { libraryTypes: {}, libraryRoots: ["packages"] },
    );
    try {
      const run = repo.run({ json: true });
      expect(run.errors).toEqual([]);
      expect(reportOf(run).scopes).toEqual([
        {
          scope: "packages",
          features: [],
          filesScanned: 0,
          violations: [
            {
              kind: "library-undeclared",
              from: "packages/loose",
              to: null,
              specifier: "loose",
              typeOnly: false,
            },
          ],
        },
      ]);
    } finally {
      repo.dispose();
    }
  });
});
