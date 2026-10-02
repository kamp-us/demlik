import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type BoundaryRepo, boundaryRepo } from "../../test-helpers/boundary-repo.js";
import { crossingsOf, ledgerOf, reportOf, sorted } from "../../test-helpers/library-report.js";
import { shopManifests } from "../../test-helpers/shop-workspace.js";

const UTIL = { util: { imports: ["util"], pure: true } };

const base = (dirs: readonly string[], sources: Record<string, string> = {}) => ({
  ...shopManifests(dirs),
  ...sources,
});

describe("the library keys are parsed at the config boundary", () => {
  let repo: BoundaryRepo;
  beforeEach(() => {
    repo = boundaryRepo(
      ".",
      base(["packages/a", "packages/b"], { "packages/bare/src/x.ts": "export const x = 1;\n" }),
      {},
    );
  });
  afterEach(() => repo.dispose());

  // The refusal every mode gives: exit 2, one line, nothing on stdout and no ledger written.
  const refused = (rules: unknown): string => {
    const file = path.join(repo.root, "rules.json");
    fs.writeFileSync(file, JSON.stringify(rules));
    const messages: string[] = [];
    for (const flags of [{}, { ci: true }, { acceptCrossings: true, reason: "x" }]) {
      const { code, errors, stdout } = repo.run({ ...flags, rules: file });
      expect(code).toBe(2);
      expect(stdout).toBe("");
      expect(errors).toHaveLength(1);
      messages.push(...errors);
    }
    expect(fs.existsSync(repo.ledgerFile)).toBe(false);
    return messages[0] ?? "";
  };

  it("refuses a type used in `libraries` that `libraryTypes` does not declare", () => {
    expect(refused({ libraryTypes: UTIL, libraries: { "packages/a": "ghost" } })).toBe(
      'library "packages/a" is type "ghost", which "libraryTypes" (declared: util) lacks.',
    );
  });

  it("refuses a type listed in an `imports` that `libraryTypes` does not declare", () => {
    const types = { util: { imports: ["util", "ghost"], pure: true } };
    expect(refused({ libraryTypes: types })).toBe(
      'library type "util" imports "ghost", which "libraryTypes" (declared: util) lacks.',
    );
  });

  it("refuses an `importedFrom` zone outside driven, configurator and any", () => {
    const types = { util: { ...UTIL.util, importedFrom: ["server"] } };
    const message = refused({ libraryTypes: types });
    expect(message).toContain("libraryTypes.util.importedFrom.0");
    expect(message).toContain("configurator");
    const empty = { util: { ...UTIL.util, importedFrom: [] } };
    expect(refused({ libraryTypes: empty })).toContain("libraryTypes.util.importedFrom");
  });

  it("refuses a `libraries` path that is no package root", () => {
    const message = (dir: string) =>
      `library "${dir}" is no package root: a library is a directory below the repo root that holds a package.json.`;
    for (const dir of ["packages/nope", "packages/bare", ".", "packages/a/"]) {
      expect(refused({ libraryTypes: UTIL, libraries: { [dir]: "util" } })).toBe(message(dir));
    }
  });

  it("refuses a `libraryRoots` entry that is no directory, or is not written clean", () => {
    const message = (root: string) =>
      `libraryRoots entry "${root}" is no directory of the repo: write a repo-relative path such as packages.`;
    for (const root of [
      "nope",
      "packages/",
      "./packages",
      "packages/a/src/../../..",
      "packages/a/package.json",
    ]) {
      expect(refused({ libraryRoots: [root] })).toBe(message(root));
    }
  });

  it("refuses a type with no `pure`, and a `worldLibraries` glob that does not compile", () => {
    expect(refused({ libraryTypes: { util: { imports: [] } } })).toContain(
      "libraryTypes.util.pure",
    );
    expect(refused({ worldLibraries: ["{"] })).toContain('world library "{" is not a valid glob');
  });

  it("refuses a `worldLibraries` entry that matches a catalog door, whose ledger entry it would share", () => {
    for (const [entry, door] of [
      ["fetch", "fetch"],
      ["console", "console"],
      ["node:*", "node:fs"],
    ]) {
      expect(refused({ worldLibraries: [entry] })).toContain(
        `world library "${entry}" matches the catalog door "${door}"`,
      );
    }
  });

  it("accepts the four keys, a library outside every root, and a root that is the repo", () => {
    const rules = { libraryTypes: UTIL, libraries: { "packages/a": "util" }, libraryRoots: ["."] };
    const file = path.join(repo.root, "ok.json");
    fs.writeFileSync(file, JSON.stringify(rules));
    const run = repo.run({ rules: file, json: true });
    expect(run.errors).toEqual([]);
    expect(run.code).toBe(0);
  });
});

