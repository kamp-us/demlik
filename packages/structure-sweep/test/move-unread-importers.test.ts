import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyHandPlan, applyManifest } from "../src/move/apply.js";
import type { Manifest } from "../src/move/manifest.js";
import { commit, gitIn, repo, write } from "./helpers.js";

const TSCONFIG = JSON.stringify({
  compilerOptions: {
    module: "NodeNext",
    moduleResolution: "NodeNext",
    strict: true,
    noEmit: true,
    types: [],
  },
  include: ["src"],
});

const WILD = { "./*": "./src/*.ts" };

/** A pnpm workspace of packages `a`, `b` and `c` holding `files`; its lockfile is committed. */
function workspace(files: Readonly<Record<string, string>>) {
  const root = repo({
    ".gitignore": "node_modules\n",
    "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n',
    "package.json": `${JSON.stringify({ name: "fixture-root", private: true }, null, 2)}\n`,
    ...Object.fromEntries(
      ["a", "b", "c"].flatMap((dir) => [
        [
          `packages/${dir}/package.json`,
          `${JSON.stringify({ name: `@fixture/${dir}`, private: true, type: "module", exports: WILD }, null, 2)}\n`,
        ],
        [`packages/${dir}/tsconfig.json`, TSCONFIG],
      ]),
    ),
    ...files,
  });
  execFileSync("pnpm", ["install", "--lockfile-only"], {
    cwd: root,
    stdio: "pipe",
  });
  commit(root, "lockfile");
  return root;
}

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

const line = (from: string, to: string, importer: string, specifier: string) =>
  `  ${from} -> ${to}  (${importer} imports "${specifier}", in a kind of file apply does not rewrite, and this row would leave it naming the wrong file)`;

const planOf = (...moves: readonly (readonly [string, string])[]) => ({
  scope: "packages/a",
  moves: moves.map(([from, to]) => ({ from, to })),
});

