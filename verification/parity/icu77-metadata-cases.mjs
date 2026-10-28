export const common = {
  "tsconfig.json": JSON.stringify({
    compilerOptions: {
      strict: true,
      types: [],
      target: "es2022",
      module: "esnext",
      moduleResolution: "bundler",
    },
    include: ["**/*.ts"],
  }),
  "a.ts":
    "export interface Shape { value: number }\nexport const TOKEN = 1;\nexport function read(){return TOKEN;}\n",
  "b.ts":
    "import {TOKEN, type Shape} from './a';\nexport const holder: Shape={value:TOKEN};\n",
  "c.ts": "export {TOKEN as alias} from './a';\nimport('./a');\n",
};
const group = (keys) => Object.fromEntries(keys.map((key) => [key, ["^x$"]]));
export const cases = [
  {
    id: "import-raw-versus-replacement",
    operation: "snapshot",
    files: {
      "b.ts":
        "import '\\ud800';\nimport '\\ufffd';\nimport '\\udc00';\nimport 'a';\nimport 'é';\nimport 'é';\n",
    },
  },
  {
    id: "import-kind-type-fold",
    operation: "snapshot",
    files: {
      "b.ts":
        "import type {Shape} from './a';\nimport {type Shape as Other, TOKEN} from './a';\nexport {TOKEN} from './a';\nconst lazy=import('./a');\ntype Hidden=typeof import('./a');\n",
    },
  },
  {
    id: "reverse-importers-and-dedup",
    operation: "snapshot",
    files: {
      "Z.ts": "import './a';import './a';\n",
      "z.ts": "import './a';\n",
      "A.ts": "export {TOKEN} from './a';\n",
    },
  },
  {
    id: "declaration-lines-before-kind",
    operation: "snapshot",
    files: {
      "a.ts":
        "export const TOKEN=1;\n\n\n\n\n\n\n\n\nexport interface Shape{value:number}\n",
    },
  },
  {
    id: "declaration-kind-id-and-merge",
    operation: "snapshot",
    files: {
      "a.ts":
        "export interface Shape{left:number};export interface Shape{right:string};export class Zoo{};export type Alpha=number;export const TOKEN=1;\n",
    },
  },
  {
    id: "declaration-canonical-stable",
    operation: "snapshot",
    files: {
      "a.ts":
        "export interface é {left:number};export interface é {right:number};export interface Shape{value:number};export const TOKEN=1;\n",
    },
  },
  {
    id: "declaration-uses-alias-shorthand",
    operation: "snapshot",
    go: true,
    files: {
      "b.ts":
        "import {TOKEN as alias, type Shape} from './a';\nexport const holder:Shape={value:alias};\nconst local={alias};\n",
      "z.ts": "import {TOKEN} from './a';\nTOKEN;\n\n\n\n\n\n\n\nTOKEN;\n",
    },
  },
  {
    id: "declaration-uses-merged-reexports",
    operation: "snapshot",
    go: true,
    files: {
      "a.ts":
        "export interface Shape{left:number}\nexport interface Shape{right:number}\nexport const TOKEN=1;\n",
      "b.ts":
        "import type {Shape as Alias} from './a';\nexport let value:Alias;\n",
      "c.ts": "export type {Shape} from './a';\n",
    },
  },
  {
    id: "rule-raw-keys",
    operation: "rules",
    group: group(["\ud800", "�", "\udc00", "é", "é", "Z", "a"]),
  },
  {
    id: "rule-numeric-and-prototype-keys",
    operation: "rules",
    group: group(["2", "10", "02", "__proto__", "constructor", "A", "a"]),
  },
  {
    id: "rule-regex-error-retained",
    operation: "rules",
    group: { alpha: ["["] },
  },
  {
    id: "export-names-raw-and-canonical",
    operation: "snapshot",
    files: {
      "a.ts":
        "export function read(){return 1}; export {read as '\\ud800',read as '\\ufffd',read as '\\udc00',read as 'é',read as 'é',read as again};\nexport interface Shape{value:number};export const TOKEN=1;\n",
    },
  },
  {
    id: "export-default-alias-dedup",
    operation: "snapshot",
    files: {
      "a.ts":
        "function local(){return 1};export {local as Z,local as a,local as Z};export default local;\nexport interface Shape{value:number};export const TOKEN=1;\n",
    },
  },
  {
    id: "package-first-existing",
    operation: "entry",
    dirs: ["packages/a", "missing"],
    files: {
      "packages/a/package.json": JSON.stringify({
        name: "a",
        main: "./dist/Z.ts",
        types: "./dist/a.d.ts",
        exports: ["./dist/missing.js", "./dist/alpha.js"],
      }),
      "packages/a/src/Z.ts": "export {};",
      "packages/a/src/a.ts": "export {};",
      "packages/a/src/alpha.ts": "export {};",
    },
  },
  {
    id: "package-raw-return-spelling",
    operation: "entry",
    dirs: ["packages/a"],
    files: {
      "packages/a/package.json": JSON.stringify({
        name: "a",
        exports: ["./dist/�.js", "./dist/\ud800.js"],
      }),
      "packages/a/src/�.ts": "export {};",
    },
  },
  {
    id: "package-prototype-target-and-missing",
    operation: "entry",
    dirs: ["packages/a", "packages/b"],
    files: {
      "packages/a/package.json":
        '{"name":"a","__proto__":{"exports":["./dist/Z.js","./dist/a.js"]}}',
      "packages/a/src/Z.ts": "export {};",
      "packages/a/src/a.ts": "export {};",
      "packages/b/package.json": "{broken",
    },
  },
  {
    id: "catalog-binding-tuple-and-kinds",
    operation: "catalog",
    files: {
      "packages/a/wrangler.json": JSON.stringify({
        name: "a",
        main: "src/main.ts",
        services: [
          { binding: "same", service: "Z", entrypoint: "x" },
          { binding: "same", service: "a", entrypoint: "Z" },
          { binding: "same", service: "a", entrypoint: "a" },
        ],
        durable_objects: {
          bindings: [{ name: "same", class_name: "Durable" }],
        },
        kv_namespaces: [{ binding: "same" }],
        r2_buckets: [{ binding: "same" }],
        d1_databases: [{ binding: "same" }],
        queues: { producers: [{ binding: "same" }] },
      }),
    },
  },
  {
    id: "catalog-raw-unique-keys",
    operation: "catalog",
    files: {
      "packages/a/wrangler.json": JSON.stringify({
        name: "a",
        vars: Object.fromEntries(
          ["\ud800", "�", "\udc00", "é", "é", "2", "10"].map((key) => [
            key,
            "x",
          ]),
        ),
        secrets: { required: ["é", "Z", "a"] },
        services: [
          { binding: "\ud800", service: "�" },
          { binding: "�", service: "\ud800" },
        ],
      }),
      "packages/a/.dev.vars": "Z=1\na=2\nZ=3\n",
      "packages/a/.dev.vars.example": "b=2\n",
    },
  },
  {
    id: "catalog-manifest-and-unparsed-order",
    operation: "catalog",
    files: {
      "z/wrangler.json": '{"name":"z"}',
      "A/wrangler.json": '{"name":"a"}',
      "a/wrangler.json": '{"name":"Z"}',
      "bad-Z/wrangler.json": "[",
      "bad-a/wrangler.json": '{"main":7}',
    },
  },
  {
    id: "catalog-jsonc-toml-and-devvars",
    operation: "catalog",
    files: {
      "a/wrangler.jsonc":
        '{// retained grammar\n"name":"a","vars":{"b":1,"A":2},}',
      "b/wrangler.toml": 'name="b"\n[vars]\nb=1\nA=2\n',
      "b/.dev.vars.example": "#comment\nA=1\n",
      "b/.dev.vars": "b=2\n",
    },
  },
  {
    id: "catalog-record-error-before-ordering",
    operation: "catalog",
    files: { "a/wrangler.json": '{"name":"a","vars":{"constructor":null}}' },
  },
  { id: "preset-empty", operation: "presets", names: [], filePresets: [] },
  {
    id: "preset-one-deduplicated",
    operation: "presets",
    names: ["nextjs", "nextjs"],
    filePresets: ["nextjs", "nextjs"],
  },
  {
    id: "preset-unknown-raw-refusal",
    operation: "presets",
    names: ["\ud800"],
    filePresets: ["nextjs"],
  },
];
