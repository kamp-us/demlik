import { afterEach, describe, expect, it } from "vitest";
import { API, apiRepo, at } from "../../test-helpers/api-repo.js";
import type { BoundaryRepo } from "../../test-helpers/boundary-repo.js";
import { entryLines, ledgerOf, reportOf } from "../../test-helpers/library-report.js";
import { SHOP_TYPES, shopManifests } from "../../test-helpers/shop-workspace.js";
import type { BoundaryViolation } from "../violation.js";

const B8 = "driving-reaches-driven";
const DRIVEN = "src/orders/adapters/driven/reads.ts";
const HTTP = "src/orders/adapters/driving/http.ts";

const LIBRARIES = { "packages/domain-kernel": "kernel", "packages/string-util": "util" };
const WORKER = {
  ...shopManifests([...Object.keys(LIBRARIES)]),
  [`${API}/wrangler.jsonc`]: JSON.stringify({
    name: "api",
    d1_databases: [{ binding: "DB" }],
    kv_namespaces: [{ binding: "CACHE" }],
    r2_buckets: [{ binding: "ASSETS" }],
    queues: { producers: [{ binding: "EVENTS" }] },
    durable_objects: { bindings: [{ name: "COUNTER", class_name: "Counter" }] },
  }),
};
const RULES = {
  libraryTypes: SHOP_TYPES,
  libraries: LIBRARIES,
  readAllowance: { [API]: { driven: [DRIVEN], decidedBy: ["kernel"] } },
};

const KERNEL = 'import { total } from "@shop/domain-kernel";\n';
const READ = 'import { read } from "../driven/reads";\n';
const USE = "export const handle = [read];\n";

let repo: BoundaryRepo | null = null;
afterEach(() => repo?.dispose());

type Row = BoundaryViolation & { write?: { file: string; line: number; binding: string } };

function b8(
  files: Record<string, string>,
  rules: Record<string, unknown> = RULES,
  from: string = HTTP,
): Row[] {
  repo = apiRepo(files, rules, WORKER);
  return reportOf(repo.run({ json: true }))
    .scopes.flatMap((scope) => scope.violations as Row[])
    .filter((v) => v.kind === B8 && v.from === at(from));
}

const reads = (body: string) => ({ [DRIVEN]: `${body}\n` });
const SELECT = 'export const read = (env: Env) => env.DB.prepare("SELECT id FROM orders");';

describe("a read allowance lets a driving adapter read through a listed driven file", () => {
  it("leaves B8 as it is for a scope with no allowance and for a driven file it does not list", () => {
    const files = { ...reads(SELECT), [HTTP]: `${KERNEL}${READ}${USE}` };
    expect(b8(files, {})).toHaveLength(1);
    repo?.dispose();
    const unlisted = {
      ...RULES,
      readAllowance: {
        [API]: { driven: ["src/orders/adapters/driven/other.ts"], decidedBy: ["kernel"] },
      },
    };
    expect(
      b8({ ...files, "src/orders/adapters/driven/other.ts": "export const x = 1;\n" }, unlisted),
    ).toHaveLength(1);
  });

  it("licenses a listed read-only file for a file that also imports a decidedBy library when it runs", () => {
    const files = reads(SELECT);
    expect(b8({ ...files, [HTTP]: `${KERNEL}${READ}${USE}` })).toEqual([]);
    repo?.dispose();
    expect(b8({ ...files, [HTTP]: `${READ}${KERNEL}${USE}` })).toEqual([]);
    repo?.dispose();
    const subpath = 'import { total } from "@shop/domain-kernel/total";\n';
    expect(b8({ ...files, [HTTP]: `${READ}${subpath}${USE}` })).toEqual([]);
  });

  it.each([
    ["no library at all", `${READ}${USE}`],
    [
      "only a type from the decidedBy library",
      `import type { Total } from "@shop/domain-kernel";\n${READ}${USE}`,
    ],
    [
      "only an inline type from it",
      `import { type Total } from "@shop/domain-kernel";\n${READ}${USE}`,
    ],
    ["a library of another type", `import { slug } from "@shop/string-util";\n${READ}${USE}`],
    ["a package that is no declared library", `import { z } from "zod";\n${READ}${USE}`],
  ])("keeps B8 for a file that imports %s", (_, source) => {
    expect(b8({ ...reads(SELECT), [HTTP]: source })).toHaveLength(1);
  });

  it("never licenses application/, whatever the file also imports", () => {
    const files = {
      ...reads(SELECT),
      "src/orders/application/use.ts": "export const use = 1;\n",
      [HTTP]: `${KERNEL}${READ}import { use } from "../../application/use";\nexport const h = use;\n`,
    };
    const found = b8(files);
    expect(found.map((v) => v.to)).toEqual([at("src/orders/application/use.ts")]);
  });

  it("judges each driven file a driving file imports on its own", () => {
    const files = {
      ...reads(SELECT),
      "src/orders/adapters/driven/other.ts": "export const other = 1;\n",
      [HTTP]: `${KERNEL}${READ}import { other } from "../driven/other";\nexport const h = [read, other];\n`,
    };
    expect(b8(files).map((v) => v.to)).toEqual([at("src/orders/adapters/driven/other.ts")]);
  });

  it("judges only a feature's own driven files: another feature's stay B1's", () => {
    const files = {
      "src/billing/adapters/driven/reads.ts": "export const read = 1;\n",
      [HTTP]: `${KERNEL}import { read } from "../../../billing/adapters/driven/reads";\n${USE}`,
    };
    const found = b8(files, {
      ...RULES,
      readAllowance: {
        [API]: { driven: ["src/billing/adapters/driven/reads.ts"], decidedBy: ["kernel"] },
      },
    });
    expect(found).toEqual([]);
    const all = reportOf((repo as BoundaryRepo).run({ json: true })).scopes.flatMap(
      (s) => s.violations,
    );
    expect(all.map((v) => v.kind)).toEqual(["cross-feature"]);
  });
});