describe("B11: a package under a library root that no library names", () => {
  const types = {
    contract: { imports: ["contract", "util"], pure: true },
    util: { imports: ["util"], pure: true },
  };
  let repo: BoundaryRepo;
  beforeEach(() => {
    repo = boundaryRepo(
      ".",
      base(["packages/a", "packages/b", "packages/c", "packages/nested/d", "tools/x", "libs/e"], {
        "libs/e/src/index.ts": 'import { a } from "@shop/a";\nexport const e = a;\n',
      }),
      {
        libraryTypes: types,
        libraryRoots: ["packages"],
        libraries: { "packages/a": "contract", "packages/b": "contract", "libs/e": "util" },
      },
    );
  });
  afterEach(() => repo.dispose());

  it("lists each undeclared package at any depth, and not a declared one or one outside every root", () => {
    expect(crossingsOf(repo.run({ json: true }))).toEqual([
      ["library-imports-up", "libs/e/src/index.ts", "packages/a"],
      ["library-undeclared", "packages/c", "c"],
      ["library-undeclared", "packages/nested/d", "nested/d"],
    ]);
  });

  it("keys the entry on the package directory, under the library root as its scope", () => {
    expect(repo.run({ acceptCrossings: true, reason: "scratch for now" }).code).toBe(0);
    expect(ledgerOf(repo).entries).toContainEqual({
      scope: "packages",
      kind: "library-undeclared",
      from: "packages/c",
      to: null,
      specifier: "c",
      reason: "scratch for now",
    });
  });
});

