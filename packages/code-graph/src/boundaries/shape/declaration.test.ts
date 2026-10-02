import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { API, apiRepo } from "../../test-helpers/api-repo.js";
import type { BoundaryRepo } from "../../test-helpers/boundary-repo.js";
import { SHOP_TYPES, shopManifests } from "../../test-helpers/shop-workspace.js";

const B15 = "index-not-exports-only";
const B16 = "application-import-outside-allowlist";
const DRIVEN = "src/orders/adapters/driven/reads.ts";
const LIBRARIES = { libraryTypes: SHOP_TYPES, libraries: { "packages/domain-kernel": "kernel" } };

describe("the six keys are parsed at the config boundary", () => {
  let repo: BoundaryRepo;
  beforeEach(() => {
    repo = apiRepo(
      {
        [DRIVEN]: 'export const read = (env: Env) => env.DB.prepare("SELECT 1");\n',
        "src/orders/application/use.ts": "export const use = 1;\n",
        "src/orders/index.ts": "export {};\n",
        "src/main.ts": "export const main = 1;\n",
      },
      {},
      {
        ...shopManifests(["packages/domain-kernel"]),
        [`${API}/wrangler.jsonc`]: JSON.stringify({
          name: "api",
          d1_databases: [{ binding: "DB" }],
        }),
      },
    );
  });
  afterEach(() => repo.dispose());

  // The refusal every mode gives: exit 2, one line, nothing on stdout and no ledger written.
  const refused = (rules: unknown, modes: readonly object[] = [{}, { ci: true }]): string => {
    const file = path.join(repo.root, "rules.json");
    fs.writeFileSync(file, JSON.stringify(rules));
    const messages: string[] = [];
    for (const flags of [...modes, { acceptCrossings: true, reason: "x" }]) {
      const { code, errors, stdout } = repo.run({ ...flags, rules: file });
      expect(code).toBe(2);
      expect(stdout).toBe("");
      expect(errors).toHaveLength(1);
      messages.push(...errors);
    }
    expect(fs.existsSync(repo.ledgerFile)).toBe(false);
    return messages[0] ?? "";
  };

  // A rules file for `services/api`, hexagonal, with the keys under test added.
  const api = (keys: Record<string, unknown>) => ({
    features: { [API]: ["orders", "billing"] },
    layout: { [API]: "hexagonal" },
    ...keys,
  });
  const allowance = (entry: Record<string, unknown>) => ({
    ...LIBRARIES,
    readAllowance: { [API]: { driven: [DRIVEN], decidedBy: ["kernel"], ...entry } },
  });

  it("refuses a kind in applicationShape outside the two", () => {
    const message = refused(api({ applicationShape: ["export-star"] }));
    expect(message).toContain("applicationShape.0");
    expect(message).toContain(B15);
    expect(message).toContain(B16);
  });

  it("refuses applicationMayImport and pureDependencies while B16 is not listed", () => {
    const named = (key: string) =>
      `"${key}" says what B16 allows, and "applicationShape" does not list "${B16}": with that kind off, the key enforces nothing.`;
    expect(refused(api({ ...LIBRARIES, applicationMayImport: ["kernel"] }))).toBe(
      named("applicationMayImport"),
    );
    expect(refused(api({ pureDependencies: ["zod"] }))).toBe(named("pureDependencies"));
    expect(refused(api({ applicationShape: [B15], pureDependencies: ["zod"] }))).toBe(
      named("pureDependencies"),
    );
  });

  it("refuses an applicationMayImport type that libraryTypes lacks", () => {
    const rules = api({ ...LIBRARIES, applicationShape: [B16], applicationMayImport: ["ghost"] });
    expect(refused(rules)).toBe(
      '"applicationMayImport" names type "ghost", which "libraryTypes" (declared: contract, kernel, util, adapter, ui) lacks.',
    );
    expect(refused(api({ applicationShape: [B16], applicationMayImport: ["kernel"] }))).toBe(
      '"applicationMayImport" names type "kernel", which "libraryTypes" (declared: none) lacks.',
    );
  });

  it("refuses a pureDependencies or testFiles entry that is not a valid glob", () => {
    expect(refused(api({ applicationShape: [B16], pureDependencies: ["{zod"] }))).toBe(
      '"pureDependencies" entry "{zod" is not a valid glob: unclosed "{" in glob "{zod".',
    );
    expect(refused(api({ testFiles: ["**/*.{test,spec"] }))).toContain(
      '"testFiles" entry "**/*.{test,spec" is not a valid glob',
    );
    expect(refused(api({ testFiles: ["a}"] }))).toContain(
      '"testFiles" entry "a}" is not a valid glob',
    );
  });

  it("refuses a strictDriving scope that declares no features, or is not hexagonal", () => {
    expect(refused(api({ strictDriving: ["services/other"] }))).toBe(
      '"strictDriving" declares scope "services/other", which declares no "features": it rides a scope that declares features.',
    );
    const rules = { features: { [API]: ["orders"] }, strictDriving: [API] };
    expect(refused(rules)).toBe(
      `"strictDriving" declares scope "${API}", whose "layout" is not "hexagonal": it judges a hexagonal feature's zones.`,
    );
    expect(refused({ ...rules, layout: { [API]: "rules" } })).toContain(
      'whose "layout" is not "hexagonal"',
    );
  });

  it("refuses a readAllowance scope that declares no features, or is not hexagonal", () => {
    const entry = { driven: [DRIVEN], decidedBy: ["kernel"] };
    expect(refused({ ...LIBRARIES, readAllowance: { "services/other": entry } })).toBe(
      '"readAllowance" declares scope "services/other", which declares no "features": it rides a scope that declares features.',
    );
    const rules = {
      features: { [API]: ["orders"] },
      ...LIBRARIES,
      readAllowance: { [API]: entry },
    };
    expect(refused(rules)).toBe(
      `"readAllowance" declares scope "${API}", whose "layout" is not "hexagonal": it judges a hexagonal feature's zones.`,
    );
  });

  it("refuses an empty driven or decidedBy", () => {
    expect(refused(api(allowance({ driven: [] })))).toBe(
      `"readAllowance" in "${API}" lists no "driven" entry: an allowance that grants nothing.`,
    );
    expect(refused(api(allowance({ decidedBy: [] })))).toBe(
      `"readAllowance" in "${API}" lists no "decidedBy" entry: an allowance that grants nothing.`,
    );
  });

  it("refuses a decidedBy type that libraryTypes lacks", () => {
    expect(refused(api(allowance({ decidedBy: ["kernel", "ghost"] })))).toBe(
      `"readAllowance" names type "ghost" in "${API}", which "libraryTypes" (declared: contract, kernel, util, adapter, ui) lacks.`,
    );
  });

  it.each([
    ["an application/ file", "src/orders/application/use.ts"],
    ["a feature's index.ts", "src/orders/index.ts"],
    ["a driving adapter", "src/orders/adapters/driving/http.ts"],
    ["a file outside every feature", "src/main.ts"],
    ["an entry in no zone", "src/orders/helpers.ts"],
    ["a file of a feature the scope does not declare", "src/shipping/adapters/driven/x.ts"],
  ])("refuses a driven file that is %s", (_, file) => {
    expect(refused(api(allowance({ driven: [file] })))).toBe(
      `file "${file}" of "readAllowance" in "${API}" is not under a hexagonal feature's adapters/driven/: only a driven file can be read through, so a listing anywhere else could never grant.`,
    );
  });

  it("refuses a driven file the scope does not load, in every mode", () => {
    const missing = "src/orders/adapters/driven/gone.ts";
    const message = refused(api(allowance({ driven: [DRIVEN, missing] })), [
      {},
      { ci: true },
      { json: true },
    ]);
    expect(message).toBe(
      `driven file(s) of "readAllowance" in "${API}" name no file the scope loads: ${missing}. ` +
        "A listed file is an exact scope-relative .ts/.tsx path, such as src/orders/adapters/driven/order-reads.ts.",
    );
  });

  it("accepts the six keys, and a rules file that declares none", () => {
    const rules = api({
      ...allowance({}),
      applicationShape: [B15, B16],
      applicationMayImport: ["kernel"],
      pureDependencies: ["zod", "@scope/*"],
      testFiles: ["**/*.test.ts", "{test,spec}/**"],
      strictDriving: [API],
    });
    for (const keys of [rules, api({})]) {
      const file = path.join(repo.root, "ok.json");
      fs.writeFileSync(file, JSON.stringify(keys));
      const run = repo.run({ rules: file, json: true });
      expect(run.errors).toEqual([]);
      expect(run.code).toBe(0);
    }
  });
});

