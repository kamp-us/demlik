import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { Project } from "ts-morph";
import { describe, expect, it } from "vitest";
import { applyHandPlan } from "../src/move/apply.js";
import { moduleLiterals, relativeSpecifierOf } from "../src/move/specifier.js";
import { readWorkspace } from "../src/move/workspace.js";
import { gitIn, repo } from "./helpers.js";

const TSC = createRequire(import.meta.url).resolve("typescript/bin/tsc");

const TSCONFIG = JSON.stringify({
  compilerOptions: {
    module: "NodeNext",
    moduleResolution: "NodeNext",
    resolveJsonModule: true,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    types: [],
  },
  include: ["src"],
});

const WILD = { "./*": "./src/*.ts" };

type Manifest = {
  readonly exports?: unknown;
  readonly main?: string;
  readonly dependencies?: Record<string, string>;
};

const manifest = (name: string, fields: Manifest) =>
  `${JSON.stringify({ name, private: true, type: "module", ...fields }, null, 2)}\n`;

const pnpm = (root: string, ...args: string[]) =>
  execFileSync("pnpm", args, { cwd: root, encoding: "utf8", stdio: "pipe" });

/** A pnpm workspace of `packages`, each with its tsconfig, plus `files`; its lockfile is committed. */
function workspace(
  packages: Readonly<Record<string, Manifest>>,
  files: Readonly<Record<string, string>>,
) {
  const root = repo({
    ".gitignore": "node_modules\n",
    "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n',
    "package.json": `${JSON.stringify({ name: "fixture-root", private: true }, null, 2)}\n`,
    ...Object.fromEntries(
      Object.entries(packages).flatMap(([dir, fields]) => [
        [`packages/${dir}/package.json`, manifest(`@fixture/${dir}`, fields)],
        [`packages/${dir}/tsconfig.json`, TSCONFIG],
      ]),
    ),
    ...files,
  });
  pnpm(root, "install", "--lockfile-only");
  gitIn(root, "add", "-A");
  gitIn(root, "commit", "-q", "-m", "lockfile");
  return root;
}

/** `tsc --noEmit` over one package after a frozen install: its output, empty when it typechecks. */
function typecheck(root: string, ...packages: string[]): string[] {
  pnpm(root, "install", "--frozen-lockfile", "--offline");
  return packages.flatMap((p) => {
    try {
      execFileSync(process.execPath, [TSC, "-p", join(root, "packages", p)], {
        encoding: "utf8",
        stdio: "pipe",
      });
      return [];
    } catch (error) {
      return [String((error as { stdout?: string }).stdout ?? error)];
    }
  });
}

const read = (root: string, path: string) =>
  readFileSync(join(root, path), "utf8");

const dependenciesOf = (root: string, path: string) =>
  (JSON.parse(read(root, path)) as { dependencies?: Record<string, string> })
    .dependencies;

const snapshot = (root: string) => ({
  head: gitIn(root, "rev-parse", "HEAD"),
  tree: gitIn(root, "status", "--porcelain", "--ignored", "--untracked=all"),
});

const refusal = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "";
};

const planOf = (
  scope: string,
  ...moves: readonly (readonly [string, string])[]
) => ({
  scope,
  moves: moves.map(([from, to]) => ({ from, to })),
});

const ONE_INTO_B = planOf("packages/a", [
  "packages/a/src/one.ts",
  "packages/b/src/one.ts",
]);

describe("import x = require() across a package line", () => {
  it("writes each one by package name with the dependency added, and every package typechecks", () => {
    const root = workspace(
      {
        a: { exports: WILD },
        b: { exports: { "./k": "./src/k.cts" } },
        c: {
          exports: { "./uses": "./src/uses.cts" },
          dependencies: { "@fixture/a": "workspace:*" },
        },
      },
      {
        "packages/a/src/k.cts": "export const k = 2;\n",
        "packages/a/src/uses.cts":
          'import k = require("./k.cjs");\n\nexport const a = k.k;\n',
        "packages/b/src/index.ts": "export const b = 1;\n",
        "packages/c/src/uses.cts":
          'import k = require("../../a/src/k.cjs");\n\nexport const c = k.k;\n',
      },
    );

    const report = applyHandPlan(
      root,
      planOf("packages/a", ["packages/a/src/k.cts", "packages/b/src/k.cts"]),
    );

    for (const path of ["packages/a/src/uses.cts", "packages/c/src/uses.cts"])
      expect(read(root, path)).toContain('require("@fixture/b/k")');
    expect(report.dependenciesAdded).toEqual([
      "@fixture/a -> @fixture/b",
      "@fixture/c -> @fixture/b",
    ]);
    expect(typecheck(root, "a", "b", "c")).toEqual([]);
  });
});

