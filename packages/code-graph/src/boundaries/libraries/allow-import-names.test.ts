import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { type BoundaryRepo, boundaryRepo } from "../../test-helpers/boundary-repo.js";
import { clientWorkspace } from "../../test-helpers/client-workspace.js";
import {
  crossingsOf,
  entryLines,
  ledgerOf,
  ledgerText,
  reportOf,
} from "../../test-helpers/library-report.js";
import { shopManifests } from "../../test-helpers/shop-workspace.js";

const ORDERS = "packages/orders-contract";
const BILLING = "packages/billing-contract";

describe("a repo adopts the ban on direct contract imports at today's count, and the count only goes down", () => {
  it("records 180 imports, keeps the licensed names out, fails on a new one, and prunes as a name is licensed", () => {
    const workspace = clientWorkspace();
    const repo = boundaryRepo(".", workspace.files, workspace.rules);
    try {
      const report = repo.run({ json: true });
      expect(report.code).toBe(0);
      const rows = reportOf(report).scopes.flatMap((scope) => scope.violations);
      expect(rows).toHaveLength(180);
      expect(new Set(rows.map((row) => row.kind))).toEqual(new Set(["library-imports-up"]));
      expect(new Set(rows.map((row) => row.to))).toEqual(new Set([ORDERS]));
      expect(rows.map((row) => row.from).sort()).toEqual([...workspace.crossing].sort());

      const failed = repo.run({ ci: true });
      expect(failed.code).toBe(1);
      expect(entryLines(failed.stdout)).toHaveLength(180);
      expect(failed.stdout).toContain("allowImportNames");
      expect(fs.existsSync(repo.ledgerFile)).toBe(false);

      expect(repo.run({ acceptCrossings: true, reason: "adopting the typed API" }).code).toBe(0);
      expect(ledgerOf(repo).entries).toHaveLength(180);
      const seeded = ledgerText(repo);
      const first = repo.run({ ci: true });
      const second = repo.run({ ci: true });
      expect([first.code, second.code]).toEqual([0, 0]);
      expect(second.stdout).toBe(first.stdout);
      expect(first.stdout).toContain("180 recorded crossing(s), none new");
      expect(ledgerText(repo)).toBe(seeded);

      const fresh = "apps/mobile/src/orders/fresh.ts";
      repo.put(
        fresh,
        'import { OrderStatus } from "@shop/orders-contract";\nexport const fresh = OrderStatus;\n',
      );
      const grown = repo.run({ ci: true });
      expect(grown.code).toBe(1);
      expect(entryLines(grown.stdout)).toHaveLength(1);
      expect(entryLines(grown.stdout)[0]).toContain(
        `apps/mobile  B12 library-imports-up  ${fresh} -> ${ORDERS}`,
      );
      expect(ledgerText(repo)).toBe(seeded);
      repo.remove(fresh);

      fs.writeFileSync(repo.rulesFile, JSON.stringify(workspace.rulesLicensingStatus));
      const pruned = repo.run({ ci: true, json: true });
      expect(pruned.code).toBe(0);
      const result: { passed: boolean; pruned: { from: string }[] } = JSON.parse(pruned.stdout);
      const licensed = [
        ...workspace.mobileStatus.value,
        ...workspace.mobileStatus["type-only"],
        ...workspace.mobileStatus["re-export"],
      ];
      expect(result.passed).toBe(true);
      expect(result.pruned).toHaveLength(37);
      expect(result.pruned.map((entry) => entry.from).sort()).toEqual([...licensed].sort());
      const kept = ledgerOf(repo).entries;
      expect(kept).toHaveLength(143);
      expect(
        kept
          .filter((entry) => entry.scope === "apps/mobile")
          .map((entry) => entry.from)
          .sort(),
      ).toEqual([...workspace.mobileStatus.namespace].sort());
      expect(kept.filter((entry) => entry.scope !== "apps/mobile")).toHaveLength(140);
      expect(repo.run({ ci: true }).code).toBe(0);
    } finally {
      repo.dispose();
    }
  });
});