describe("a wrangler config the run cannot parse, with a read allowance declared", () => {
  const UNREADABLE = "not a wrangler config\n";
  const BAD = "services/other/wrangler.jsonc";
  let repo: BoundaryRepo | null = null;
  afterEach(() => repo?.dispose());

  const open = (rules: Record<string, unknown>): BoundaryRepo => {
    repo = apiRepo({ [DRIVEN]: "export const read = 1;\n" }, rules, {
      ...shopManifests(["packages/domain-kernel"]),
      [`${API}/wrangler.jsonc`]: JSON.stringify({ name: "api", d1_databases: [{ binding: "DB" }] }),
      [BAD]: UNREADABLE,
    });
    return repo;
  };
  const ALLOWANCE = {
    ...LIBRARIES,
    readAllowance: { [API]: { driven: [DRIVEN], decidedBy: ["kernel"] } },
  };

  it("refuses the report, --ci, --accept-crossings and --migrate-ceilings, naming the file", () => {
    const run = open(ALLOWANCE);
    fs.writeFileSync(run.legacyFile, JSON.stringify({ default: 0, scopes: {} }));
    for (const flags of [
      {},
      { json: true },
      { ci: true },
      { acceptCrossings: true, reason: "x" },
      { migrateCeilings: true },
    ]) {
      const refused = run.run(flags);
      expect(refused.code).toBe(2);
      expect(refused.stdout).toBe("");
      expect(refused.errors).toEqual([
        `a wrangler config cannot be parsed: ${BAD}. With "readAllowance" declared, a worker whose config is not read has no write site to see, so the allowance would grant silently: fix the file (JSON with comments, or TOML) and run again.`,
      ]);
      expect(fs.existsSync(run.ledgerFile)).toBe(false);
    }
    expect(fs.existsSync(run.legacyFile)).toBe(true);
  });

  it("names every such file", () => {
    const run = open(ALLOWANCE);
    run.put("services/third/wrangler.toml", "= nope\n");
    expect(run.run().errors[0]).toContain(`${BAD}, services/third/wrangler.toml.`);
  });

  it("is not a refusal for a rules file without a read allowance", () => {
    for (const rules of [
      {},
      { applicationShape: [B15], testFiles: ["**/*.test.ts"], strictDriving: [API] },
    ]) {
      repo?.dispose();
      const run = open(rules);
      expect(run.run({ ci: true }).code).toBe(0);
      expect(run.run().errors).toEqual([]);
    }
  });
});