/** `one` imports a JSON file and the `package.json` it leaves behind. */
const jsonImports = (exportsOfA: unknown) =>
  workspace(
    { a: { exports: exportsOfA }, b: { exports: WILD } },
    {
      "packages/a/src/data.json": '{ "n": 1 }\n',
      "packages/a/src/one.ts": [
        'import data from "./data.json" with { type: "json" };',
        'import pkg from "../package.json" with { type: "json" };',
        "",
        "export const one = [data.n, pkg.name];",
        "",
      ].join("\n"),
      "packages/b/src/index.ts": "export const b = 1;\n",
    },
  );

describe("a moved file's import of a non-TypeScript file left behind", () => {
  it("is written by package name, keeping its extension, where an exports entry reaches the file", () => {
    const root = jsonImports({
      "./data.json": "./src/data.json",
      "./package.json": "./package.json",
    });

    const report = applyHandPlan(root, ONE_INTO_B);

    const moved = read(root, "packages/b/src/one.ts");
    expect(moved).toContain('from "@fixture/a/data.json" with');
    expect(moved).toContain('from "@fixture/a/package.json" with');
    expect(report.dependenciesAdded).toEqual(["@fixture/b -> @fixture/a"]);
    expect(typecheck(root, "b")).toEqual([]);
  });

  it("is refused before any commit, naming the row and the file, where none does", () => {
    const root = jsonImports(WILD);
    const before = snapshot(root);

    const lines = refusal(() => applyHandPlan(root, ONE_INTO_B))
      .split("\n")
      .filter((l) => l.includes(" -> "));

    expect(lines).toEqual([
      "  packages/a/src/one.ts -> packages/b/src/one.ts  (packages/b/src/one.ts imports packages/a/src/data.json, which no exports entry of @fixture/a reaches)",
      "  packages/a/src/one.ts -> packages/b/src/one.ts  (packages/b/src/one.ts imports packages/a/package.json, which no exports entry of @fixture/a reaches)",
    ]);
    expect(snapshot(root)).toEqual(before);
  });

  it.each([
    { resolveJsonModule: true },
    { resolveJsonModule: false },
  ])("keeps naming the file on a move inside one package (resolveJsonModule: $resolveJsonModule)", ({
    resolveJsonModule,
  }) => {
    const root = repo({
      "app/tsconfig.json": JSON.stringify({
        compilerOptions: {
          module: "ESNext",
          moduleResolution: "Bundler",
          resolveJsonModule,
        },
        include: ["src"],
      }),
      "app/src/data.json": '{ "n": 1 }\n',
      "app/src/styles.css": "a {}\n",
      "app/src/x.ts":
        'import data from "./data.json";\nimport "./styles.css";\n\nexport const x = data;\n',
    });

    applyHandPlan(
      root,
      planOf("app", ["app/src/x.ts", "app/src/deep/er/x.ts"]),
    );

    const moved = read(root, "app/src/deep/er/x.ts");
    expect(moved).toContain('from "../../data.json"');
    expect(moved).toContain('import "../../styles.css"');
  });
});

/** `one` leaves `a`, which declares `@fixture/c`, and imports it by `specifier`. */
const importsC = (c: Manifest, files: Readonly<Record<string, string>>) =>
  workspace(
    {
      a: { exports: WILD, dependencies: { "@fixture/c": "workspace:*" } },
      b: { exports: WILD },
      c,
    },
    {
      "packages/a/src/one.ts":
        'import { c } from "@fixture/c";\n\nexport const one = c;\n',
      "packages/a/src/stays.ts": "export const stays = 0;\n",
      "packages/b/src/index.ts": "export const b = 1;\n",
      ...files,
    },
  );