describe("a listed file that writes is never licensed, and the report names the write", () => {
  // Each is one site of the access `--data` computes as `write`, over the bindings of the worker.
  it.each([
    ["a D1 prepare of an INSERT", 'env.DB.prepare("INSERT INTO t VALUES (1)")', "DB"],
    ["a D1 prepare of an UPDATE", 'env.DB.prepare("update t set a = 1")', "DB"],
    ["a D1 prepare of a DELETE", 'env.DB.prepare("DELETE FROM t")', "DB"],
    ["a D1 prepare of a REPLACE", 'env.DB.prepare("REPLACE INTO t VALUES (1)")', "DB"],
    ["a D1 exec of a CREATE", 'env.DB.exec("CREATE TABLE t (a)")', "DB"],
    ["a D1 prepare of a DROP", 'env.DB.prepare("DROP TABLE t")', "DB"],
    ["a D1 prepare of an ALTER", 'env.DB.prepare("ALTER TABLE t ADD b")', "DB"],
    ["a KV put", 'env.CACHE.put("k", "v")', "CACHE"],
    ["a KV delete", 'env.CACHE.delete("k")', "CACHE"],
    ["an R2 put", 'env.ASSETS.put("k", "v")', "ASSETS"],
    ["an R2 delete", 'env.ASSETS.delete("k")', "ASSETS"],
    ["a queue send", "env.EVENTS.send({ id: 1 })", "EVENTS"],
  ])("is B8 beside a decidedBy library for %s", (_, call, binding) => {
    const body = `export const read = (env: Env) => {\n  return ${call};\n};`;
    const found = b8({ ...reads(body), [HTTP]: `${KERNEL}${READ}${USE}` });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      to: at(DRIVEN),
      write: { file: at(DRIVEN), line: 2, binding },
    });
  });

  it.each([
    ["a D1 SELECT", 'env.DB.prepare("SELECT 1")'],
    ["a D1 statement whose SQL is not a literal", "env.DB.prepare(sql)"],
    ["a D1 dump", "env.DB.dump()"],
    ["a KV get", 'env.CACHE.get("k")'],
    ["an R2 list", "env.ASSETS.list()"],
    ["a Durable Object stub", "env.COUNTER.get(env.COUNTER.idFromName('a'))"],
    ["a name that is no binding of the worker", 'env.NOT_A_BINDING.put("k", "v")'],
    [
      "a binding read through an object not named env",
      'bindings.DB.prepare("INSERT INTO t VALUES (1)")',
    ],
  ])("is clean beside a decidedBy library for %s", (_, call) => {
    const body = `declare const sql: string;\ndeclare const bindings: Env;\nexport const read = (env: Env) => ${call};`;
    expect(b8({ ...reads(body), [HTTP]: `${KERNEL}${READ}${USE}` })).toEqual([]);
  });

  it("is clean for a listed file with no site at all", () => {
    expect(b8({ ...reads("export const read = 1;"), [HTTP]: `${KERNEL}${READ}${USE}` })).toEqual(
      [],
    );
  });

  it.each([
    [
      "an alias",
      'export const read = (env: Env) => {\n  const db = env.DB;\n  return db.prepare("DELETE FROM t");\n};',
    ],
    [
      "a destructure off env",
      'export const read = (env: Env) => {\n  const { DB } = env;\n  return DB.prepare("DELETE FROM t");\n};',
    ],
    [
      "this.env",
      'export class Store {\n  constructor(private readonly env: Env) {}\n  read() { return this.env.CACHE.put("k", "v"); }\n}',
    ],
  ])("reads a write through %s", (_, body) => {
    const found = b8({ ...reads(body), [HTTP]: `${KERNEL}${READ}${USE}` });
    expect(found).toHaveLength(1);
    expect(found[0]?.write).toBeDefined();
  });

  it("names the first write in source order, though a read comes first", () => {
    const body = [
      "export const read = (env: Env) => {",
      '  env.DB.prepare("SELECT 1");',
      '  env.CACHE.get("k");',
      '  env.CACHE.put("k", "v");',
      '  env.DB.prepare("DELETE FROM t");',
      "};",
    ].join("\n");
    const found = b8({ ...reads(body), [HTTP]: `${KERNEL}${READ}${USE}` });
    expect(found[0]?.write).toEqual({ file: at(DRIVEN), line: 4, binding: "CACHE" });
  });

  it("is B8 for every driving file that imports the writing file", () => {
    const files = {
      ...reads('export const read = (env: Env) => env.DB.prepare("DELETE FROM t");'),
      [HTTP]: `${KERNEL}${READ}${USE}`,
      "src/orders/adapters/driving/cron.ts": `${READ}${USE}`,
    };
    repo = apiRepo(files, RULES, WORKER);
    const rows = reportOf((repo as BoundaryRepo).run({ json: true })).scopes.flatMap(
      (scope) => scope.violations as Row[],
    );
    expect(rows.filter((v) => v.kind === B8).map((v) => [v.from, v.write?.line])).toEqual([
      [at("src/orders/adapters/driving/cron.ts"), 1],
      [at(HTTP), 1],
    ]);
  });

  it("names the site in the plain row, the --json row and the --ci line, and keeps the ledger entry's shape", () => {
    const body = 'export const read = (env: Env) =>\n  env.DB.prepare("UPDATE t SET a = 1");';
    repo = apiRepo({ ...reads(body), [HTTP]: `${KERNEL}${READ}${USE}` }, RULES, WORKER);
    const site = `[write: DB at ${at(DRIVEN)}:2]`;
    const plain = repo.run();
    expect(plain.code).toBe(0);
    expect(plain.stdout).toContain(
      `B8 ${B8} ${at(HTTP)} -> ${at(DRIVEN)}  ("../driven/reads")  ${site}`,
    );
    const row = reportOf(repo.run({ json: true })).scopes.flatMap((s) => s.violations as Row[])[0];
    expect(row?.write).toEqual({ file: at(DRIVEN), line: 2, binding: "DB" });
    const failed = repo.run({ ci: true });
    expect(failed.code).toBe(1);
    expect(entryLines(failed.stdout)).toEqual([expect.stringContaining(site)]);
    expect(repo.run({ acceptCrossings: true, reason: "legacy" }).stdout).toContain(site);
    expect(ledgerOf(repo).entries).toEqual([
      {
        scope: API,
        kind: B8,
        from: at(HTTP),
        to: at(DRIVEN),
        specifier: "../driven/reads",
        reason: "legacy",
      },
    ]);
    const gated = repo.run({ ci: true });
    expect(gated.code).toBe(0);
    expect(gated.stdout).not.toContain("write:");
  });

  it("keeps the key of an undeclared B8: a recorded entry is the same one once the file is listed", () => {
    const body = 'export const read = (env: Env) => env.DB.prepare("UPDATE t SET a = 1");';
    const files = { ...reads(body), [HTTP]: `${READ}${USE}` };
    repo = apiRepo(files, { ...RULES, readAllowance: {} }, WORKER);
    expect(repo.run({ acceptCrossings: true, reason: "legacy" }).code).toBe(0);
    const before = ledgerOf(repo).entries;
    repo.dispose();
    repo = apiRepo(files, RULES, WORKER);
    repo.run({ acceptCrossings: true, reason: "legacy" });
    expect(ledgerOf(repo).entries).toEqual(before);
  });
});

