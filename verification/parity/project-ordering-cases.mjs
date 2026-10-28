const good = "export function good(n:number){return n+1;}\n";
const bad = "export function broken( {\n";
const config =
  '{"compilerOptions":{"strict":true,"target":"ES2022","module":"NodeNext","moduleResolution":"NodeNext","types":[]},"include":["**/*.ts"]}';
const plain = {
  "package.json": '{"private":true}',
  "pnpm-workspace.yaml": "packages: []\n",
};
const mixed = {
  "a10.ts": bad,
  "a2.ts": good,
  "e\u0301.ts": bad,
  "é.ts": bad,
  "Z.ts": bad,
  "m.ts": "// original\nexport const m=2;\n",
};
const hexagon = {
  "ports.ts":
    "export type ForRead=(id:string)=>number;export type ForWrite=(n:number)=>void;export type Invoice={read:ForRead};export type InvoiceDriven={write:ForWrite};\n",
  "application/𐀀.ts": "export function astral(){return 1;}\n",
  "application/\ue000.ts": "export const privateUse=()=>2;\n",
  "application/bad.ts": bad,
  "adapters/driving/𐀀.ts": "export {};\n",
  "adapters/driving/\ue000.ts": "export {};\n",
  "adapters/driven/io.ts": "export {};\n",
};
const packages = {
  ...plain,
  "tsconfig.json": config,
  "packages/𐀀/package.json": '{"name":"@fixture/same","source":"src/index.ts"}',
  "packages/\ue000/package.json":
    '{"name":"@fixture/same","source":"src/index.ts"}',
  "packages/𐀀/src/index.ts": "export function one(n:number){return n+1;}\n",
  "packages/\ue000/src/index.ts":
    "export function two(n:number){return n*2;}\n",
  "packages/bad/package.json": "{ malformed",
  "packages/z/package.json": '{"name":"@fixture/z","source":"src/index.ts"}',
  "packages/z/src/index.ts": "export const z=3;\n",
};
export const projectOrderingCases = [
  {
    id: "visible-git-filtering",
    mode: "list",
    git: true,
    files: {
      ".gitignore": "ignored/\n",
      "src/kept.ts": good,
      "src/next.tsx": "export const x=<div/>;\n",
      "src/types.d.ts": "export declare const x:number;\n",
      "src/a.gen.ts": good,
      "ignored/hidden.ts": good,
      "node_modules/dep/index.ts": good,
      "README.md": "text\n",
    },
    tracked: ["src/kept.ts"],
    symlinks: { "source-link.ts": "src/kept.ts", "broken.ts": "missing.ts" },
  },
  {
    id: "visible-walk-prune",
    mode: "list",
    files: {
      "src/a.ts": good,
      "src/b.tsx": "export const b=<b/>;\n",
      "src/types.d.ts": "export {};\n",
      ".hidden.ts": good,
      "dist/not.ts": good,
      "coverage/hidden.ts": good,
      "node_modules/skip.ts": good,
      "vendor/skip.ts": good,
      "src/readme.md": "text\n",
    },
    symlinks: { "link.ts": "src/a.ts" },
  },
  {
    id: "visible-supplied-scope",
    mode: "scope",
    files: {
      "packages/a/z.ts": good,
      "packages/a/a.ts": good,
      "packages/b/b.ts": good,
      "root.ts": good,
    },
    listing: [
      "packages/b/b.ts",
      "packages/a/z.ts",
      "packages/a/a.ts",
      "packages/a/a.ts",
      "root.ts",
      "missing.ts",
    ],
    scopes: ["", "packages/a", "packages/b", "outside"],
  },
  {
    id: "visible-predicate-stat-order",
    mode: "predicate",
    files: {
      "z.ts": good,
      "a.ts": good,
      "notes.txt": "data\n",
      "dir/inside.ts": good,
    },
    listing: ["z.ts", "missing.ts", "notes.txt", "dir", "a.ts"],
    reject: ["missing.ts", "notes.txt"],
  },
  {
    id: "visible-scalar-numeric",
    mode: "list",
    files: Object.fromEntries(
      ["a2.ts", "a10.ts", "B.ts", "b.ts", "é.ts", "𐀀.ts", "\ue000.ts"].map(
        (file) => [file, good],
      ),
    ),
  },
  {
    id: "visible-equivalent-duplicates",
    mode: "visible",
    files: { "é.ts": bad, "a.ts": good },
    listing: ["é.ts", "e\u0301.ts", "é.ts", "a.ts"],
  },
  {
    id: "visible-empty",
    mode: "list",
    files: { "readme.md": "no source\n", "only.d.ts": "export {};\n" },
  },
  {
    id: "visible-singleton",
    mode: "list",
    files: {
      "only.ts": good,
      "z.json": "{}",
      "x.md": "text",
      "types.d.ts": "export {};\n",
    },
  },
  {
    id: "cheap-interleaved-failures",
    mode: "cheap",
    files: mixed,
    listing: ["Z.ts", "é.ts", "a2.ts", "m.ts", "e\u0301.ts", "a10.ts"],
  },
  {
    id: "cheap-equivalent-failure-duplicates",
    mode: "cheap",
    files: { "é.ts": bad, "good.ts": good },
    listing: ["é.ts", "good.ts", "e\u0301.ts", "é.ts"],
  },
  {
    id: "cheap-bom-unreadable",
    mode: "cheap",
    files: { "bom.ts": "\ufeff" + good, "bad.ts": bad, "locked.ts": good },
    modes: { "locked.ts": 0 },
  },
  {
    id: "edge-package-no-config",
    mode: "edge",
    files: { "src/a.ts": good },
    root: "src",
    scope: "package",
    expectError: "no tsconfig.json found",
  },
  {
    id: "edge-deep-scope-guard",
    mode: "edge-scope",
    files: { "packages/a/tsconfig.json": config, "packages/a/src/a.ts": good },
    root: "packages/a",
    scope: "deep",
  },
  {
    id: "edge-config-loaded",
    mode: "edge",
    files: {
      ...plain,
      "tsconfig.json": config,
      "packages/a/tsconfig.json": config,
      "packages/a/a.ts": good,
      "packages/a/z.ts": bad,
    },
    root: "packages/a",
    scope: "package",
  },
  {
    id: "package-roots-final-utf16",
    mode: "roots",
    files: { ...packages, "node_modules/ignored/package.json": "{}" },
    listing: [
      "packages/\ue000/package.json",
      "packages/𐀀/package.json",
      "packages/z/package.json",
      "packages/bad/package.json",
      "packages/𐀀/package.json",
      "node_modules/ignored/package.json",
    ],
  },
  {
    id: "package-workspace-first-wins",
    mode: "workspaces",
    files: packages,
    listing: [
      "packages/\ue000/package.json",
      "packages/𐀀/package.json",
      "packages/z/package.json",
      "packages/bad/package.json",
    ],
  },
  {
    id: "catalog-config-first-error",
    mode: "catalog",
    files: {
      "a10/wrangler.jsonc": '{"name":"first","vars":{"constructor":null}}',
      "a2/wrangler.jsonc": '{"name":"later","vars":{"x":"ok"}}',
      "z/wrangler.toml": 'name = "last"\n',
    },
    expectError: "Cannot read properties of null",
  },
  { id: "hexagon-layout-ports-lexical", mode: "hexagon", files: hexagon },
  {
    id: "cli-cheap-load-render",
    mode: "cli",
    files: { ...plain, ...mixed, "third.ts": good },
    actions: [
      { id: "graph", flags: ["--graph"] },
      {
        id: "plan-out",
        flags: ["--plan", "--by", "complexity", "--out", "plan.txt"],
        initial: 4,
      },
      { id: "file-bad", flags: ["--file", "a10.ts"] },
    ],
  },
  {
    id: "cli-edge-late-priority",
    mode: "cli",
    files: packages,
    actions: [
      { id: "edge-graph-wins", flags: ["--deep", "--graph", "--plan"] },
      {
        id: "edge-plan",
        flags: ["--deep", "--plan", "--by", "impact", "--json"],
      },
      {
        id: "missing-config",
        flags: ["--edges", "--plan"],
        remove: ["tsconfig.json"],
      },
    ],
  },
];
if (
  projectOrderingCases.length !== 20 ||
  new Set(projectOrderingCases.map(({ id }) => id)).size !== 20
)
  throw new Error("exact20 unique Source wholeviews");