describe("a moved file's import of a workspace package with no exports", () => {
  it.each([
    { main: "./src/index.ts" },
    { main: "./dist/index.js" },
  ])("declares the package in its new home and typechecks there (main: $main)", ({
    main,
  }) => {
    const root = importsC(
      { main },
      { "packages/c/src/index.ts": "export const c = 3;\n" },
    );

    const report = applyHandPlan(root, ONE_INTO_B);

    expect(report.dependenciesAdded).toEqual(["@fixture/b -> @fixture/c"]);
    expect(read(root, "packages/b/src/one.ts")).toContain('from "@fixture/c"');
    expect(dependenciesOf(root, "packages/b/package.json")).toEqual({
      "@fixture/c": "workspace:*",
    });
    if (main === "./src/index.ts")
      expect(typecheck(root, "b", "c")).toEqual([]);
  });

  it("declares a package apply cannot follow to a source, since the import does not depend on one", () => {
    const root = importsC(
      { main: "./lib/index.js" },
      { "packages/c/lib/index.js": "export const c = 3;\n" },
    );

    const report = applyHandPlan(root, ONE_INTO_B);

    expect(report.dependenciesAdded).toEqual(["@fixture/b -> @fixture/c"]);
  });

  it("declares a package whose exports target has no source here", () => {
    const root = importsC(
      { exports: { ".": "./lib/index.js" } },
      { "packages/c/README.md": "built elsewhere\n" },
    );

    const report = applyHandPlan(root, ONE_INTO_B);

    expect(report.dependenciesAdded).toEqual(["@fixture/b -> @fixture/c"]);
  });
});

describe("a deep package path into a package with no exports", () => {
  const deep = (specifier: string, extra: Readonly<Record<string, string>>) =>
    workspace(
      {
        a: {},
        b: { exports: WILD },
        c: { exports: WILD, dependencies: { "@fixture/a": "workspace:*" } },
      },
      {
        "packages/a/src/one.ts": "export const one = 1;\n",
        "packages/a/src/stays.ts": "export const stays = 0;\n",
        "packages/b/src/index.ts": "export const b = 1;\n",
        "packages/c/src/uses.ts": `import { one } from "${specifier}";\n\nexport const c = one;\n`,
        ...extra,
      },
    );

  it("is rewritten to the file's new home, and every package typechecks", () => {
    const root = deep("@fixture/a/src/one.js", {});

    const report = applyHandPlan(root, ONE_INTO_B);

    expect(read(root, "packages/c/src/uses.ts")).toContain(
      'from "@fixture/b/one"',
    );
    expect(report.dependenciesAdded).toEqual(["@fixture/c -> @fixture/b"]);
    expect(report.staleStringRefs).toEqual([]);
    expect(typecheck(root, "b", "c")).toEqual([]);
  });

  it("is refused, naming the row and the importer, when it names nothing apply can find", () => {
    const root = deep("@fixture/a/lib/one.js", {});
    const before = snapshot(root);

    const lines = refusal(() => applyHandPlan(root, ONE_INTO_B))
      .split("\n")
      .filter((l) => l.includes(" -> "));

    expect(lines).toEqual([
      '  packages/a/src/one.ts -> packages/b/src/one.ts  (packages/c/src/uses.ts imports "@fixture/a/lib/one.js", and apply cannot tell which file of @fixture/a that is, so a row may move it)',
    ]);
    expect(snapshot(root)).toEqual(before);
  });
});