describe("B12: a library imports only the types its own type lists", () => {
  const types = {
    contract: { imports: ["contract", "util"], pure: true },
    kernel: { imports: ["kernel", "contract", "util"], pure: true },
    util: { imports: ["util"], pure: true },
  };
  const libraries = {
    "packages/contracts": "contract",
    "packages/kernel": "kernel",
    "packages/utils": "util",
  };
  const make = (sources: Record<string, string>) =>
    boundaryRepo(
      ".",
      base([...Object.keys(libraries), "packages/loose", "services/web"], sources),
      { libraryTypes: types, libraries },
    );
  let repo: BoundaryRepo;
  afterEach(() => repo.dispose());

  it("is one entry per importer file and library, however many specifiers or subpaths it writes", () => {
    repo = make({
      "packages/contracts/src/many.ts": [
        'import { a } from "@shop/kernel";',
        'import { b } from "@shop/kernel/deep";',
        'import type { C } from "@shop/kernel/types";',
        'export { d } from "@shop/kernel/more";',
        "export const x = [a, b, d];",
      ].join("\n"),
    });
    const run = repo.run({ json: true });
    expect(crossingsOf(run)).toEqual([
      ["library-imports-up", "packages/contracts/src/many.ts", "packages/kernel"],
    ]);
    const [entry] = reportOf(run).scopes.flatMap((s) => s.violations);
    expect(entry).toMatchObject({ specifier: "@shop/kernel", typeOnly: false });
    expect(repo.run({ acceptCrossings: true, reason: "r" }).code).toBe(0);
    expect(ledgerOf(repo).entries).toHaveLength(1);
  });

  it("carries typeOnly only when every import of the library is type-only", () => {
    repo = make({
      "packages/contracts/src/types.ts":
        'import type { K } from "@shop/kernel/types";\nexport type T = K;\n',
      "packages/utils/src/mixed.ts": [
        'import type { C } from "@shop/contracts";',
        'import { c } from "@shop/contracts/runtime";',
        "export const m = c;",
      ].join("\n"),
    });
    const found = reportOf(repo.run({ json: true })).scopes.flatMap((s) => s.violations);
    expect(found.map((v) => [v.from, v.typeOnly])).toEqual([
      ["packages/contracts/src/types.ts", true],
      ["packages/utils/src/mixed.ts", false],
    ]);
    const human = repo.run().stdout;
    expect(human).toMatch(
      /types\.ts -> packages\/kernel {2}\("@shop\/kernel\/types"\) {2}\[type-only\]/,
    );
    expect(human).not.toMatch(/mixed\.ts.*\[type-only\]/);
  });

  it("lists nothing for an allowed type, the importer's own name, a non-workspace package or a relative import", () => {
    repo = make({
      "packages/kernel/src/ok.ts":
        'import "@shop/contracts";\nimport "@shop/utils/x";\nimport "@shop/kernel/self";\n',
      "packages/utils/src/outside.ts":
        'import "left-pad";\nimport "@other/contracts";\nimport "./self.js";\n',
      "packages/utils/src/self.ts": 'import "@shop/utils";\nexport const s = 1;\n',
    });
    const run = repo.run({ json: true });
    expect(crossingsOf(run)).toEqual([]);
    expect(reportOf(run).libraries?.unjudgedImports).toBe(0);
  });

  it("counts an import of an undeclared workspace package as unjudged, once per importer and package", () => {
    repo = make({
      "packages/utils/src/a.ts": 'import "@shop/loose";\nimport "@shop/loose/deep";\n',
      "packages/kernel/src/b.ts": 'import "@shop/web";\n',
      "services/web/src/c.ts": 'import "@shop/loose";\n',
    });
    const run = repo.run({ json: true });
    expect(crossingsOf(run)).toEqual([]);
    expect(reportOf(run).libraries?.unjudgedImports).toBe(2);
    expect(repo.run().stdout).toContain("2 imports left unjudged");
  });
});