const manifestOf = (...moves: readonly (readonly [string, string])[]) =>
  ({
    scope: "packages/a",
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

const FIVE = [
  ["packages/a/src/one.ts", "packages/b/src/one.ts"],
  ["packages/a/src/two.ts", "packages/b/src/two.ts"],
  ["packages/b/src/three.ts", "packages/c/src/three.ts"],
  ["packages/b/src/four.ts", "packages/c/src/four.ts"],
  ["packages/c/src/five.ts", "packages/a/src/five.ts"],
] as const;

const MODULES = {
  "packages/a/src/one.ts": "export const one = 1;\n",
  "packages/a/src/two.ts": "export const two = 2;\n",
  "packages/a/src/uses.ts": 'export { one } from "./one.js";\n',
  "packages/b/src/three.ts": "export const three = 3;\n",
  "packages/b/src/four.ts": "export const four = 4;\n",
  "packages/c/src/five.ts": "export const five = 5;\n",
};

const PAGE = "<template><p>A page.</p></template>\n";

/** One importing file of each kind, two by a relative path and two by a package name. */
const importers = (imports: boolean) => ({
  "packages/a/src/Card.vue": `<script setup>\n${imports ? 'import { one } from "./one";\n' : ""}</script>\n${PAGE}`,
  "packages/b/docs/List.svelte": `<script>\n${imports ? "import { three } from '../src/three.js';\n" : ""}</script>\n${PAGE}`,
  "packages/c/docs/guide.mdx": `${imports ? 'import { two } from "@fixture/a/two";\n\n' : ""}# Guide\n`,
  "packages/a/docs/Home.astro": `---\n${imports ? 'import { five } from "@fixture/c/five";\n' : ""}---\n${PAGE}`,
});

const FOUR_LINES = [
  line(...FIVE[4], "packages/a/docs/Home.astro", "@fixture/c/five"),
  line(...FIVE[0], "packages/a/src/Card.vue", "./one"),
  line(...FIVE[2], "packages/b/docs/List.svelte", "../src/three.js"),
  line(...FIVE[1], "packages/c/docs/guide.mdx", "@fixture/a/two"),
];

describe("an import in a .vue, .svelte, .mdx or .astro file", () => {
  it("stops a five-row plan across three packages until it is gone, then the plan applies in two commits", () => {
    const root = workspace({ ...MODULES, ...importers(true) });
    const before = snapshot(root);

    const message = refusal(() => applyHandPlan(root, planOf(...FIVE)));

    expect(rowLines(message)).toEqual(FOUR_LINES);
    expect(snapshot(root)).toEqual(before);
    expect(refusal(() => applyHandPlan(root, planOf(...FIVE)))).toBe(message);
    expect(snapshot(root)).toEqual(before);

    write(root, importers(false));
    commit(root, "drop the four imports");
    const applied = applyHandPlan(root, planOf(...FIVE));

    expect(applied.commits.rename).not.toBeNull();
    expect(applied.commits.rewrite).toBe(head(root));
    expect(gitIn(root, "rev-parse", "HEAD~1").trim()).toBe(
      applied.commits.rename,
    );
    expect(
      readFileSync(join(root, "packages/a/src/uses.ts"), "utf8"),
    ).toContain("@fixture/b/one");

    const after = head(root);
    const again = applyHandPlan(root, planOf(...FIVE));

    expect(again.commits).toEqual({ rename: null, rewrite: null });
    expect(head(root)).toBe(after);
  });

  it.each([
    {
      name: ".vue",
      file: "packages/a/src/Card.vue",
      text: 'import x from "./one.js"',
      specifier: "./one.js",
    },
    {
      name: ".svelte",
      file: "packages/a/src/List.svelte",
      text: "import x from './one'",
      specifier: "./one",
    },
    {
      name: ".mdx",
      file: "packages/a/docs/guide.mdx",
      text: 'import x from "@fixture/a/one"',
      specifier: "@fixture/a/one",
    },
    {
      name: ".astro",
      file: "packages/a/docs/Home.astro",
      text: 'import x from "../src/one.ts"',
      specifier: "../src/one.ts",
    },
  ])("refuses a row inside one package: $name", ({ file, text, specifier }) => {
    const row = [
      "packages/a/src/one.ts",
      "packages/a/src/deep/one.ts",
    ] as const;
    const root = workspace({ ...MODULES, [file]: `${text}\n` });
    const before = snapshot(root);

    const message = refusal(() => applyHandPlan(root, planOf(row)));

    expect(rowLines(message)).toEqual([line(...row, file, specifier)]);
    expect(snapshot(root)).toEqual(before);
  });

  it("changes nothing when it names no moved file", () => {
    const quiet = {
      "packages/a/src/Card.vue": `<script>import { two } from "./two";\nimport { ref } from "vue";</script>\n${PAGE}`,
      "packages/a/docs/guide.mdx": `# It's a guide\n\nimport { two } from "@fixture/a/two";\n\nSee "./one" nowhere near here.\n`,
      "packages/b/docs/List.svelte": `<script>import { four } from "../src/four";</script>\n${PAGE}`,
      "packages/c/docs/Home.astro": `---\nimport Layout from "./Layout.astro";\n---\n${PAGE}`,
    };
    const row = ["packages/a/src/one.ts", "packages/b/src/one.ts"] as const;
    const without = workspace(MODULES);
    const withQuiet = workspace({ ...MODULES, ...quiet });
    const run = (root: string) => {
      const { millis, commits, ...report } = applyHandPlan(root, planOf(row));
      return {
        report,
        rewrite: gitIn(root, "show", "--name-status", "--format=", "HEAD"),
        rename: gitIn(root, "show", "--name-status", "--format=", "HEAD~1"),
        made: {
          rename: commits.rename !== null,
          rewrite: commits.rewrite !== null,
        },
      };
    };

    expect(run(withQuiet)).toEqual(run(without));
    for (const [path, text] of Object.entries(quiet))
      expect(readFileSync(join(withQuiet, path), "utf8")).toBe(text);
  });

  it("is refused the same way for a manifest as for a hand plan", () => {
    const root = workspace({ ...MODULES, ...importers(true) });
    const before = snapshot(root);

    const manifest = refusal(() => applyManifest(root, manifestOf(...FIVE)));

    expect(rowLines(manifest)).toEqual(FOUR_LINES);
    expect(manifest).toBe(refusal(() => applyHandPlan(root, planOf(...FIVE))));
    expect(snapshot(root)).toEqual(before);
  });

  describe("over an earlier run's rename commit", () => {
    const row = [
      "packages/a/src/one.ts",
      "packages/a/src/deep/one.ts",
    ] as const;
    const plan = planOf(row);
    /** What an older apply, with no such check, left behind: `files` stand beside the rename. */
    const renamedBeside = (files: Readonly<Record<string, string>>) => {
      const root = workspace({
        ...MODULES,
        "packages/a/src/uses.ts": "export const uses = 0;\n",
        "packages/a/tsconfig.json": JSON.stringify({
          compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } },
        }),
      });
      expect(applyHandPlan(root, plan).commits.rewrite).toBeNull();
      write(root, files);
      gitIn(root, "add", "-A");
      gitIn(root, "commit", "-q", "--amend", "--no-edit");
      return root;
    };

    it.each([
      { name: "a relative path", specifier: "./one" },
      { name: "a package name", specifier: "@fixture/a/one" },
      { name: "a tsconfig alias", specifier: "@/one" },
    ])("refuses $name with HEAD where it was", ({ specifier }) => {
      const page = "packages/a/src/page.mdx";
      const root = renamedBeside({ [page]: `import x from "${specifier}"\n` });
      const before = snapshot(root);

      const message = refusal(() => applyHandPlan(root, plan));

      expect(rowLines(message)).toEqual([line(...row, page, specifier)]);
      expect(snapshot(root)).toEqual(before);
    });

    it("refuses when a commit has landed on top of it", () => {
      const page = "packages/a/src/page.mdx";
      const root = renamedBeside({});
      write(root, { [page]: 'import x from "./one"\n' });
      commit(root, "a page");
      const before = snapshot(root);

      const message = refusal(() => applyHandPlan(root, plan));

      expect(rowLines(message)).toEqual([line(...row, page, "./one")]);
      expect(snapshot(root)).toEqual(before);
    });
  });

  it("does not refuse a .md file quoting a moved file's path", () => {
    const row = [
      "packages/a/src/one.ts",
      "packages/a/src/deep/one.ts",
    ] as const;
    const root = workspace({
      ...MODULES,
      "packages/a/src/notes.md":
        'import { one } from "./one";\nSee "@fixture/a/one" and "packages/a/src/one.ts".\n',
    });

    expect(applyHandPlan(root, planOf(row)).commits.rename).not.toBeNull();
  });

  it("finds an import on a line where an apostrophe comes first", () => {
    const row = [
      "packages/a/src/one.ts",
      "packages/a/src/deep/one.ts",
    ] as const;
    const page = "packages/a/src/page.mdx";
    const root = workspace({
      ...MODULES,
      [page]: "It's here: import x from './one'\n",
    });

    expect(rowLines(refusal(() => applyHandPlan(root, planOf(row))))).toEqual([
      line(...row, page, "./one"),
    ]);
  });

  it("refuses a tsconfig alias naming a moved file", () => {
    const row = [
      "packages/a/src/one.ts",
      "packages/a/src/deep/one.ts",
    ] as const;
    const page = "packages/a/src/Card.vue";
    const root = workspace({
      ...MODULES,
      "packages/a/tsconfig.json": JSON.stringify({
        compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } },
      }),
      [page]: 'import x from "@/one"\n',
    });

    expect(rowLines(refusal(() => applyHandPlan(root, planOf(row))))).toEqual([
      line(...row, page, "@/one"),
    ]);
  });

  it("refuses a package-name string apply cannot follow into a package a row leaves", () => {
    const row = ["packages/a/src/one.ts", "packages/b/src/one.ts"] as const;
    const page = "packages/c/docs/guide.mdx";
    const root = workspace({
      ...MODULES,
      "packages/a/package.json": `${JSON.stringify({ name: "@fixture/a", private: true, type: "module", exports: { ...WILD, "./built": "./dist/built.js" } }, null, 2)}\n`,
      [page]: 'import x from "@fixture/a/built"\n',
    });

    const [only, ...rest] = rowLines(
      refusal(() => applyHandPlan(root, planOf(row))),
    );

    expect(rest).toEqual([]);
    expect(only).toContain(`${page} imports "@fixture/a/built"`);
    expect(only).toContain("apply cannot tell which file");
  });

  describe("with a bundler query or hash after the path", () => {
    const row = [
      "packages/a/src/one.ts",
      "packages/a/src/deep/one.ts",
    ] as const;

    it.each([
      { file: "packages/a/src/Card.vue", specifier: "./one.ts?raw" },
      { file: "packages/a/src/List.svelte", specifier: "./one?worker" },
      { file: "packages/a/src/guide.mdx", specifier: "./one.ts?url" },
      { file: "packages/a/src/Home.astro", specifier: "./one.ts#part" },
      { file: "packages/c/docs/guide.mdx", specifier: "@fixture/a/one?raw" },
    ])("refuses $specifier in $file as written", ({ file, specifier }) => {
      const root = workspace({
        ...MODULES,
        [file]: `import x from "${specifier}"\n`,
      });
      const before = snapshot(root);

      const message = refusal(() => applyHandPlan(root, planOf(row)));

      expect(rowLines(message)).toEqual([line(...row, file, specifier)]);
      expect(snapshot(root)).toEqual(before);
    });

    it("refuses a tsconfig alias", () => {
      const page = "packages/a/src/Card.vue";
      const root = workspace({
        ...MODULES,
        "packages/a/tsconfig.json": JSON.stringify({
          compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } },
        }),
        [page]: 'import x from "@/one?url"\n',
      });

      expect(rowLines(refusal(() => applyHandPlan(root, planOf(row))))).toEqual(
        [line(...row, page, "@/one?url")],
      );
    });

    it("keeps the # that opens a package.json imports name", () => {
      const page = "packages/a/src/Card.vue";
      const root = workspace({
        ...MODULES,
        "packages/a/package.json": `${JSON.stringify({ name: "@fixture/a", private: true, type: "module", exports: WILD, imports: { "#one": "./src/one.ts" } }, null, 2)}\n`,
        [page]: 'import x from "#one?raw"\n',
      });

      expect(rowLines(refusal(() => applyHandPlan(root, planOf(row))))).toEqual(
        [line(...row, page, "#one?raw")],
      );
    });

    it("changes nothing when the path names no moved file", () => {
      const root = workspace({
        ...MODULES,
        "packages/a/src/Card.vue": 'import x from "./two.ts?raw"\n',
      });

      expect(applyHandPlan(root, planOf(row)).commits.rename).not.toBeNull();
    });

    it("refuses a package-name string apply cannot follow, as without the suffix", () => {
      const across = [
        "packages/a/src/one.ts",
        "packages/b/src/one.ts",
      ] as const;
      const page = "packages/c/docs/guide.mdx";
      const root = workspace({
        ...MODULES,
        "packages/a/package.json": `${JSON.stringify({ name: "@fixture/a", private: true, type: "module", exports: { ...WILD, "./built": "./dist/built.js" } }, null, 2)}\n`,
        [page]: 'import x from "@fixture/a/built?raw"\n',
      });

      const [only, ...rest] = rowLines(
        refusal(() => applyHandPlan(root, planOf(across))),
      );

      expect(rest).toEqual([]);
      expect(only).toContain(`${page} imports "@fixture/a/built?raw"`);
    });
  });

  describe("a string naming a file no row moves, when a row's destination arrives in its reach", () => {
    const row = ["packages/a/src/x/one.ts", "packages/a/src/one.ts"] as const;
    const files = {
      "packages/a/src/x/one.ts": "export const one = 1;\n",
      "packages/a/src/one.js": "export const old = 0;\n",
    };

    it.each([
      { file: "packages/a/src/Card.vue", specifier: "./one" },
      { file: "packages/a/src/List.svelte", specifier: "./one?raw" },
      { file: "packages/a/docs/guide.mdx", specifier: "../src/one" },
      { file: "packages/a/src/Home.astro", specifier: "./one.js" },
    ])("refuses $specifier in $file", ({ file, specifier }) => {
      const root = workspace({
        ...files,
        [file]: `import x from "${specifier}"\n`,
      });
      const before = snapshot(root);

      const message = refusal(() => applyHandPlan(root, planOf(row)));

      expect(rowLines(message)).toEqual([line(...row, file, specifier)]);
      expect(snapshot(root)).toEqual(before);
    });

    it("refuses on a run resumed over the rename commit", () => {
      const page = "packages/a/src/Card.vue";
      const root = workspace(files);
      expect(applyHandPlan(root, planOf(row)).commits.rename).not.toBeNull();
      write(root, { [page]: 'import x from "./one"\n' });
      commit(root, "a page");
      const before = snapshot(root);

      const message = refusal(() => applyHandPlan(root, planOf(row)));

      expect(rowLines(message)).toEqual([line(...row, page, "./one")]);
      expect(snapshot(root)).toEqual(before);
    });

    it("does not refuse a string that keeps naming its file", () => {
      const root = workspace({
        ...files,
        "packages/a/src/two.ts": "export const two = 2;\n",
        "packages/a/src/Card.vue": 'import x from "./two"\n',
      });

      expect(applyHandPlan(root, planOf(row)).commits.rename).not.toBeNull();
    });
  });

  it("refuses a moved file's relative string naming a file left behind", () => {
    const row = [
      "packages/a/docs/guide.mdx",
      "packages/a/docs/deep/guide.mdx",
    ] as const;
    const root = workspace({
      ...MODULES,
      [row[0]]: 'import x from "../src/two"\n',
    });
    const before = snapshot(root);

    expect(rowLines(refusal(() => applyHandPlan(root, planOf(row))))).toEqual([
      line(...row, row[0], "../src/two"),
    ]);
    expect(snapshot(root)).toEqual(before);
  });

  it("does not refuse a file moved together with what it names, keeping their layout", () => {
    const root = workspace({
      ...MODULES,
      "packages/a/src/Card.vue": 'import x from "./one"\n',
    });

    const { commits } = applyHandPlan(
      root,
      planOf(
        ["packages/a/src/one.ts", "packages/a/src/deep/one.ts"],
        ["packages/a/src/Card.vue", "packages/a/src/deep/Card.vue"],
      ),
    );

    expect(commits.rename).not.toBeNull();
  });
});