describe("imports apply cannot follow", () => {
  it("refuses a relative import in a file crossing a package line that names no file", () => {
    const root = workspace(
      { a: { exports: WILD }, b: { exports: WILD } },
      {
        "packages/a/src/one.ts":
          'import { x } from "./generated.js";\n\nexport const one = x;\n',
        "packages/b/src/index.ts": "export const b = 1;\n",
      },
    );
    const before = snapshot(root);

    const lines = refusal(() => applyHandPlan(root, ONE_INTO_B))
      .split("\n")
      .filter((l) => l.includes(" -> "));

    expect(lines).toEqual([
      '  packages/a/src/one.ts -> packages/b/src/one.ts  (packages/b/src/one.ts imports "./generated.js", which names no file apply can find)',
    ]);
    expect(snapshot(root)).toEqual(before);
  });

  const PATHS = JSON.stringify({
    compilerOptions: {
      module: "ESNext",
      moduleResolution: "Bundler",
      baseUrl: ".",
      paths: { "@/*": ["./src/*"] },
    },
    include: ["src"],
  });

  it.each([
    {
      name: "a moved file's tsconfig paths alias",
      importer: "packages/b/src/one.ts",
      specifier: "@/stays",
    },
    {
      name: "a staying file's tsconfig paths alias naming a moved file",
      importer: "packages/a/src/uses.ts",
      specifier: "@/one",
    },
  ])("refuses $name, which means nothing in the new package", ({
    importer,
    specifier,
  }) => {
    const root = workspace(
      { a: { exports: WILD }, b: { exports: WILD } },
      {
        "packages/a/tsconfig.json": PATHS,
        "packages/a/src/one.ts":
          'import { s } from "@/stays";\n\nexport const one = s;\n',
        "packages/a/src/stays.ts": "export const s = 1;\n",
        "packages/a/src/uses.ts":
          'import { one } from "@/one";\n\nexport const u = one;\n',
        "packages/b/src/index.ts": "export const b = 1;\n",
      },
    );
    const before = snapshot(root);

    const message = refusal(() => applyHandPlan(root, ONE_INTO_B));

    expect(message).toContain(
      `  packages/a/src/one.ts -> packages/b/src/one.ts  (${importer} imports "${specifier}", an alias from tsconfig paths or package.json imports, which apply does not rewrite)`,
    );
    expect(snapshot(root)).toEqual(before);
  });

  it("leaves an npm package and a Node builtin alone", () => {
    const root = workspace(
      { a: { exports: WILD }, b: { exports: WILD } },
      {
        "packages/a/src/one.ts":
          'import { join } from "node:path";\nimport z from "zod";\n\nexport const one = [join, z];\n',
        "packages/b/src/index.ts": "export const b = 1;\n",
      },
    );

    const report = applyHandPlan(root, ONE_INTO_B);

    expect(report.dependenciesAdded).toEqual([]);
    expect(read(root, "packages/b/src/one.ts")).toContain('from "zod"');
  });

  it("carries a package-name import of a built non-code file, which no row can have moved", () => {
    const root = workspace(
      {
        a: {
          exports: { ...WILD, "./styles.css": "./dist/styles.css" },
        },
        b: { exports: WILD },
        c: { exports: WILD, dependencies: { "@fixture/a": "workspace:*" } },
      },
      {
        "packages/a/src/one.ts": "export const one = 1;\n",
        "packages/b/src/index.ts": "export const b = 1;\n",
        "packages/c/src/uses.ts":
          'import "@fixture/a/styles.css";\n\nexport const c = 1;\n',
      },
    );

    const report = applyHandPlan(root, ONE_INTO_B);

    expect(report.commits.rename).not.toBeNull();
    expect(read(root, "packages/c/src/uses.ts")).toContain(
      '"@fixture/a/styles.css"',
    );
  });
});