describe("B13: a pure library uses no world door and imports no world library", () => {
  const types = {
    pure: { imports: ["pure"], pure: true },
    free: { imports: ["pure", "free"], pure: false },
  };
  const libraries = { "packages/core": "pure", "packages/edge": "free" };
  const rules = {
    libraryTypes: types,
    libraries,
    worldLibraries: ["drizzle-orm", "hono", "@sentry/*"],
  };
  const DOORS = [
    "export const a = Date.now();",
    "export const b = process.env.TOKEN;",
    'import fs from "node:fs";',
    "export const c = new Date();",
    "export const d = [fs, Date.now()];",
  ].join("\n");
  const WORLD = [
    'import a from "drizzle-orm";',
    'import type { T } from "drizzle-orm";',
    'export { b } from "drizzle-orm/pg-core";',
    'export const c = import("hono/cors");',
    'import e from "@sentry/node/integrations";',
    'import f from "@sentry/node";',
    'import g from "@sentryx/node";',
    'import h from "honox";',
    'import type { Context } from "hono";',
  ].join("\n");
  const CLEAN = {
    "packages/core/src/type-door.ts": [
      'import type { Stats } from "node:fs";',
      'import { type Dirent } from "node:fs";',
      "export type S = Stats | Dirent;",
    ].join("\n"),
    "packages/core/src/bound.ts": [
      "const Date = { now: () => 1 };",
      "const fetch = () => 2;",
      "export const x = [Date.now(), fetch()];",
    ].join("\n"),
    "packages/core/src/injected.ts":
      "export const f = (deps: { clock: { now(): number } }) => deps.clock.now();\n",
  };
  let repo: BoundaryRepo;
  beforeEach(() => {
    repo = boundaryRepo(
      ".",
      base(Object.keys(libraries), {
        "packages/core/src/doors.ts": DOORS,
        "packages/core/src/world.ts": WORLD,
        "packages/edge/src/doors.ts": DOORS,
        "packages/edge/src/world.ts": WORLD,
        ...CLEAN,
      }),
      rules,
    );
  });
  afterEach(() => repo.dispose());

  it("is one entry per file per door, whether used by name or opened as a module", () => {
    const doors = crossingsOf(repo.run({ json: true })).filter(([, from]) =>
      from.endsWith("core/src/doors.ts"),
    );
    expect(doors).toEqual(
      ["Date.now", "new Date()", "node:fs", "process.env"].map((door) => [
        "impure-library",
        "packages/core/src/doors.ts",
        door,
      ]),
    );
  });

  it("is one entry per file per world-library specifier as written, in any spelling", () => {
    const world = crossingsOf(repo.run({ json: true })).filter(([, from]) =>
      from.endsWith("core/src/world.ts"),
    );
    expect(world.map(([, , target]) => target)).toEqual([
      "@sentry/node",
      "@sentry/node/integrations",
      "drizzle-orm",
      "drizzle-orm/pg-core",
      "hono",
      "hono/cors",
    ]);
  });

  it("matches `@sentry/*` against a package and its subpaths, never a neighbour of the same prefix", () => {
    const targets = crossingsOf(repo.run({ json: true })).map(([, , target]) => target);
    expect(targets).toContain("@sentry/node");
    expect(targets).toContain("@sentry/node/integrations");
    expect(targets).not.toContain("@sentryx/node");
    expect(targets).not.toContain("honox");
  });

  it("marks a type-only world import, and judges a type-only module door as clean", () => {
    const found = reportOf(repo.run({ json: true })).scopes.flatMap((s) => s.violations);
    const typeOnly = found.filter((v) => v.typeOnly).map((v) => [v.from, v.specifier]);
    expect(typeOnly).toEqual([["packages/core/src/world.ts", "hono"]]);
    expect(found.filter((v) => v.from.endsWith("type-door.ts"))).toEqual([]);
  });

  it("leaves a name the file binds itself, and a call on an injected object, clean", () => {
    const froms = crossingsOf(repo.run({ json: true })).map(([, from]) => from);
    expect(froms).not.toContain("packages/core/src/bound.ts");
    expect(froms).not.toContain("packages/core/src/injected.ts");
  });

  it("lists the same files clean in a library whose type is not pure", () => {
    const froms = crossingsOf(repo.run({ json: true })).map(([, from]) => from);
    expect(froms.filter((from) => from.startsWith("packages/edge/"))).toEqual([]);
  });
});