describe("a read allowance that omits decidedBy licenses a listed read-only file for any driving file", () => {
  const OMITTED = { ...RULES, readAllowance: { [API]: { driven: [DRIVEN] } } };
  const OTHER = "src/orders/adapters/driven/other.ts";
  const USE_APPLICATION = "src/orders/application/use.ts";

  it.each([
    ["no library at all", `${READ}${USE}`],
    ["a library of a type another scope names", `${KERNEL}${READ}${USE}`],
    [
      "only a type from a library",
      `import type { Total } from "@shop/domain-kernel";\n${READ}${USE}`,
    ],
    ["a library of another type", `import { slug } from "@shop/string-util";\n${READ}${USE}`],
    ["a package that is no declared library", `import { z } from "zod";\n${READ}${USE}`],
  ])("is clean for a file that imports %s", (_, source) => {
    expect(b8({ ...reads(SELECT), [HTTP]: source }, OMITTED)).toEqual([]);
  });

  it("keeps B8 for application/ and for a driven file it does not list", () => {
    const files = {
      ...reads(SELECT),
      [USE_APPLICATION]: "export const use = 1;\n",
      [OTHER]: "export const other = 1;\n",
      [HTTP]: `${READ}import { other } from "../driven/other";\nimport { use } from "../../application/use";\nexport const h = [read, other, use];\n`,
    };
    const found = b8(files, OMITTED);
    expect(found.map((v) => v.to).sort()).toEqual([at(OTHER), at(USE_APPLICATION)]);
  });

  it("is B8 for every driving file that imports a listed file that writes, naming the site", () => {
    const write =
      'export const read = (env: Env) => {\n  return env.DB.prepare("DELETE FROM t");\n};';
    const files = {
      ...reads(write),
      [HTTP]: `${READ}${USE}`,
      "src/orders/adapters/driving/cron.ts": `${KERNEL}${READ}${USE}`,
    };
    repo = apiRepo(files, OMITTED, WORKER);
    const rows = reportOf(repo.run({ json: true })).scopes.flatMap((s) => s.violations as Row[]);
    const site = { file: at(DRIVEN), line: 2, binding: "DB" };
    expect(rows.filter((v) => v.kind === B8).map((v) => [v.from, v.write])).toEqual([
      [at("src/orders/adapters/driving/cron.ts"), site],
      [at(HTTP), site],
    ]);
  });

  it("judges a scope that names decidedBy and a scope that omits it each by its own rule, in one run", () => {
    const ADMIN = "services/admin";
    const driving = `${READ}${USE}`;
    repo = apiRepo(
      { ...reads(SELECT), [HTTP]: driving },
      {
        ...RULES,
        features: { [API]: ["orders"], [ADMIN]: ["orders"] },
        layout: { [API]: "hexagonal", [ADMIN]: "hexagonal" },
        readAllowance: {
          [API]: { driven: [DRIVEN], decidedBy: ["kernel"] },
          [ADMIN]: { driven: [DRIVEN] },
        },
      },
      {
        ...WORKER,
        ...shopManifests([ADMIN]),
        [`${ADMIN}/${DRIVEN}`]: `${SELECT}\n`,
        [`${ADMIN}/${HTTP}`]: driving,
      },
    );
    const rows = reportOf(repo.run({ json: true })).scopes.flatMap((s) => s.violations);
    expect(rows.filter((v) => v.kind === B8).map((v) => v.from)).toEqual([at(HTTP)]);
  });
});