describe("a workspace member at packages/test or packages/tests", () => {
  it.each([
    "test",
    "tests",
  ])("is a member as pnpm counts it, and carries a row like any other: packages/%s", (dir) => {
    const root = repo({
      ".gitignore": "node_modules\n",
      "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n',
      "package.json": `${JSON.stringify({ name: "fixture-root", private: true }, null, 2)}\n`,
      "packages/a/package.json": manifest("@fixture/a", { exports: WILD }),
      "packages/a/tsconfig.json": TSCONFIG,
      "packages/a/src/one.ts": "export const one = 1;\n",
      "packages/a/src/two.ts": "export const two = 2;\n",
      [`packages/${dir}/package.json`]: manifest("@fixture/t", {
        exports: WILD,
      }),
      [`packages/${dir}/tsconfig.json`]: TSCONFIG,
      [`packages/${dir}/src/uses.ts`]:
        'import { one } from "../../a/src/one.js";\n\nexport const t = one;\n',
      [`packages/${dir}/src/leaves.ts`]: "export const leaves = 3;\n",
    });
    pnpm(root, "install", "--lockfile-only");
    gitIn(root, "add", "-A");
    gitIn(root, "commit", "-q", "-m", "lockfile");

    const listed = pnpm(root, "-r", "exec", "pwd")
      .split("\n")
      .filter(Boolean)
      .map((path) => path.slice(path.indexOf("/packages/") + 1))
      .sort();
    expect(
      readWorkspace(root)
        .members.map((p) => p.root)
        .sort(),
    ).toEqual(listed);

    const report = applyHandPlan(
      root,
      planOf(
        "packages/a",
        ["packages/a/src/two.ts", `packages/${dir}/src/two.ts`],
        [`packages/${dir}/src/leaves.ts`, "packages/a/src/leaves.ts"],
      ),
    );

    expect(report.commits.rename).not.toBeNull();
    expect(dependenciesOf(root, "package.json")).toBeUndefined();
    expect(read(root, `packages/${dir}/src/uses.ts`)).toContain(
      '"../../a/src/one.js"',
    );
  });

  it("gives an importer inside it the dependency in its own package.json, never the root's", () => {
    const root = repo({
      ".gitignore": "node_modules\n",
      "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n',
      "package.json": `${JSON.stringify({ name: "fixture-root", private: true }, null, 2)}\n`,
      "packages/a/package.json": manifest("@fixture/a", { exports: WILD }),
      "packages/a/tsconfig.json": TSCONFIG,
      "packages/a/src/one.ts": "export const one = 1;\n",
      "packages/b/package.json": manifest("@fixture/b", { exports: WILD }),
      "packages/b/tsconfig.json": TSCONFIG,
      "packages/b/src/index.ts": "export const b = 1;\n",
      "packages/test/package.json": manifest("@fixture/t", {
        exports: WILD,
        dependencies: { "@fixture/a": "workspace:*" },
      }),
      "packages/test/tsconfig.json": TSCONFIG,
      "packages/test/src/uses.ts":
        'import { one } from "@fixture/a/one";\n\nexport const t = one;\n',
    });
    pnpm(root, "install", "--lockfile-only");
    gitIn(root, "add", "-A");
    gitIn(root, "commit", "-q", "-m", "lockfile");

    const report = applyHandPlan(root, ONE_INTO_B);

    expect(report.dependenciesAdded).toEqual(["@fixture/t -> @fixture/b"]);
    expect(dependenciesOf(root, "packages/test/package.json")).toEqual({
      "@fixture/a": "workspace:*",
      "@fixture/b": "workspace:*",
    });
    expect(dependenciesOf(root, "package.json")).toBeUndefined();
    expect(typecheck(root, "b", "test")).toEqual([]);
  });
});

describe("moduleLiterals", () => {
  it("reads every form that names a module, in document order", () => {
    const sf = new Project({ useInMemoryFileSystem: true }).createSourceFile(
      "x.cts",
      [
        'import a = require("./a.cjs");',
        'import b from "./b";',
        'const c = require("./c.cjs");',
        'const d = import("./d");',
        'type E = import("./e");',
        'declare module "./f" {}',
        "namespace G {}",
        'const notAModule = "./h";',
      ].join("\n"),
    );

    expect(moduleLiterals(sf).map((l) => l.getLiteralValue())).toEqual([
      "./a.cjs",
      "./b",
      "./c.cjs",
      "./d",
      "./e",
      "./f",
    ]);
  });
});

describe("relativeSpecifierOf", () => {
  it("spells each extension for the importer's resolution", () => {
    expect(relativeSpecifierOf("x.ts", "none")).toBe("./x");
    expect(relativeSpecifierOf("x.d.ts", "none")).toBe("./x");
    expect(relativeSpecifierOf("x.ts", "js")).toBe("./x.js");
    expect(relativeSpecifierOf("x.d.ts", "js")).toBe("./x.js");
    expect(relativeSpecifierOf("x.mts", "none")).toBe("./x.mjs");
    expect(relativeSpecifierOf("x.cts", "js")).toBe("./x.cjs");
    expect(relativeSpecifierOf("x.ts", "ts")).toBe("./x.ts");
    expect(relativeSpecifierOf("x.mts", "ts")).toBe("./x.mts");
  });
});