describe("B14: an adapter library is imported only from the zones its type names", () => {
  const types = {
    driven: { imports: [], pure: false, importedFrom: ["driven"] },
    conf: { imports: [], pure: false, importedFrom: ["configurator"] },
    anywhere: { imports: [], pure: false, importedFrom: ["any"] },
    free: { imports: [], pure: false },
  };
  const libraries = {
    "packages/d": "driven",
    "packages/c": "conf",
    "packages/a": "anywhere",
    "packages/f": "free",
  };
  const IMPORTS = ["d", "c", "a", "f"].map((dir) => `import "@shop/${dir}";`).join("\n");
  const FILES = [
    "services/api/src/orders/adapters/driven/x.ts",
    "services/api/src/orders/application/x.ts",
    "services/api/src/orders/adapters/driving/x.ts",
    "services/api/src/orders/index.ts",
    "services/api/src/main.ts",
    "services/legacy/src/cart/store/x.ts",
  ];
  let repo: BoundaryRepo;
  beforeEach(() => {
    repo = boundaryRepo(
      ".",
      base(
        [...Object.keys(libraries), "services/api", "services/legacy"],
        Object.fromEntries(FILES.map((file) => [file, `${IMPORTS}\n`])),
      ),
      {
        features: { "services/api": ["orders"], "services/legacy": ["cart"] },
        layout: { "services/api": "hexagonal" },
        libraryTypes: types,
        libraries,
      },
    );
  });
  afterEach(() => repo.dispose());

  it("is clean from driven/ only for `driven`, from a file outside every feature only for `configurator`, from anywhere for `any`", () => {
    const flagged = (file: string) =>
      crossingsOf(repo.run({ json: true }))
        .filter(([, from]) => from === file)
        .map(([, , target]) => target);
    expect(flagged(FILES[0] ?? "")).toEqual(["packages/c"]);
    expect(flagged(FILES[4] ?? "")).toEqual(["packages/d"]);
  });

  it("is one entry from application/, adapters/driving/, index.ts and a rules-layout feature file", () => {
    for (const file of [FILES[1], FILES[2], FILES[3], FILES[5]]) {
      const flagged = crossingsOf(repo.run({ json: true }))
        .filter(([, from]) => from === file)
        .map(([, , target]) => target);
      expect(flagged).toEqual(["packages/c", "packages/d"]);
    }
  });

  it("leaves a library whose type names no `importedFrom` unconstrained", () => {
    const targets = crossingsOf(repo.run({ json: true })).map(([, , target]) => target);
    expect(targets).not.toContain("packages/f");
    expect(targets).not.toContain("packages/a");
  });

  it("records the scope of the importing file: its feature scope", () => {
    expect(repo.run({ acceptCrossings: true, reason: "r" }).code).toBe(0);
    expect(new Set(ledgerOf(repo).entries.map((entry) => entry.scope))).toEqual(
      new Set(["services/api", "services/legacy"]),
    );
  });
});

describe("a library's import is one verdict: B12 when its type forbids it, else B14", () => {
  const types = {
    adapter: { imports: [], pure: false, importedFrom: ["driven"] },
    composition: { imports: ["adapter"], pure: false },
    util: { imports: ["util"], pure: true },
  };
  const libraries = {
    "packages/db": "adapter",
    "packages/root": "composition",
    "packages/util": "util",
  };
  const sources = {
    "packages/root/src/index.ts": 'import "@shop/db";\n',
    "packages/util/src/index.ts": 'import "@shop/db";\n',
  };
  const make = (extra: Record<string, unknown> = {}) =>
    boundaryRepo(".", base(Object.keys(libraries), sources), {
      libraryTypes: types,
      libraries,
      ...extra,
    });

  it("judges an import the type permits by where the target may be imported from", () => {
    const repo = make();
    try {
      expect(crossingsOf(repo.run({ json: true }))).toEqual(
        sorted([
          ["adapter-library-imported-outside-driven", "packages/root/src/index.ts", "packages/db"],
          ["library-imports-up", "packages/util/src/index.ts", "packages/db"],
        ]),
      );
      const ledgered = repo.run({ acceptCrossings: true, reason: "r" });
      expect(ledgered.code).toBe(0);
      expect(ledgerOf(repo).entries.map((entry) => entry.scope)).toEqual([
        "packages/root",
        "packages/util",
      ]);
    } finally {
      repo.dispose();
    }
  });

  it("is clean when the target names `configurator` and the importer is outside every feature", () => {
    const withConfigurator = {
      libraryTypes: {
        ...types,
        adapter: { ...types.adapter, importedFrom: ["driven", "configurator"] },
      },
    };
    const repo = make(withConfigurator);
    try {
      expect(crossingsOf(repo.run({ json: true }))).toEqual([
        ["library-imports-up", "packages/util/src/index.ts", "packages/db"],
      ]);
    } finally {
      repo.dispose();
    }
  });
});
