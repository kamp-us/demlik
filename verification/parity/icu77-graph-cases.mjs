const config = (name, extra = {}) => JSON.stringify({ name, ...extra });
const dataFiles = (source, extra = {}) => ({
  "wrangler.json": config("api", {
    d1_databases: [{ binding: "DB" }],
    kv_namespaces: [{ binding: "a" }, { binding: "Z" }],
    ...extra,
  }),
  "entry.ts": source,
});
export const fullWorkflowFiles = {
  "package.json": '{"private":true}',
  "packages/api/package.json": '{"name":"api"}',
  "packages/worker/package.json": '{"name":"worker"}',
  "packages/api/wrangler.json": config("api", {
    main: "main.ts",
    services: [{ binding: "SEARCH", service: "worker", entrypoint: "Search" }],
    d1_databases: [{ binding: "DB" }],
  }),
  "packages/worker/wrangler.json": config("worker", { main: "worker.ts" }),
  "packages/api/main.ts":
    'declare const env:any;export function main(){env.SEARCH.search();env.DB.prepare("SELECT 1");}\n',
  "packages/api/util.ts": "export function helper(){return 1}\n",
  "packages/worker/worker.ts": "export class Search{search(){return 1}}\n",
  "packages/worker/private.ts": "export function dead(){return 2}\n",
  "packages/worker/worker.test.ts":
    'import {helper} from "../api/util";export function test(){return helper()}\n',
};
const serviceFiles = {
  "package.json": '{"private":true}',
  "packages/a/wrangler.json": config("Zulu", {
    main: "entry.ts",
    services: [{ binding: "a", service: "worker", entrypoint: "Search" }],
  }),
  "packages/Z/wrangler.json": config("alpha", {
    main: "entry.ts",
    services: [{ binding: "Z", service: "worker", entrypoint: "Search" }],
  }),
  "packages/a/entry.ts":
    "declare const env:any;export function a(){env.a.search()}\n",
  "packages/Z/entry.ts":
    "declare const env:any;export function Z(){env.Z.search()}\n",
  "packages/d/wrangler.json": config("alpha", {
    services: [
      { binding: "Z", service: "worker", entrypoint: "A" },
      { binding: "\ud800", service: "worker", entrypoint: "Search" },
      { binding: "\ufffd", service: "worker", entrypoint: "Search" },
    ],
  }),
  "worker/wrangler.json": config("worker"),
  "worker/search.ts": "export class Search{search(){return 1}}\n",
};
export const cases = [
  { id: "graph-empty", mode: "graph", files: {} },
  {
    id: "graph-module-locale",
    mode: "graph",
    files: {
      "Z.ts": "export function Z(){}\n",
      "a.ts": "export function a(){}\n",
      "\ue000.ts": "export function privateUse(){}\n",
      "\u{10000}.ts": "export function astral(){}\n",
    },
  },
  {
    id: "graph-function-id-unicode",
    mode: "graph",
    files: {
      "one.ts":
        "export function Z(){}\nexport function a(){}\nexport function é(){}\nexport function é(){}\n",
    },
  },
  {
    id: "directory-original-membership",
    mode: "directories",
    files: {
      "z/Z.ts": "export function Z(){}\n",
      "z/a.ts": "export function a(){}\nexport function b(){}\n",
      "a/member.ts": "export function member(){}\n",
    },
    moduleOrder: ["z/Z.ts", "z/a.ts", "a/member.ts"],
  },
  {
    id: "directory-root-dot",
    mode: "directories",
    files: {
      "Z.ts": "export function Z(){}\n",
      "a.ts": "export function a(){}\n",
    },
    moduleOrder: ["Z.ts", "a.ts"],
  },
  {
    id: "inputs-nonlexical-map",
    mode: "inputs",
    files: {
      "z.ts": "export function z(){}\n",
      "a.ts": "export function a(){}\n",
      "m.ts": "function hidden(){}\n",
    },
    symbolOrder: ["z.ts:z", "a.ts:a", "m.ts:hidden"],
  },
  {
    id: "inputs-duplicates-and-unexported",
    mode: "inputs",
    files: { "one.ts": "export function dup(){}\nfunction hidden(){}\n" },
    repeatFirst: true,
  },
  {
    id: "inputs-stable-normalization-ties",
    mode: "inputs",
    files: {
      "one.ts":
        "export function é(){}\nexport function é(){}\nexport function a10(){}\nexport function a2(){}\n",
    },
    reverseSymbols: true,
  },
  {
    id: "data-holder-locale",
    mode: "data",
    files: dataFiles(
      'export function Z(env:any){env.DB.prepare("SELECT 1")}\nexport function a(env:any){env.DB.prepare("SELECT 2")}\n',
    ),
  },
  {
    id: "data-line-column-before-binding",
    mode: "data",
    files: dataFiles(
      'export function work(env:any){\n env.Z.get("k");env.a.put("k","v");\n env.a.get("k");\n}\n',
    ),
  },
  {
    id: "data-top-level-and-held",
    mode: "data",
    files: dataFiles(
      'declare const env:any;env.DB.prepare("SELECT 1");\nexport function held(){env.DB.exec("DELETE FROM t")}\n',
    ),
  },
  {
    id: "data-alias-shadow-duplicates",
    mode: "data",
    files: dataFiles(
      'export function held(env:any){const db=env.DB;db.prepare("SELECT 1");{const db={prepare(){}};db.prepare()}db.exec("DELETE FROM t")}\n',
    ),
    duplicateUnits: true,
  },
  {
    id: "data-raw-binding-method",
    mode: "data",
    files: {
      "wrangler.json": String.raw`{"name":"\udfff","d1_databases":[{"binding":"\ud800"}],"kv_namespaces":[{"binding":""}]}`,
      "entry.ts":
        'export function raw(env:any){env["\\ud800"]["\\udfff"]("SELECT 1");env[""].get("k")}\n',
    },
  },
  {
    id: "data-catalog-refusal",
    mode: "data",
    files: {
      "wrangler.json": '{"vars":{"constructor":null}}',
      "entry.ts": 'export function data(env:any){env.DB.prepare("SELECT 1")}\n',
    },
  },
  {
    id: "cross-census-service-before-binding",
    mode: "workflow",
    files: serviceFiles,
    analysis: { crossRuntime: true },
  },
  {
    id: "cross-same-line-binding-order",
    mode: "workflow",
    files: {
      "api/wrangler.json": config("api", {
        services: [
          { binding: "Z", service: "worker", entrypoint: "Search" },
          { binding: "a", service: "worker", entrypoint: "Search" },
        ],
      }),
      "api/entry.ts":
        "declare const env:any;export function entry(){env.Z.search();env.a.search()}\n",
      "worker/wrangler.json": config("worker"),
      "worker/search.ts": "export class Search{search(){return 1}}\n",
    },
    analysis: { crossRuntime: true },
  },
  {
    id: "cross-ambiguous-unloaded-and-workflow",
    mode: "workflow",
    files: {
      "api/wrangler.json": config("api", {
        services: [
          { binding: "S", service: "worker", entrypoint: "Search" },
          { binding: "MISSING", service: "absent" },
          { binding: "UNLOADED", service: "worker", entrypoint: "Missing" },
        ],
        durable_objects: {
          bindings: [
            { name: "DO", class_name: "Counter", script_name: "worker" },
          ],
        },
        workflows: [
          { binding: "FLOW", class_name: "Flow", script_name: "worker" },
        ],
      }),
      "api/entry.ts":
        "declare const env:any;export function entry(){env.S.search();env.MISSING.fetch();env.UNLOADED.get();env.DO.fetch();env.FLOW.create({})}\n",
      "worker/wrangler.json": config("worker"),
      "worker/a.ts":
        "export class Search{search(){}}\nexport class Counter{fetch(){}}\nexport class Flow{run(){}}\n",
      "worker/Z.ts": "export class Search{search(){}}\n",
    },
    analysis: { crossRuntime: true },
  },
  {
    id: "two-package-full-graph",
    mode: "workflow",
    files: fullWorkflowFiles,
    analysis: {
      crossRuntime: true,
      kinds: true,
      reach: true,
      clusters: true,
      interfaceWidth: true,
    },
    data: true,
  },
];
export function filesFor(item) {
  return item.mode === "workflow"
    ? {
        ...item.files,
        "tsconfig.json": JSON.stringify({
          compilerOptions: {
            strict: true,
            target: "es2022",
            module: "esnext",
            moduleResolution: "bundler",
            types: [],
          },
          include: ["**/*.ts"],
        }),
      }
    : item.files;
}