describe("what counts as a name", () => {
  const TYPES = {
    "api-contract": { imports: [], pure: true },
    contract: { imports: ["contract"], pure: true },
    client: { imports: ["contract"], pure: false },
    adapter: { imports: [], pure: false, importedFrom: ["driven"] },
  };
  const LIBRARIES = {
    [ORDERS]: "api-contract",
    [BILLING]: "contract",
    "apps/mobile": "client",
    "packages/db-adapter": "adapter",
  };
  const rulesAllowing = (names: readonly string[]) => ({
    libraryTypes: TYPES,
    libraries: LIBRARIES,
    allowImportNames: { "apps/mobile": { [ORDERS]: names } },
  });

  const SPECIFIER = '"@shop/orders-contract"';
  const SUBPATH = '"@shop/orders-contract/wire"';
  const SRC = "apps/mobile/src";

  // `[file, source]` of the files that take only names the allowance `A, B` lists, or no name of the
  // library at all.
  const LICENSED: readonly (readonly [string, string])[] = [
    ["plain", `import { A } from ${SPECIFIER};`],
    ["alias", `import { A as Local } from ${SPECIFIER};`],
    ["inline-type", `import { type A } from ${SPECIFIER};`],
    ["type-only", `import type { A } from ${SPECIFIER};`],
    ["re-export", `export { A } from ${SPECIFIER};`],
    ["both", `import { A, B } from ${SPECIFIER};`],
    ["subpaths", `import { A } from ${SPECIFIER};\nimport { B } from ${SUBPATH};`],
    ["relative", 'import { plain } from "./plain";'],
    ["billing", 'import { c } from "@shop/billing-contract";'],
  ];

  // The files that take a name the allowance `A, B` does not list.
  const UNLICENSED: readonly (readonly [string, string])[] = [
    ["mixed", `import { A, Z } from ${SPECIFIER};`],
    ["mixed-subpaths", `import { A } from ${SPECIFIER};\nimport { Z } from ${SUBPATH};`],
    ["unlicensed-type", `import type { Z } from ${SPECIFIER};`],
  ];

  // The files that take a name no one can read, so no allowance licenses them.
  const UNREADABLE: readonly (readonly [string, string])[] = [
    ["namespace", `import * as ns from ${SPECIFIER};`],
    ["default", `import def from ${SPECIFIER};`],
    ["star", `export * from ${SPECIFIER};`],
    ["dynamic", `export const load = () => import(${SPECIFIER});`],
    ["side-effect", `import ${SPECIFIER};`],
    ["equals", `import contract = require(${SPECIFIER});`],
    ["default-and-licensed", `import def, { A } from ${SPECIFIER};`],
    ["subpath-star-and-licensed", `import { A } from ${SPECIFIER};\nexport * from ${SUBPATH};`],
  ];

  const sourcesOf = (...groups: (readonly (readonly [string, string])[])[]) =>
    Object.fromEntries(
      groups.flat().map(([name, source]) => [`${SRC}/${name}.ts`, `${source}\nexport {};\n`]),
    );

  const files = {
    ...shopManifests([ORDERS, BILLING, "apps/mobile", "packages/db-adapter"]),
    [`${ORDERS}/src/index.ts`]: "export const A = 1, B = 2, Z = 3;\n",
    [`${BILLING}/src/index.ts`]: "export const c = 1;\n",
    ...sourcesOf(LICENSED, UNLICENSED, UNREADABLE),
  };

  let repo: BoundaryRepo;
  afterEach(() => repo.dispose());

  const rowsUnder = (names: readonly string[]): string[] => {
    repo = boundaryRepo(".", files, rulesAllowing(names));
    return crossingsOf(repo.run({ json: true })).map(([kind, from, to]) => {
      expect(kind).toBe("library-imports-up");
      expect(to).toBe(ORDERS);
      return from.replace(`${SRC}/`, "").replace(".ts", "");
    });
  };
  const named = (...groups: (readonly (readonly [string, string])[])[]): string[] =>
    groups
      .flat()
      .map(([name]) => name)
      .sort();

  it("is one row per importing file, however many names, specifiers or subpaths it writes", () => {
    expect(rowsUnder(["A", "B"]).sort()).toEqual(named(UNLICENSED, UNREADABLE));
  });

  it("licenses a file only when the allowance lists every name it takes, summed over its imports", () => {
    expect(rowsUnder(["A", "B", "Z"]).sort()).toEqual(named(UNREADABLE));
    expect(rowsUnder(["A"]).sort()).toEqual(
      [...named(UNLICENSED, UNREADABLE), "both", "subpaths"].sort(),
    );
  });

  it("lists the first specifier written, and type-only only when every import of the library is", () => {
    repo = boundaryRepo(".", files, rulesAllowing(["A", "B"]));
    const rows = reportOf(repo.run({ json: true })).scopes.flatMap((scope) => scope.violations);
    expect(rows.find((row) => row.from.endsWith("/mixed-subpaths.ts"))).toMatchObject({
      specifier: "@shop/orders-contract",
      typeOnly: false,
    });
    expect(rows.find((row) => row.from.endsWith("/unlicensed-type.ts"))).toMatchObject({
      typeOnly: true,
    });
  });

  it("licenses nothing for an importer the rules file gives no allowance", () => {
    repo = boundaryRepo(".", files, { ...rulesAllowing(["A"]), allowImportNames: {} });
    const rows = crossingsOf(repo.run({ json: true })).map(([, from]) => from);
    const every = named(LICENSED, UNLICENSED, UNREADABLE).filter(
      (name) => name !== "relative" && name !== "billing",
    );
    expect(rows.map((from) => from.replace(`${SRC}/`, "").replace(".ts", "")).sort()).toEqual(
      every.sort(),
    );
  });

  it("waives B12 and leaves the target type's `importedFrom` to B14", () => {
    repo = boundaryRepo(
      ".",
      {
        ...files,
        "packages/db-adapter/src/index.ts": "export const query = 1;\n",
        [`${SRC}/query.ts`]: 'import { query } from "@shop/db-adapter";\nexport { query };\n',
      },
      {
        ...rulesAllowing(["A", "B", "Z"]),
        allowImportNames: {
          "apps/mobile": { [ORDERS]: ["A", "B", "Z"], "packages/db-adapter": ["query"] },
        },
      },
    );
    const rows = crossingsOf(repo.run({ json: true })).filter(([, from]) =>
      from.endsWith("query.ts"),
    );
    expect(rows).toEqual([
      ["adapter-library-imported-outside-driven", `${SRC}/query.ts`, "packages/db-adapter"],
    ]);
  });
});

