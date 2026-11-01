// biome-ignore-all lint/suspicious/noTemplateCurlyInString: every such string here is a fixture's source text.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyHandPlan, applyManifest } from "../src/move/apply.js";
import type { Manifest } from "../src/move/manifest.js";
import { gitIn, repo, write } from "./helpers.js";

const TSC = createRequire(import.meta.url).resolve("typescript/bin/tsc");

const TSCONFIG = JSON.stringify({
  compilerOptions: {
    module: "NodeNext",
    moduleResolution: "NodeNext",
    allowJs: true,
    checkJs: true,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    types: [],
  },
  include: ["src"],
});

const WILD = { "./*": "./src/*.ts" };

type Fields = {
  readonly exports?: unknown;
  readonly dependencies?: Record<string, string>;
};

const pnpm = (root: string, ...args: string[]) =>
  execFileSync("pnpm", args, { cwd: root, encoding: "utf8", stdio: "pipe" });

/** A pnpm workspace of `packages`, each with its tsconfig, plus `files`; its lockfile is committed. */
function workspace(
  packages: Readonly<Record<string, Fields>>,
  files: Readonly<Record<string, string>>,
) {
  const root = repo({
    ".gitignore": "node_modules\n",
    "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n',
    "package.json": `${JSON.stringify({ name: "fixture-root", private: true }, null, 2)}\n`,
    ...Object.fromEntries(
      Object.entries(packages).flatMap(([dir, fields]) => [
        [
          `packages/${dir}/package.json`,
          `${JSON.stringify({ name: `@fixture/${dir}`, private: true, type: "module", ...fields }, null, 2)}\n`,
        ],
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

const head = (root: string) => gitIn(root, "rev-parse", "HEAD").trim();

const snapshot = (root: string) => ({
  head: head(root),
  tree: gitIn(root, "status", "--porcelain", "--untracked=all"),
});

const refusal = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "";
};

/** The refusal's row lines, each naming a row, an importing file and a specifier. */
const rowLines = (message: string) =>
  message.split("\n").filter((line) => line.includes(" -> "));

const planOf = (
  scope: string,
  ...moves: readonly (readonly [string, string])[]
) => ({
  scope,
  moves: moves.map(([from, to]) => ({ from, to })),
});

const manifestOf = (scope: string, ...moves: readonly [string, string][]) =>
  ({
    scope,
    features: ["audit_runs"],
    floor: 0.8,
    moves: moves.map(([from, to]) => ({
      from,
      to,
      feature: "audit_runs",
      role: "api_surface",
      confidence: 0.95,
    })),
    review: [],
    pinned: [],
  }) as Manifest;

const LOADS = (specifier: string) =>
  `export const load = (name: string) => import(\`${specifier}\`);\n`;

const reason = (row: string, importer: string, specifier: string) =>
  `  ${row}  (${importer} imports "${specifier}", a path built at run time that apply cannot rewrite, and this row changes which file it loads)`;

describe("a fixed backtick import", () => {
  const PLAN = planOf(
    "packages/a",
    ["packages/a/src/near.ts", "packages/a/src/lib/near.ts"],
    ["packages/a/src/one.ts", "packages/b/src/one.ts"],
    ["packages/a/src/two.ts", "packages/b/src/two.ts"],
    ["packages/a/src/mocked.ts", "packages/b/src/mocked.ts"],
    ["packages/a/src/mover.ts", "packages/b/src/deep/mover.ts"],
  );

  const fixture = () =>
    workspace(
      {
        a: { exports: WILD },
        b: { exports: WILD },
        c: { exports: WILD, dependencies: { "@fixture/a": "workspace:*" } },
      },
      {
        "packages/a/src/near.ts": "export const near = 0;\n",
        "packages/a/src/one.ts": "export const one = 1;\n",
        "packages/a/src/two.ts": "export const two = 2;\n",
        "packages/a/src/mocked.ts": "export const mocked = 3;\n",
        "packages/a/src/mover.ts":
          "export const loadTwo = () => import(`./two.js`);\n",
        "packages/a/src/uses.ts":
          "export const loadNear = () => import(`./near.js`);\n",
        "packages/a/src/req.cjs":
          "const { two } = require(`./two.js`);\n\nmodule.exports = { uses: two };\n",
        "packages/a/src/x.test.ts":
          "declare const vi: { mock(path: string): void };\n\nvi.mock(`./mocked.js`);\n\nexport {};\n",
        "packages/b/src/index.ts": "export const b = 1;\n",
        "packages/c/src/uses.ts":
          "export const loadOne = () => import(`@fixture/a/one`);\n",
      },
    );

  it("names its file's new home in every spot a person writes one, still in backticks, in one rename and one rewrite commit", () => {
    const root = fixture();
    const before = head(root);

    const report = applyHandPlan(root, PLAN);

    expect(report.commits).toEqual({
      rename: gitIn(root, "rev-parse", "HEAD~1").trim(),
      rewrite: head(root),
    });
    expect(gitIn(root, "rev-parse", "HEAD~2").trim()).toBe(before);
    expect(read(root, "packages/a/src/uses.ts")).toContain(
      "import(`./lib/near.js`)",
    );
    expect(read(root, "packages/c/src/uses.ts")).toContain(
      "import(`@fixture/b/one`)",
    );
    expect(read(root, "packages/a/src/req.cjs")).toContain(
      "require(`@fixture/b/two`)",
    );
    expect(read(root, "packages/a/src/x.test.ts")).toContain(
      "vi.mock(`@fixture/b/mocked`)",
    );
    expect(read(root, "packages/b/src/deep/mover.ts")).toContain(
      "import(`../two.js`)",
    );
    expect(report.dependenciesAdded).toEqual([
      "@fixture/a -> @fixture/b",
      "@fixture/c -> @fixture/b",
    ]);
    expect(typecheck(root, "a", "b", "c")).toEqual([]);

    const finished = head(root);
    const again = applyHandPlan(root, PLAN);
    expect(again.commits).toEqual({ rename: null, rewrite: null });
    expect(head(root)).toBe(finished);
  });

  it("is carried by a run resumed over an earlier run's rename commit", () => {
    const fresh = fixture();
    applyHandPlan(fresh, PLAN);
    const root = fixture();
    applyHandPlan(root, PLAN);
    gitIn(root, "reset", "-q", "--hard", "HEAD~1");

    const report = applyHandPlan(root, PLAN);

    expect(report.commits.rename).toBeNull();
    expect(report.commits.rewrite).not.toBeNull();
    for (const path of [
      "packages/a/src/uses.ts",
      "packages/c/src/uses.ts",
      "packages/a/src/req.cjs",
      "packages/a/src/x.test.ts",
      "packages/b/src/deep/mover.ts",
    ])
      expect(read(root, path)).toBe(read(fresh, path));
  });

  it("is carried on a move inside one package with no workspace file", () => {
    const root = repo({
      "app/tsconfig.json": JSON.stringify({
        compilerOptions: {
          module: "ESNext",
          moduleResolution: "Bundler",
          allowJs: true,
        },
        include: ["src"],
      }),
      "app/src/one.ts": "export const one = 1;\n",
      "app/src/plain.js": "export const load = () => import(`./one.ts`);\n",
      "app/src/x.test.ts": "vi.mock(`./one`);\n",
      "app/src/uses.ts": "export const load = () => import(`./one`);\n",
    });

    applyHandPlan(
      root,
      planOf("app", ["app/src/one.ts", "app/src/lib/one.ts"]),
    );

    expect(read(root, "app/src/uses.ts")).toContain("import(`./lib/one`)");
    expect(read(root, "app/src/plain.js")).toContain("import(`./lib/one.ts`)");
    expect(read(root, "app/src/x.test.ts")).toContain("vi.mock(`./lib/one`)");
  });

  it("left dangling by a rename is healed", () => {
    const root = repo({
      "app/tsconfig.json": JSON.stringify({
        compilerOptions: { module: "ESNext", moduleResolution: "Bundler" },
        include: ["src"],
      }),
      "app/src/one.ts": "export const one = 1;\n",
      "app/src/uses.ts": "export const load = () => import(`./one`);\n",
    });
    gitIn(root, "mv", "app/src/one.ts", "app/src/two.ts");
    gitIn(root, "commit", "-q", "-m", "a rename with no rewrite");

    const report = applyHandPlan(
      root,
      planOf("app", ["app/src/one.ts", "app/src/two.ts"]),
    );

    expect(report.healed).toBe(1);
    expect(read(root, "app/src/uses.ts")).toContain("import(`./two`)");
  });
});

describe("an import using ${}", () => {
  const CROSSING = [
    ["packages/a/src/locale/en.ts", "packages/b/src/locale/en.ts"],
    ["packages/a/src/away.ts", "packages/b/src/away.ts"],
  ] as const;

  const INSIDE = [
    ["packages/a/src/locale/en.ts", "packages/a/src/i18n/en.ts"],
    ["packages/a/src/away.ts", "packages/a/src/deep/away.ts"],
  ] as const;

  const FILES = {
    "packages/a/src/locale/en.ts": "export const en = 1;\n",
    "packages/a/src/locale/fr.ts": "export const fr = 2;\n",
    "packages/a/src/targets/one.ts": "export const one = 1;\n",
    "packages/a/src/load.ts": LOADS("./locale/${name}.js"),
    "packages/a/src/away.ts": LOADS("./targets/${name}.js"),
    "packages/b/src/index.ts": "export const b = 1;\n",
    "packages/c/src/uses.ts": LOADS("@fixture/a/${name}"),
  };

  const PACKAGES = {
    a: { exports: { "./*": "./src/*.ts" } },
    b: { exports: { "./*": "./src/*.ts" } },
    c: { exports: WILD, dependencies: { "@fixture/a": "workspace:*" } },
  };

  it.each([
    {
      name: "rows crossing a package line",
      rows: CROSSING,
      importerAway: "packages/b/src/away.ts",
    },
    {
      name: "rows inside one package",
      rows: INSIDE,
      importerAway: "packages/a/src/deep/away.ts",
    },
  ])("is refused before the rename commit, naming every row, importing file and specifier, and again on a second apply: $name", ({
    rows,
    importerAway,
  }) => {
    const root = workspace(PACKAGES, FILES);
    const before = snapshot(root);
    const [locale, away] = rows.map(([from, to]) => `${from} -> ${to}`) as [
      string,
      string,
    ];

    const message = refusal(() =>
      applyHandPlan(root, planOf("packages/a", ...rows)),
    );

    expect(rowLines(message).sort()).toEqual(
      [
        reason(locale, "packages/a/src/load.ts", "./locale/${name}.js"),
        reason(away, importerAway, "./targets/${name}.js"),
        reason(locale, "packages/c/src/uses.ts", "@fixture/a/${name}"),
        reason(away, "packages/c/src/uses.ts", "@fixture/a/${name}"),
      ].sort(),
    );
    expect(snapshot(root)).toEqual(before);
    expect(
      refusal(() => applyHandPlan(root, planOf("packages/a", ...rows))),
    ).toBe(message);
    expect(snapshot(root)).toEqual(before);
  });

  it("is refused the same way for a manifest as for a hand plan", () => {
    const root = workspace(PACKAGES, FILES);
    const before = snapshot(root);

    const hand = refusal(() =>
      applyHandPlan(root, planOf("packages/a", ...CROSSING)),
    );
    const manifest = refusal(() =>
      applyManifest(
        root,
        manifestOf(
          "packages/a",
          ...CROSSING.map((r) => [...r] as [string, string]),
        ),
      ),
    );

    expect(rowLines(manifest).length).toBe(4);
    expect(manifest).toBe(hand);
    expect(snapshot(root)).toEqual(before);
  });

  it("is refused by a run resumed over an earlier run's rename commit, with HEAD where it was", () => {
    const plan = planOf("packages/a", [
      "packages/a/src/locale/en.ts",
      "packages/a/src/i18n/en.ts",
    ]);
    const root = workspace(PACKAGES, {
      ...FILES,
      "packages/a/src/load.ts": "export const load = 0;\n",
      "packages/a/src/away.ts": "export const away = 0;\n",
      "packages/c/src/uses.ts": "export const uses = 0;\n",
    });
    const { rename, rewrite } = applyHandPlan(root, plan).commits;
    expect(rename).toBe(head(root));
    expect(rewrite).toBeNull();
    // What an older apply, with no such check, left behind: the import stands beside the rename.
    write(root, { "packages/a/src/load.ts": LOADS("./locale/${name}.js") });
    gitIn(root, "add", "-A");
    gitIn(root, "commit", "-q", "--amend", "--no-edit");
    const before = snapshot(root);

    const message = refusal(() => applyHandPlan(root, plan));

    expect(rowLines(message)).toEqual([
      reason(
        "packages/a/src/locale/en.ts -> packages/a/src/i18n/en.ts",
        "packages/a/src/load.ts",
        "./locale/${name}.js",
      ),
    ]);
    expect(snapshot(root)).toEqual(before);
  });

  it.each([
    {
      name: "inside one package",
      rows: [
        ["packages/a/src/load.ts", "packages/a/src/feature/load.ts"],
        ["packages/a/src/locale/en.ts", "packages/a/src/feature/locale/en.ts"],
        ["packages/a/src/locale/fr.ts", "packages/a/src/feature/locale/fr.ts"],
      ],
    },
    {
      name: "across a package line",
      rows: [
        ["packages/a/src/load.ts", "packages/b/src/load.ts"],
        ["packages/a/src/locale/en.ts", "packages/b/src/locale/en.ts"],
        ["packages/a/src/locale/fr.ts", "packages/b/src/locale/fr.ts"],
      ],
    },
  ] as const)("is left unchanged when it moves with all it can load, keeping their layout: $name", ({
    rows,
  }) => {
    const root = workspace(
      { a: { exports: WILD }, b: { exports: WILD } },
      {
        "packages/a/src/load.ts": LOADS("./locale/${name}.js"),
        "packages/a/src/locale/en.ts": "export const en = 1;\n",
        "packages/a/src/locale/fr.ts": "export const fr = 2;\n",
        "packages/a/src/stays.ts": "export const stays = 1;\n",
        "packages/b/src/index.ts": "export const b = 1;\n",
      },
    );
    const [[, landed]] = rows;

    const report = applyHandPlan(root, planOf("packages/a", ...rows));

    expect(report.commits.rename).not.toBeNull();
    expect(read(root, landed)).toBe(LOADS("./locale/${name}.js"));
  });

  it("is refused when a row moves a file into what it can load", () => {
    const root = workspace(
      { a: { exports: WILD } },
      {
        "packages/a/src/load.ts": LOADS("./locale/${name}.js"),
        "packages/a/src/locale/en.ts": "export const en = 1;\n",
        "packages/a/src/stray.ts": "export const stray = 1;\n",
      },
    );

    const message = refusal(() =>
      applyHandPlan(
        root,
        planOf("packages/a", [
          "packages/a/src/stray.ts",
          "packages/a/src/locale/stray.ts",
        ]),
      ),
    );

    expect(rowLines(message)).toEqual([
      reason(
        "packages/a/src/stray.ts -> packages/a/src/locale/stray.ts",
        "packages/a/src/load.ts",
        "./locale/${name}.js",
      ),
    ]);
  });

  it("is refused when a row moves a file within what a wide template reaches, under a different value", () => {
    const root = workspace(
      { a: { exports: WILD } },
      {
        "packages/a/src/load.ts": LOADS("./${name}.js"),
        "packages/a/src/locale/en.ts": "export const en = 1;\n",
      },
    );

    const message = refusal(() =>
      applyHandPlan(
        root,
        planOf("packages/a", [
          "packages/a/src/locale/en.ts",
          "packages/a/src/i18n/en.ts",
        ]),
      ),
    );

    expect(rowLines(message)).toEqual([
      reason(
        "packages/a/src/locale/en.ts -> packages/a/src/i18n/en.ts",
        "packages/a/src/load.ts",
        "./${name}.js",
      ),
    ]);
  });

  it("matches a file by what the specifier can spell, with no extension, a middle part, a directory's index or a non-code file", () => {
    const root = workspace(
      { a: { exports: WILD } },
      {
        "packages/a/src/load.ts": [
          LOADS("./bare/${name}"),
          "export const b = (x: string, y: string) => import(`./mid/${x}/fixed/${y}.js`);",
          "export const c = (x: string) => import(`./dirs/${x}`);",
          "export const d = (x: string) => import(`./data/${x}.json`);",
          "export const e = (x: string) => import(/* webpackChunkName: 'e' */ `./magic/${x}`);",
          "",
        ].join("\n"),
        "packages/a/src/bare/one.ts": "export const one = 1;\n",
        "packages/a/src/mid/x/fixed/y.ts": "export const y = 1;\n",
        "packages/a/src/mid/x/other/z.ts": "export const z = 1;\n",
        "packages/a/src/dirs/one/index.ts": "export const one = 1;\n",
        "packages/a/src/data/en.json": "{}\n",
        "packages/a/src/magic/one.ts": "export const one = 1;\n",
      },
    );
    const line = (from: string, to: string, specifier: string) =>
      reason(`${from} -> ${to}`, "packages/a/src/load.ts", specifier);

    const message = refusal(() =>
      applyHandPlan(
        root,
        planOf(
          "packages/a",
          ["packages/a/src/bare/one.ts", "packages/a/src/gone/one.ts"],
          ["packages/a/src/mid/x/fixed/y.ts", "packages/a/src/gone/y.ts"],
          ["packages/a/src/dirs/one/index.ts", "packages/a/src/gone/i.ts"],
          ["packages/a/src/data/en.json", "packages/a/src/gone/en.json"],
          ["packages/a/src/magic/one.ts", "packages/a/src/gone/magic.ts"],
        ),
      ),
    );

    expect(rowLines(message).sort()).toEqual(
      [
        line(
          "packages/a/src/bare/one.ts",
          "packages/a/src/gone/one.ts",
          "./bare/${name}",
        ),
        line(
          "packages/a/src/mid/x/fixed/y.ts",
          "packages/a/src/gone/y.ts",
          "./mid/${x}/fixed/${y}.js",
        ),
        line(
          "packages/a/src/dirs/one/index.ts",
          "packages/a/src/gone/i.ts",
          "./dirs/${x}",
        ),
        line(
          "packages/a/src/data/en.json",
          "packages/a/src/gone/en.json",
          "./data/${x}.json",
        ),
        line(
          "packages/a/src/magic/one.ts",
          "packages/a/src/gone/magic.ts",
          "./magic/${x}",
        ),
      ].sort(),
    );
  });

  it("names the package's other exports key, and a deep path into a package with no exports", () => {
    const root = workspace(
      {
        a: {
          exports: { "./named": "./src/one.ts", "./*": "./src/*.ts" },
        },
        b: { exports: WILD },
        d: {},
        c: {},
      },
      {
        "packages/a/src/one.ts": "export const one = 1;\n",
        "packages/b/src/index.ts": "export const b = 1;\n",
        "packages/d/src/two.ts": "export const two = 2;\n",
        "packages/c/src/uses.ts": [
          LOADS("@fixture/a/o${name}"),
          "export const m = (x: string) => import(`@fixture/d/src/${x}.js`);",
          "",
        ].join("\n"),
      },
    );

    const message = refusal(() =>
      applyHandPlan(
        root,
        planOf(
          "packages/a",
          ["packages/a/src/one.ts", "packages/b/src/one.ts"],
          ["packages/d/src/two.ts", "packages/d/lib/two.ts"],
        ),
      ),
    );

    expect(rowLines(message).sort()).toEqual(
      [
        reason(
          "packages/a/src/one.ts -> packages/b/src/one.ts",
          "packages/c/src/uses.ts",
          "@fixture/a/o${name}",
        ),
        reason(
          "packages/d/src/two.ts -> packages/d/lib/two.ts",
          "packages/c/src/uses.ts",
          "@fixture/d/src/${x}.js",
        ),
      ].sort(),
    );
  });

  it("changes nothing when it can load no moved file, or has no fixed start", () => {
    const base = {
      "packages/a/src/one.ts": "export const one = 1;\n",
      "packages/a/src/uses.ts": 'export { one } from "./one.js";\n',
      "packages/a/src/other/two.ts": "export const two = 2;\n",
      "packages/b/src/index.ts": "export const b = 1;\n",
    };
    const packages = { a: { exports: WILD }, b: { exports: WILD } };
    const plan = planOf("packages/a", [
      "packages/a/src/one.ts",
      "packages/a/src/lib/one.ts",
    ]);
    const comparable = (report: ReturnType<typeof applyHandPlan>) => ({
      ...report,
      commits: null,
      millis: 0,
    });
    const without = workspace(packages, base);
    const withThem = workspace(packages, {
      ...base,
      "packages/a/src/load.ts": [
        LOADS("./other/${name}.js"),
        "export const b = (base: string) => import(`${base}/one`);",
        "export const c = (x: string) => import(`lodash/${x}`);",
        "export const d = (x: string) => import(`@fixture/b/${x}`);",
        "",
      ].join("\n"),
    });
    const before = read(withThem, "packages/a/src/load.ts");

    const plain = applyHandPlan(without, plan);
    const report = applyHandPlan(withThem, plan);

    expect(comparable(report)).toEqual(comparable(plain));
    expect(read(withThem, "packages/a/src/load.ts")).toBe(before);
  });

  it("gives a moved file's package-name template its package in the new home", () => {
    const root = workspace(
      {
        a: { exports: WILD, dependencies: { "@fixture/c": "workspace:*" } },
        b: { exports: WILD },
        c: { exports: WILD },
      },
      {
        "packages/a/src/one.ts": LOADS("@fixture/c/${name}"),
        "packages/a/src/stays.ts": "export const stays = 0;\n",
        "packages/b/src/index.ts": "export const b = 1;\n",
        "packages/c/src/index.ts": "export const c = 3;\n",
      },
    );

    const report = applyHandPlan(
      root,
      planOf("packages/a", ["packages/a/src/one.ts", "packages/b/src/one.ts"]),
    );

    expect(report.dependenciesAdded).toEqual(["@fixture/b -> @fixture/c"]);
  });
});