describe("an allowance that enforces nothing is refused at load", () => {
  const TYPES = {
    "api-contract": { imports: [], pure: true },
    contract: { imports: ["contract"], pure: true },
    client: { imports: ["contract", "api-contract"], pure: false },
    plain: { imports: ["contract"], pure: false },
  };
  const LIBRARIES = {
    [ORDERS]: "api-contract",
    [BILLING]: "contract",
    "apps/mobile": "plain",
    "apps/console": "client",
  };
  const files = {
    ...shopManifests([ORDERS, BILLING, "apps/mobile", "apps/console"]),
    [`${ORDERS}/src/index.ts`]: "export const A = 1;\n",
    [`${BILLING}/src/index.ts`]: "export const c = 1;\n",
    "apps/mobile/src/a.ts": 'import { A } from "@shop/orders-contract";\nexport { A };\n',
    "apps/console/src/a.ts": 'import { A } from "@shop/orders-contract";\nexport { A };\n',
    "apps/mobile/src/b.ts": 'import { c } from "@shop/billing-contract";\nexport { c };\n',
  };

  let repo: BoundaryRepo;
  afterEach(() => repo.dispose());

  const rulesWith = (allowImportNames: unknown) => ({
    libraryTypes: TYPES,
    libraries: LIBRARIES,
    allowImportNames,
  });

  // The refusal every mode gives: exit 2, one line, nothing on stdout and no ledger written.
  const refused = (allowImportNames: unknown): string => {
    repo = boundaryRepo(".", files, rulesWith(allowImportNames));
    const messages = [{}, { ci: true }, { acceptCrossings: true, reason: "r" }].map((flags) => {
      const { code, errors, stdout } = repo.run(flags);
      expect(code).toBe(2);
      expect(stdout).toBe("");
      expect(errors).toHaveLength(1);
      return errors[0] ?? "";
    });
    expect(new Set(messages).size).toBe(1);
    expect(fs.existsSync(repo.ledgerFile)).toBe(false);
    return messages[0] ?? "";
  };

  it("accepts an allowance for a library whose type its importer's type does not list", () => {
    repo = boundaryRepo(".", files, rulesWith({ "apps/mobile": { [ORDERS]: ["A"] } }));
    const run = repo.run({ ci: true });
    expect(run.errors).toEqual([]);
    expect(run.code).toBe(0);
  });

  it("refuses an importer that is no declared library", () => {
    expect(refused({ "apps/ghost": { [ORDERS]: ["A"] } })).toBe(
      'allowImportNames importer "apps/ghost" is no declared library: add it to "libraries".',
    );
  });

  it("refuses an imported library that is no declared library", () => {
    expect(refused({ "apps/mobile": { "packages/ghost": ["A"] } })).toBe(
      'allowImportNames "apps/mobile" licenses names of "packages/ghost", which is no declared library: add it to "libraries".',
    );
  });

  it("refuses an importer whose type already lists the imported library's type", () => {
    expect(refused({ "apps/console": { [ORDERS]: ["A"] } })).toBe(
      `allowImportNames "apps/console" licenses names of "${ORDERS}", but its type "client" already lists "api-contract" in "imports": the allowance would enforce nothing.`,
    );
    expect(refused({ "apps/mobile": { [BILLING]: ["c"] } })).toContain(
      'but its type "plain" already lists "contract"',
    );
  });

  it("refuses a name the importer never imports from that library", () => {
    expect(refused({ "apps/mobile": { [ORDERS]: ["A", "Ghost"] } })).toBe(
      `allowImportNames "apps/mobile" licenses "Ghost" of "${ORDERS}", which "apps/mobile" never imports from it: remove the name.`,
    );
  });

  it("licenses no wildcard: `*` is a name the importer never imports", () => {
    expect(refused({ "apps/mobile": { [ORDERS]: ["*"] } })).toContain('licenses "*"');
  });

  it("refuses a name the importer imports only from another library", () => {
    expect(refused({ "apps/mobile": { [ORDERS]: ["c"] } })).toContain('licenses "c"');
  });

  it("refuses an empty list of names and an empty name at the config boundary", () => {
    expect(refused({ "apps/mobile": { [ORDERS]: [] } })).toContain(
      `allowImportNames.apps/mobile.${ORDERS}`,
    );
    expect(refused({ "apps/mobile": { [ORDERS]: [""] } })).toContain("allowImportNames");
  });
});
